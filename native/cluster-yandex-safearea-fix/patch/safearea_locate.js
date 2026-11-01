// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 waze-cluster-safearea contributors
// Derived from carplay_locate.js (Copyright (C) 2026 Robert Nisipeanu),
// part of waze-on-cluster, GPL-3.0-or-later.
/* safearea_locate.js — finds the IC_HIGH geometry builder's safe-area
 * immediates in a carplay build, so this tool can set the instrument-cluster
 * safe area (where the phone keeps its guidance banner) on top of
 * waze-on-cluster's resolution patch. It only reads the buffer. The geometry
 * builder is found by structure (the ICSafeAreaProvider constructor and its
 * IC_HIGH branch), the same way waze-on-cluster's carplay_locate.js finds it.
 *
 * Node 8 on the unit, no dependencies.
 */
'use strict';

function u64(buf, off) { return buf.readUInt32LE(off + 4) === 0 ? buf.readUInt32LE(off) >>> 0 : null; }

function parseElf(buf) {
    if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return { reason: 'not an ELF file' };
    if (buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) return { reason: 'not a 64-bit little-endian x86-64 ELF' };
    var phoff = u64(buf, 0x20), phentsize = buf.readUInt16LE(0x36), phnum = buf.readUInt16LE(0x38);
    if (phoff === null || phoff + phnum * phentsize > buf.length) return { reason: 'ELF program headers out of range' };
    var elf = { load: [], exec: null, eh: null, notes: [] };
    for (var i = 0; i < phnum; i++) {
        var o = phoff + i * phentsize, type = buf.readUInt32LE(o);
        var seg = { off: u64(buf, o + 8), va: u64(buf, o + 16), size: u64(buf, o + 32) };
        if (seg.off === null || seg.va === null || seg.size === null || seg.off + seg.size > buf.length) continue;
        if (type === 1) {
            elf.load.push(seg);
            if ((buf.readUInt32LE(o + 4) & 1) && !elf.exec) elf.exec = { off: seg.off, end: seg.off + seg.size };
        } else if (type === 0x6474e550) elf.eh = seg;
        else if (type === 4) elf.notes.push(seg);
    }
    if (!elf.exec) return { reason: 'no executable ELF segment' };
    return elf;
}

function buildId(buf, notes) {
    for (var n = 0; n < notes.length; n++) {
        for (var o = notes[n].off, end = o + notes[n].size; o + 12 <= end;) {
            var namesz = buf.readUInt32LE(o), descsz = buf.readUInt32LE(o + 4);
            var desc = o + 12 + ((namesz + 3) & ~3);
            if (desc + descsz > end) break;
            if (buf.readUInt32LE(o + 8) === 3 && namesz === 4 && buf.toString('latin1', o + 12, o + 16) === 'GNU\0')
                return buf.toString('hex', desc, desc + descsz);
            o = desc + ((descsz + 3) & ~3);
        }
    }
    return null;
}

function Image(buf, elf) { this.buf = buf; this.load = elf.load; this.exec = elf.exec; this.starts = funcStarts(buf, elf.eh); }
Image.prototype.va = function (off) {
    for (var i = 0; i < this.load.length; i++) { var s = this.load[i]; if (off >= s.off && off < s.off + s.size) return s.va + (off - s.off); }
    return null;
};
Image.prototype.off = function (va) {
    for (var i = 0; i < this.load.length; i++) { var s = this.load[i]; if (va >= s.va && va < s.va + s.size) return s.off + (va - s.va); }
    return null;
};
Image.prototype.func = function (off) {
    var va = this.va(off), s = this.starts, lo = 0, hi = s.length - 1, at = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (s[mid] <= va) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0) return null;
    var start = this.off(s[at]);
    var end = at + 1 < s.length ? this.off(s[at + 1]) : this.exec.end;
    return start === null || end === null || end > this.exec.end ? null : { off: start, end: end };
};
Image.prototype.rel = function (pos, next) { var va = this.va(next); return va === null ? null : this.off((va + this.buf.readInt32LE(pos)) >>> 0); };
Image.prototype.calls = function (start, end) {
    var out = [];
    for (var p = start; p + 5 <= end; p++) if (this.buf[p] === 0xe8) { var to = this.rel(p + 1, p + 5); if (to !== null) out.push({ at: p, to: to }); }
    return out;
};

