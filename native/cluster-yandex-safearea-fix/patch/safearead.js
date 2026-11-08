#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 cluster-yandex-safearea-fix contributors
/* safearead.js — root entry points for cluster-yandex-safearea-fix. Wraps
 * safearea_patch.js with waze-on-cluster's care: the shared remount lock, /
 * read-write only for the write and read-only again after, the running binary
 * kept hard-linked. It NEVER stops, kills, restarts or reboots carplay; the
 * change takes effect at the next head-unit start.
 *
 * Unlike the early-start tool, the safe area lives in waze-on-cluster's own
 * resolution region, which waze-on-cluster resets to its default on every
 * Enable map / update. So this tool re-applies the Yandex Maps safe area once
 * after each boot (the reconcile service), as well as at install.
 *
 *   safearead.js activate     install/update hook: apply the safe area
 *   safearead.js deactivate   removal hook: restore waze-on-cluster's safe area
 *   safearead.js reconcile    boot service: re-apply if waze-on-cluster reset it
 *
 * The offset comes from safearea.local.conf (a `safe=WxH+X+Y` line) if present,
 * else the shipped safearea.conf, else the built-in Yandex default.
 * Node 8 on the unit, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var lock = require('./remount_lock.js');

var HERE = __dirname;
var PATCHER = path.join(HERE, 'safearea_patch.js');
var SHIPPED_CONF = path.join(HERE, 'safearea.conf');
var LOCAL_CONF = path.join(HERE, '..', 'safearea.local.conf');
var TARGET = process.env.WOC_CARPLAY || '/usr/bin/carplay';
var RUNNING = TARGET + '.woc-safearea-running';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var RUNDIR = process.env.WOC_RUNDIR || '/dev/shm/waze-on-cluster';
var PENDING = path.join(RUNDIR, 'safearea-pending');

function log(line) { process.stdout.write('[' + new Date().toISOString() + '] safearea: ' + line + '\n'); }
function confArg() { return fs.existsSync(LOCAL_CONF) ? LOCAL_CONF : SHIPPED_CONF; }

function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n'), opts = null;
        for (var i = 0; i < lines.length; i++) { var p = lines[i].split(' '); if (p[1] === '/') opts = p[3]; }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}
function remount(rw, cb) { cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: 15000 }, function (err) { cb(err); }); }
function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 0) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}
function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) {} }
function dropUnusedRunning() { if (fs.existsSync(RUNNING) && !lock.holds(RUNNING, TARGET)) unlinkQuiet(RUNNING); }

function runPatch(args, cb) {
    var got = lock.tryAcquire();
    if (!got) log('remount lock busy; proceeding');
    dropUnusedRunning();
    remount(true, function (mErr) {
        if (mErr) { finishRo(new Error('remount rw: ' + mErr.message), false, got, cb); return; }
        var linked = false;
        if (!fs.existsSync(RUNNING)) { try { fs.linkSync(TARGET, RUNNING); linked = true; } catch (e) { log('keeping the running carplay linked failed: ' + e.message); } }
        cp.execFile(process.execPath, [PATCHER].concat(args), { timeout: 60000 }, function (pErr, out, errOut) {
            ((out || '') + '').split('\n').forEach(function (l) { if (l.trim()) log(l.trim()); });
            if (errOut) (errOut + '').split('\n').forEach(function (l) { if (l.trim()) log('patcher: ' + l.trim()); });
            var text = (out || '') + '';
            var changed = !pErr && !/nothing to do|already set|nothing to revert/i.test(text);
            if (linked && !changed && !lock.holds(RUNNING, TARGET)) unlinkQuiet(RUNNING);
            finishRo(pErr || null, changed, got, cb);
        });
    });
}
function finishRo(err, changed, haveLock, cb) {
    remountRo(3, function (roErr) {
        if (roErr) log('WARNING: ' + roErr.message + ' — the next head-unit start mounts / read-only again');
        if (haveLock) lock.release();
        cb(err, changed);
    });
}
function ensureRunDir() { try { fs.mkdirSync(RUNDIR, 0o755); } catch (e) {} }
function writePending(action) { ensureRunDir(); try { fs.writeFileSync(PENDING, JSON.stringify({ action: action }) + '\n', { mode: 0o644 }); } catch (e) {} }
function finish(result, code) { process.stdout.write(JSON.stringify(result) + '\n'); process.exit(code); }

/* The install/update hook. It ALWAYS exits 0: a failure to write the offset
 * (map off, carplay not located, / not writable, the no-backup guard) is
 * logged and left for the next boot's reconcile, never failing the install —
 * which would make the Store roll the tool back to the version before it. */
function activate() {
    var result = {};
    unlinkQuiet(TARGET + '.woc-safearea-tmp');
    runPatch(['apply', '--yes', '--conf', confArg(), '--target', TARGET], function (err, changed) {
        if (err) result.status = 'not applied now (reconciled at the next boot): ' + err.message;
        else if (changed) { writePending('apply'); result.reboot = 'Yandex safe area written; takes effect at the next head-unit start'; result.status = 'safe area written'; }
        else result.status = 'already set';
        finish(result, 0);
    });
}
/* The removal hook. It always exits 0 so a removal is never refused: the
 * patcher's revert already does nothing (and succeeds) when there is no backup,
 * the backup is for a different carplay, or the safe area is already stock, and
 * writeInPlace is all-or-nothing, so a write that could not happen leaves the
 * binary unchanged. It clears this tool's leftover files from /usr/bin. */
function deactivate() {
    var result = {};
    runPatch(['revert', '--yes', '--drop-backup', '--target', TARGET], function (err, changed) {
        if (err) result.status = 'left as is (could not revert): ' + err.message;
        else if (changed) { writePending('revert'); result.reboot = 'safe area restored to waze-on-cluster default; takes effect at the next head-unit start'; result.status = 'safe area restored'; }
        else result.status = 'nothing to revert';
        unlinkQuiet(TARGET + '.woc-safearea-tmp');
        /* The running-link may be the inode a live carplay runs; let mgu-deploy
         * drop it once nothing runs it. The backup is already dropped by revert. */
        if (fs.existsSync(RUNNING)) result.removeWhenUnused = [RUNNING];
        finish(result, 0);
    });
}
/* Boot service: re-apply the Yandex safe area if waze-on-cluster reset it.
 * When the resolution patch is not active (map off) the patcher refuses; that
 * is not a failure, so reconcile still exits 0. */
function reconcile() {
    runPatch(['reconcile', '--yes', '--conf', confArg(), '--target', TARGET], function (err, changed) {
        if (err) log('reconcile: ' + err.message);
        else if (changed) { writePending('apply'); log('reconcile: re-applied; takes effect at the next head-unit start'); }
        else log('reconcile: nothing to do');
        dropUnusedRunning();
        process.exit(0);
    });
}

function main() {
    var cmd = process.argv[2];
    if (cmd === 'activate') activate();
    else if (cmd === 'deactivate') deactivate();
    else if (cmd === 'reconcile') reconcile();
    else { process.stderr.write('usage: safearead.js activate|deactivate|reconcile\n'); process.exit(2); }
}
main();
