#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 cluster-yandex-safearea-fix contributors
/* safearea_patch.js — sets the instrument-cluster safe area (the rectangle
 * where the phone keeps its guidance UI, e.g. the next-turn banner) on top of
 * waze-on-cluster's resolution patch, for Yandex Maps.
 *
 * waze-on-cluster advertises the cluster map at 1088x480 and sets its own
 * default safe area (x=286). With Yandex Maps the banner then sits wrong; this
 * tool moves the safe area to 504x368+433+72, tuned for Yandex Maps. The safe
 * area is ONE rectangle for every CarPlay app, so this offset applies to all
 * of them: it is right for Yandex Maps and may misplace the banner on others
 * (Apple Maps, Google Maps, Waze).
 *
 * It writes only the two 8-byte safe-area immediates of the IC_HIGH geometry
 * builder (found structurally, not by fixed address) and keeps a backup of
 * exactly those bytes, so revert restores what waze-on-cluster had. The backup
 * is stamped with the carplay binary it came from (build-id + size); when a
 * firmware update replaces carplay, apply/reconcile take a fresh backup of the
 * new binary's original bytes (while our edit is not yet on it) and overwrite
 * the stale one, so revert always restores the current carplay's own bytes. It
 * edits the file by atomic rename, not the running process; the change takes
 * effect at the next head-unit start. It refuses unless waze-on-cluster's
 * resolution patch is active (mm size 138x61), so it never rewrites a stock
 * geometry.
 *
 *   safearea_patch.js status    [--target <file>]
 *   safearea_patch.js apply     [--safe WxH+X+Y] [--conf <file>] [--target <file>] [--yes]
 *   safearea_patch.js reconcile [--safe WxH+X+Y] [--conf <file>] [--target <file>] [--yes]
 *   safearea_patch.js revert    [--target <file>] [--yes] [--drop-backup]
 *   safearea_patch.js verify    [--safe WxH+X+Y] [--conf <file>] [--target <file>]
 *
 * Default target /usr/bin/carplay. Node 8 on the unit, no dependencies.
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var locator = require('./safearea_locate.js');

var PROVEN = { '5de62156575d737391ea42254e778a97dbbb51f8': 'carplay 22.28.3+gitr624+993efc1-r0.14' };

/* The safe area tuned for Yandex Maps, in the 1088x480 cluster frame. */
var SAFE_DEFAULT = { w: 504, h: 368, x: 433, y: 72 };
/* waze-on-cluster's resolution patch advertises this physical size; we only
 * touch the safe area when it is active, so we never rewrite a stock geometry. */
var WOC_MM = { w: 138, h: 61 };

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }
function backupPath(t) { return t + '.woc-safearea.json'; }

/* Which carplay binary a backup belongs to: its GNU build-id and size. A
 * waze-on-cluster update or Enable map rewrites the safe area but keeps the
 * same binary (same id), so the backup still holds the right original; a BMW
 * firmware update replaces carplay with a different binary (new id), and then
 * the old backup is stale. */
function binaryId(loc, buf) { return (loc.buildId || 'none') + ':' + buf.length; }
function sameBinary(bak, loc, buf) {
    if (bak.binaryId) return bak.binaryId === binaryId(loc, buf);
    return !!bak.buildId && bak.buildId === loc.buildId;   /* a backup from before this field: compare build-id only */
}

function parseSafe(s, where) {
    var m = /^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/.exec((s || '').trim());
    if (!m) die((where || '--safe') + ' needs WxH+X+Y (e.g. 504x368+433+72)');
    var g = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
    if (g.w < 16 || g.h < 16) die((where || '--safe') + ': at least 16x16');
    return g;
}

/* The wanted safe area: --safe wins, else the conf file's `safe=` line, else
 * the Yandex default. */
function wantedSafe(safeArg, confPath) {
    if (safeArg) return parseSafe(safeArg, '--safe');
    if (confPath) {
        var text = null;
        try { text = fs.readFileSync(confPath, 'utf8'); } catch (e) {}
        if (text) { var m = /^[ \t]*safe[ \t]*=[ \t]*(\S+)/m.exec(text); if (m) return parseSafe(m[1], confPath); }
    }
    return SAFE_DEFAULT;
}

/* safe1 = viewx(u16) viewy(u16) safew(u32); safe2 = safeh(u32) safex(u16)
 * safey(u16). The view offset is always (0,0). */
function safeBytes(g) {
    var b1 = Buffer.alloc(8); b1.writeUInt16LE(0, 0); b1.writeUInt16LE(0, 2); b1.writeUInt32LE(g.w, 4);
    var b2 = Buffer.alloc(8); b2.writeUInt32LE(g.h, 0); b2.writeUInt16LE(g.x, 4); b2.writeUInt16LE(g.y, 6);
    return { safe1: b1.toString('hex'), safe2: b2.toString('hex') };
}