function funcStarts(buf, eh) {
    if (!eh || eh.size < 12 || buf.readUInt32BE(eh.off) !== 0x011b033b) return [];
    var count = buf.readUInt32LE(eh.off + 8), table = eh.off + 12;
    if (table + count * 8 > eh.off + eh.size) return [];
    var starts = [];
    for (var i = 0; i < count; i++) starts.push((eh.va + buf.readInt32LE(table + i * 8)) >>> 0);
    return starts.sort(function (a, b) { return a - b; });
}

function scan(buf, start, end, pat) {
    var out = [];
    for (var i = start; i + pat.length <= end; i++) {
        if (buf[i] !== pat[0]) continue;
        for (var j = 1; j < pat.length && (pat[j] === null || buf[i + j] === pat[j]); j++);
        if (j === pat.length) out.push(i);
    }
    return out;
}
function any(n) { var a = []; while (n--) a.push(null); return a; }

function namedString(buf, key, re, label) {
    var found = [], k = Buffer.from(key, 'latin1');
    for (var i = buf.indexOf(k); i >= 0; i = buf.indexOf(k, i + 1)) {
        var s = i;
        while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
        var end = buf.indexOf(0, s); var str = buf.toString('latin1', s, end < 0 ? buf.length : end);
        if (found.indexOf(s) < 0 && re.test(str)) found.push(s);
    }
    if (found.length === 1) return { off: found[0] };
    return { err: label + (found.length ? ' string found ' + found.length + ' times' : ' string not found') };
}

function leaRefs(im, offs) {
    var want = {}, out = {}, buf = im.buf;
    offs.forEach(function (o) { var va = im.va(o); if (va !== null) { want[va] = o; out[o] = []; } });
    for (var p = im.exec.off + 1; p + 6 <= im.exec.end; p++) {
        if (buf[p] !== 0x8d || (buf[p - 1] & 0xfb) !== 0x48 || (buf[p + 1] & 0xc7) !== 0x05) continue;
        var va = im.va(p + 6);
        var t = va === null ? null : want[(va + buf.readInt32LE(p + 2)) >>> 0];
        if (t !== undefined && t !== null) out[t].push(p - 1);
    }
    return out;
}

function funcOfString(im, refs, str, label) {
    if (str.err) return str;
    var sites = refs[str.off] || [];
    if (!sites.length) return { err: label + ' string not referenced' };
    var f = im.func(sites[0]);
    for (var i = 1; f && i < sites.length; i++) { var g = im.func(sites[i]); if (!g || g.off !== f.off) return { err: label + ' used by several functions' }; }
    return f || { err: label + ' outside the function table' };
}

/* The IC_HIGH geometry builder: mov [rdi+0x10],rdx (mm pair) ; movabs rax,px ;
 * mov [rdi+8],rax ; mov [rdi+0x18],rax ; movabs rax,safe1 ; mov [rdi+0x20],rax ;
 * movabs rax,safe2 ; mov [rdi+0x28],rax. */
var STORES = [0x48, 0x89, 0x57, 0x10, 0x48, 0xb8].concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x08, 0x48, 0x89, 0x47, 0x18, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x20, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x28]);
function builder(im, f) {
    var fn = im.func(f);
    if (!fn || fn.off !== f) return null;
    var st = scan(im.buf, f, fn.end, STORES);
    if (st.length !== 1) return null;
    var mm = scan(im.buf, f, st[0] - 8, [0x48, 0xba]);
    return mm.length === 1 ? { mm: mm[0] + 2, px: st[0] + 6, safe1: st[0] + 24, safe2: st[0] + 38 } : null;
}
function trueBranch(im, at, end) {
    var buf = im.buf, t = at + 5, j;
    while (t < Math.min(at + 13, end) && !(buf[t] === 0x84 && buf[t + 1] === 0xc0)) t++;
    if (buf[t] !== 0x84 || buf[t + 1] !== 0xc0) return null;
    j = t + 2;
    if (buf[j] === 0x74) return j + 2;
    if (buf[j] === 0x75) return j + 2 + buf.readInt8(j + 1);
    if (buf[j] === 0x0f && buf[j + 1] === 0x84) return j + 6;
    if (buf[j] === 0x0f && buf[j + 1] === 0x85) return im.rel(j + 2, j + 6);
    return null;
}
var CTOR = ['ICSafeAreaProvider::ICSafeAreaProvider(', /^[\w:]*ICSafeAreaProvider::ICSafeAreaProvider\(/, 'ICSafeAreaProvider'];
function locateRes(im, refs, str) {
    if (!im.starts.length) return { ok: false, reason: 'no function table' };
    var ctor = funcOfString(im, refs, str, CTOR[2]);
    if (ctor.err) return { ok: false, reason: ctor.err };
    var buf = im.buf, calls = im.calls(ctor.off, ctor.end), builders = {}, isHigh = [];
    calls.forEach(function (c) {
        if (builders[c.to] === undefined) builders[c.to] = builder(im, c.to);
        var fn = im.func(c.to);
        if (fn && fn.off === c.to && fn.end - fn.off <= 128 && (scan(buf, fn.off, fn.end, [0x8b, 0x07, 0x85, 0xc0, 0x0f, 0x94, 0xc0]).length ||
            scan(buf, fn.off, fn.end, [0x83, 0x3f, 0x00, 0x0f, 0x94, 0xc0]).length)) isHigh.push(c);
    });
    var found = Object.keys(builders).filter(function (k) { return builders[k]; });
    if (found.length !== 2) return { ok: false, reason: found.length + ' geometry builders (want 2)' };
    if (isHigh.length !== 1) return { ok: false, reason: 'IC_HIGH check ' + (isHigh.length ? 'called ' + isHigh.length + ' times' : 'not found') };
    var branch = trueBranch(im, isHigh[0].at, ctor.end);
    var high = calls.filter(function (c) { return branch !== null && c.at >= branch && c.at < branch + 16 && builders[c.to]; })[0];
    if (!high) return { ok: false, reason: 'IC_HIGH builder not found' };
    var b = builders[high.to];
    return { ok: true, builder: high.to, mm: b.mm, px: b.px, safe1: b.safe1, safe2: b.safe2 };
}

/* The geometry fields the IC_HIGH builder advertises. */
function readGeom(buf, res) {
    return {
        mmw: buf.readUInt32LE(res.mm), mmh: buf.readUInt32LE(res.mm + 4),
        w: buf.readUInt32LE(res.px), h: buf.readUInt32LE(res.px + 4),
        viewx: buf.readUInt16LE(res.safe1), viewy: buf.readUInt16LE(res.safe1 + 2), safew: buf.readUInt32LE(res.safe1 + 4),
        safeh: buf.readUInt32LE(res.safe2), safex: buf.readUInt16LE(res.safe2 + 4), safey: buf.readUInt16LE(res.safe2 + 6),
    };
}

function locate(buf) {
    var elf = parseElf(buf);
    if (!elf.load) return { elf: false, reason: elf.reason };
    var im = new Image(buf, elf);
    var str = namedString(buf, CTOR[0], CTOR[1], CTOR[2]);
    var refs = str.err ? {} : leaRefs(im, [str.off]);
    var res = locateRes(im, refs, str);
    var out = { elf: true, buildId: buildId(buf, elf.notes), res: res, ok: res.ok };
    if (!res.ok) out.reason = res.reason;
    else out.geom = readGeom(buf, res);
    return out;
}

module.exports = { locate: locate, readGeom: readGeom };