function readTarget(t) { try { return fs.readFileSync(t); } catch (e) { die('cannot read ' + t + ': ' + e.message); } }
function pad(s) { return (s + ':           ').slice(0, 12); }
function line(name, text) { process.stdout.write(pad(name) + text + '\n'); }

function geomText(g) { return g.w + 'x' + g.h + '+' + g.x + '+' + g.y; }

/* The edits (the two safe-area immediates) and whether waze-on-cluster's
 * resolution patch is active. */
function plan(buf, loc, want) {
    var g = loc.geom;
    if (g.mmw !== WOC_MM.w || g.mmh !== WOC_MM.h)
        return { err: 'waze-on-cluster resolution patch not active (physical size ' + g.mmw + 'x' + g.mmh + 'mm, expected ' + WOC_MM.w + 'x' + WOC_MM.h + '); enable the map first' };
    if (want.x + want.w > g.w || want.y + want.h > g.h)
        return { err: 'safe area ' + geomText(want) + ' does not fit the ' + g.w + 'x' + g.h + ' frame' };
    var sb = safeBytes(want);
    var e = [
        { name: 'safe1', off: loc.res.safe1, len: 8, want: sb.safe1 },
        { name: 'safe2', off: loc.res.safe2, len: 8, want: sb.safe2 },
    ];
    e.forEach(function (x) { x.cur = buf.toString('hex', x.off, x.off + x.len); });
    return { edits: e };
}

function header(target, buf, loc) {
    line('target', target); line('size', buf.length); line('sha256', sha256(buf));
    line('build-id', loc.buildId || 'none');
    line('proven', PROVEN[loc.buildId] ? 'yes, ' + PROVEN[loc.buildId] : 'no');
}

function cmdStatus(target, safeArg, confPath) {
    var buf = readTarget(target), loc = locator.locate(buf);
    header(target, buf, loc);
    if (!loc.elf || !loc.ok) { line('located', 'NO — ' + (loc.reason || 'not an ELF')); return; }
    var g = loc.geom;
    line('map size', g.w + 'x' + g.h + ' at ' + g.mmw + 'x' + g.mmh + 'mm');
    line('safe area', geomText({ w: g.safew, h: g.safeh, x: g.safex, y: g.safey }));
    var want = wantedSafe(safeArg, confPath);
    line('wanted', geomText(want) + (g.safew === want.w && g.safeh === want.h && g.safex === want.x && g.safey === want.y ? ' — already set' : ''));
    line('backup', fs.existsSync(backupPath(target)) ? backupPath(target) : 'none');
}

/* Capture the current (original) safe-area bytes as the backup, stamped with
 * the binary they came from. Written to the one backup path, so a refresh
 * overwrites the previous backup rather than keeping it around. */
function writeBackup(target, loc, buf) {
    var regions = {
        safe1: { off: loc.res.safe1, hex: buf.toString('hex', loc.res.safe1, loc.res.safe1 + 8) },
        safe2: { off: loc.res.safe2, hex: buf.toString('hex', loc.res.safe2, loc.res.safe2 + 8) },
    };
    fs.writeFileSync(backupPath(target), JSON.stringify({ buildId: loc.buildId, binaryId: binaryId(loc, buf), savedAt: new Date().toISOString(), regions: regions }, null, 2) + '\n', { mode: 0o600 });
}
function readBackup(target) { try { return JSON.parse(fs.readFileSync(backupPath(target), 'utf8')); } catch (e) { return null; } }

function fsyncFile(p) { var fd = fs.openSync(p, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeInPlace(target, buf) {
    var tmp = target + '.woc-safearea-tmp', st;
    try { st = fs.statSync(target); } catch (e) { st = { mode: 0o755 }; }
    fs.writeFileSync(tmp, buf, { mode: st.mode & 0o777 });
    fsyncFile(tmp);
    try { fs.renameSync(tmp, target); }
    catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        var fd = fs.openSync(target, 'r+');
        try { fs.writeSync(fd, buf, 0, buf.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
}
function onlyRegionsDiffer(a, b, regions) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (!regions.some(function (r) { return i >= r.off && i < r.off + r.len; })) return false;
    }
    return true;
}

function doApply(target, want, yes, reconcile) {
    var buf = readTarget(target), loc = locator.locate(buf);
    if (!loc.elf || !loc.ok) die('refusing: ' + (loc.reason || 'not an ELF'));
    var p = plan(buf, loc, want);
    if (p.err) die('refusing: ' + p.err);

    /* Keep the backup matched to the current carplay. Take one on the first
     * run, and refresh it (replacing the old one) when carplay has been
     * replaced by a different binary since the backup was made — but only while
     * our edit is not yet on it, so what we capture is the real original, not
     * our own value. revert then restores whatever this carplay shipped with. */
    var bak = readBackup(target);
    var editApplied = p.edits.every(function (x) { return x.cur === x.want; });
    if (!bak) writeBackup(target, loc, buf);
    else if (!sameBinary(bak, loc, buf) && !editApplied) writeBackup(target, loc, buf);

    var out = Buffer.from(buf), changed = [];
    p.edits.forEach(function (x) { if (x.cur !== x.want) { Buffer.from(x.want, 'hex').copy(out, x.off); changed.push(x.name); } });
    if (!changed.length) { process.stdout.write(reconcile ? 'reconcile: already set\n' : 'nothing to do; already set\n'); return; }
    if (!onlyRegionsDiffer(buf, out, p.edits)) die('refusing: edit would change bytes outside the safe-area immediates');

    process.stdout.write((reconcile ? 'reconcile ' : 'apply ') + target + ': safe area -> ' + geomText(want) + '\n');
    if (!yes) die('pass --yes to proceed');
    writeInPlace(target, out);
    if (!readTarget(target).equals(out)) die('post-write verification failed; restore from ' + backupPath(target));
    process.stdout.write('ok. sha256 now ' + sha256(out) + '\n');
}

function cmdRevert(target, yes, dropBackup) {
    var bak = readBackup(target);
    if (!bak) die('no backup at ' + backupPath(target) + '; nothing to revert');
    var buf = readTarget(target), loc = locator.locate(buf);
    if (!loc.elf || !loc.ok) die('refusing: current ' + target + ' does not locate (' + (loc.reason || 'not an ELF') + ')');
    var out = Buffer.from(buf), regions = [], changed = false;
    Object.keys(bak.regions).forEach(function (name) {
        var r = bak.regions[name], b = Buffer.from(r.hex, 'hex');
        regions.push({ off: r.off, len: b.length });
        if (!out.slice(r.off, r.off + b.length).equals(b)) { b.copy(out, r.off); changed = true; }
    });
    function drop() { if (dropBackup) { try { fs.unlinkSync(backupPath(target)); process.stdout.write('backup dropped\n'); } catch (e) {} } }
    if (!changed) { process.stdout.write('already reverted; the safe area is as backed up\n'); drop(); return; }
    if (!onlyRegionsDiffer(out, buf, regions)) die('refusing: restore would change bytes outside the safe-area immediates');
    process.stdout.write('revert ' + target + ' from ' + backupPath(target) + '\n');
    if (!yes) die('pass --yes to proceed');
    writeInPlace(target, out);
    if (!readTarget(target).equals(out)) die('post-write verification failed');
    process.stdout.write('ok. sha256 now ' + sha256(out) + '\n');
    drop();
}

function cmdVerify(target, want) {
    var buf = readTarget(target), loc = locator.locate(buf);
    if (!loc.elf || !loc.ok) { process.stderr.write('FAIL: ' + (loc.reason || 'not an ELF') + '\n'); process.exit(1); }
    var g = loc.geom;
    if (g.safew === want.w && g.safeh === want.h && g.safex === want.x && g.safey === want.y) { process.stdout.write('OK: safe area ' + geomText(want) + '\n'); return; }
    process.stderr.write('FAIL: safe area is ' + geomText({ w: g.safew, h: g.safeh, x: g.safex, y: g.safey }) + ', wanted ' + geomText(want) + '\n');
    process.exit(1);
}

function parseArgs(argv) {
    var a = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var t = argv[i];
        if (t === '--yes') a.yes = true;
        else if (t === '--drop-backup') a.dropBackup = true;
        else if (t === '--target') a.target = argv[++i];
        else if (t === '--safe') a.safe = argv[++i];
        else if (t === '--conf') a.conf = argv[++i];
        else a._.push(t);
    }
    return a;
}

function main() {
    var a = parseArgs(process.argv.slice(2)), cmd = a._[0], target = a.target || '/usr/bin/carplay';
    var want = wantedSafe(a.safe, a.conf);
    if (cmd === 'status') cmdStatus(target, a.safe, a.conf);
    else if (cmd === 'apply') doApply(target, want, a.yes, false);
    else if (cmd === 'reconcile') doApply(target, want, a.yes, true);
    else if (cmd === 'revert') cmdRevert(target, a.yes, a.dropBackup);
    else if (cmd === 'verify') cmdVerify(target, want);
    else { process.stderr.write('usage: safearea_patch.js status|apply|reconcile|revert|verify [--safe WxH+X+Y] [--conf <file>] [--target <file>] [--yes] [--drop-backup]\n'); process.exit(2); }
}

main();
