'use strict';
// Synchronous routing core: loads the graph written by build/graph.cpp and answers
// shortest-path queries with a bidirectional contraction-hierarchy search.
// Used inside the worker thread (route-worker.js) and directly by tests.

const fs = require('fs');
const path = require('path');

const INF = 0xffffffff;
const SC = 0x80000000;
const CELL = 0.005;
const COLS = 72000;
const CLASSES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service',
  'track', 'road', 'path', 'footway', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'platform', 'pier',
  'corridor', 'busway', 'ferry'];
const F_FERRY = 1, F_ROUNDABOUT = 2;
const PROFILES = ['car', 'bike', 'foot'];
// OSRM turn penalties (car.lua: 7.5 s, bias 1.075, u-turn 20 s; bicycle.lua: 6 s, bias 1.4)
const TURN = { car: { p: 7.5, bias: 1.075, uturn: 20 }, bike: { p: 6, bias: 1.4, uturn: 20 }, foot: null };

function readTyped(file, Type) {
  const b = fs.readFileSync(file);
  if (b.byteOffset % Type.BYTES_PER_ELEMENT === 0) return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT);
  const c = new Uint8Array(b.byteLength);
  c.set(b);
  return new Type(c.buffer, 0, c.byteLength / Type.BYTES_PER_ELEMENT);
}

// ---------------------------------------------------------------- binary heap (key, value)
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  topKey() { return this.k[0]; }
  pop() {
    const k = this.k, v = this.v;
    const rv = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return rv;
  }
}

function hav(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, d = Math.PI / 180;
  const dp = (lat2 - lat1) * d, dl = (lon2 - lon1) * d;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearing(lon1, lat1, lon2, lat2) {
  const d = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * d) * Math.cos(lat2 * d);
  const x = Math.cos(lat1 * d) * Math.sin(lat2 * d) - Math.sin(lat1 * d) * Math.cos(lat2 * d) * Math.cos((lon2 - lon1) * d);
  return (Math.atan2(y, x) / d + 360) % 360;
}

class RouteEngine {
  constructor(dir, { profiles = PROFILES } = {}) {
    this.dir = dir;
    this.nodes = readTyped(path.join(dir, 'nodes.bin'), Int32Array);
    const eb = readTyped(path.join(dir, 'edges.bin'), Uint32Array);
    this.E = eb.length / 6;
    this.edgesU = eb;
    this.edgesF = new Float32Array(eb.buffer, eb.byteOffset, eb.length);
    this.geom = readTyped(path.join(dir, 'geom.bin'), Int32Array);
    const wb = readTyped(path.join(dir, 'ways.bin'), Uint32Array);
    this.wayName = new Uint32Array(wb.length / 2);
    this.wayCls = new Uint8Array(wb.length / 2);
    this.wayFlags = new Uint8Array(wb.length / 2);
    const w8 = new Uint8Array(wb.buffer, wb.byteOffset, wb.byteLength);
    for (let i = 0; i < wb.length / 2; i++) {
      this.wayName[i] = wb[2 * i];
      this.wayCls[i] = w8[8 * i + 4];
      this.wayFlags[i] = w8[8 * i + 5];
    }
    this.names = JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8'));
    const g = readTyped(path.join(dir, 'grid.bin'), Uint32Array);
    const nc = g[0], ne = g[1];
    this.gridKeys = g.subarray(2, 2 + nc);
    this.gridOff = g.subarray(2 + nc, 2 + nc + nc + 1);
    this.gridIds = g.subarray(3 + 2 * nc, 3 + 2 * nc + ne);
    this.profiles = {};
    for (const p of profiles) {
      if (!fs.existsSync(path.join(dir, p + '.ch.bin'))) continue;
      const ew = readTyped(path.join(dir, p + '.edgew.bin'), Uint32Array);
      const comp = readTyped(path.join(dir, p + '.comp.bin'), Uint8Array);
      const ch = readTyped(path.join(dir, p + '.ch.bin'), Uint32Array);
      const n = ch[0], mf = ch[1], mb = ch[2];
      let o = 3;
      const take = (len) => { const a = ch.subarray(o, o + len); o += len; return a; };
      const fo = take(n + 1), ft = take(mf), fw = take(mf), fp = take(mf);
      const bo = take(n + 1), bt = take(mb), bw = take(mb), bp = take(mb);
      this.profiles[p] = { ew, comp, fo, ft, fw, fp, bo, bt, bw, bp, n };
    }
  }

  edge(e) {
    const U = this.edgesU, o = 6 * e;
    return { u: U[o], v: U[o + 1], goff: U[o + 2], gn: U[o + 3], way: U[o + 4], len: this.edgesF[o + 5] };
  }
  // geometry of edge e as [lon, lat] list (forward direction)
  edgeCoords(e) {
    const U = this.edgesU, o = 6 * e, goff = U[o + 2], gn = U[o + 3], G = this.geom;
    const out = new Array(gn);
    for (let i = 0; i < gn; i++) out[i] = [G[2 * (goff + i)] / 1e7, G[2 * (goff + i) + 1] / 1e7];
    return out;
  }

  // ------------------------------------------------------------ snapping
  snap(lon, lat, profile, maxRadiusM = 3000) {
    const P = this.profiles[profile];
    const ew = P.ew, comp = P.comp;
    const kx = Math.cos(lat * Math.PI / 180);
    const r0 = Math.floor((lat + 90) / CELL), c0 = Math.floor((lon + 180) / CELL);
    let best = null, bestBig = null;
    const seen = new Set();
    const maxRing = Math.ceil(maxRadiusM / (CELL * 111000 * Math.max(kx, 0.2))) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const key = (r0 + dr) * COLS + (c0 + dc);
          const ci = this._cell(key);
          if (ci < 0) continue;
          for (let j = this.gridOff[ci]; j < this.gridOff[ci + 1]; j++) {
            const e = this.gridIds[j];
            if (seen.has(e)) continue;
            seen.add(e);
            if (ew[4 * e] === INF && ew[4 * e + 1] === INF) continue;
            const c = this._nearestOnEdge(e, lon, lat, kx);
            if (!best || c.dist < best.dist) best = c;
            if (comp[e] && (!bestBig || c.dist < bestBig.dist)) bestBig = c;
          }
        }
      }
      // stop when the ring is beyond the best distance found so far
      const ringDist = ring * CELL * 111000 * Math.min(1, kx);
      if (bestBig && ringDist > bestBig.dist + 50) break;
      if (best && !bestBig && ringDist > best.dist + 2000) break;
    }
    const c = bestBig && (!best || bestBig.dist < best.dist + 1000) ? bestBig : best;
    if (!c || c.dist > maxRadiusM) return null;
    return c;
  }
  _cell(key) {
    const K = this.gridKeys;
    let lo = 0, hi = K.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (K[m] < key) lo = m + 1; else if (K[m] > key) hi = m - 1; else return m;
    }
    return -1;
  }
  _nearestOnEdge(e, lon, lat, kx) {
    const U = this.edgesU, o = 6 * e, goff = U[o + 2], gn = U[o + 3], G = this.geom;
    let best = Infinity, bi = 0, bt = 0, bx = 0, by = 0;
    const px = lon * kx, py = lat;
    for (let i = 0; i + 1 < gn; i++) {
      const ax = G[2 * (goff + i)] / 1e7 * kx, ay = G[2 * (goff + i) + 1] / 1e7;
      const bxx = G[2 * (goff + i + 1)] / 1e7 * kx, byy = G[2 * (goff + i + 1) + 1] / 1e7;
      const dx = bxx - ax, dy = byy - ay, L = dx * dx + dy * dy;
      let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = (qx - px) ** 2 + (qy - py) ** 2;
      if (d < best) { best = d; bi = i; bt = t; bx = qx / kx; by = qy; }
    }
    // fraction along the edge by length
    let total = 0, upto = 0;
    for (let i = 0; i + 1 < gn; i++) {
      const l = hav(G[2 * (goff + i)] / 1e7, G[2 * (goff + i) + 1] / 1e7, G[2 * (goff + i + 1)] / 1e7, G[2 * (goff + i + 1) + 1] / 1e7);
      if (i < bi) upto += l;
      else if (i === bi) upto += l * bt;
      total += l;
    }
    return { edge: e, seg: bi, t: bt, frac: total > 0 ? upto / total : 0, lon: bx, lat: by, dist: hav(lon, lat, bx, by) };
  }

  // ------------------------------------------------------------ CH query
  _search(P, src, dst) {
    const ew = P.ew;
    const es = src.edge, et = dst.edge;
    const Us = this.edgesU;
    const su = Us[6 * es], sv = Us[6 * es + 1], tu = Us[6 * et], tv = Us[6 * et + 1];
    const df = new Map(), db = new Map(); // node -> [dist, parentNode, arcPayload, arcFrom]
    const hf = new Heap(), hb = new Heap();
    const init = (map, heap, node, d, tag) => {
      const cur = map.get(node);
      if (!cur || d < cur[0]) { map.set(node, [d, -1, tag, -1]); heap.push(d, node); }
    };
    // forward: from the source point to the edge ends
    if (ew[4 * es + 2] !== INF) init(df, hf, sv, (1 - src.frac) * ew[4 * es + 2], 'sf');
    if (ew[4 * es + 3] !== INF) init(df, hf, su, src.frac * ew[4 * es + 3], 'sb');
    // backward: from the edge ends to the target point
    if (ew[4 * et + 2] !== INF) init(db, hb, tu, dst.frac * ew[4 * et + 2], 'tf');
    if (ew[4 * et + 3] !== INF) init(db, hb, tv, (1 - dst.frac) * ew[4 * et + 3], 'tb');
    let best = Infinity, meet = -1, direct = null;
    if (es === et) {
      if (ew[4 * es + 2] !== INF && dst.frac >= src.frac) { best = (dst.frac - src.frac) * ew[4 * es + 2]; direct = 0; }
      if (ew[4 * es + 3] !== INF && dst.frac <= src.frac) {
        const c = (src.frac - dst.frac) * ew[4 * es + 3];
        if (c < best) { best = c; direct = 1; }
      }
    }
    const settledF = new Set(), settledB = new Set();
    let settled = 0;
    while (hf.size || hb.size) {
      const kf = hf.size ? hf.topKey() : Infinity, kb = hb.size ? hb.topKey() : Infinity;
      if (Math.min(kf, kb) >= best) break;
      const fwd = kf <= kb;
      const heap = fwd ? hf : hb, map = fwd ? df : db, other = fwd ? db : df, sset = fwd ? settledF : settledB;
      const v = heap.pop();
      if (sset.has(v)) continue;
      sset.add(v);
      settled++;
      const dv = map.get(v)[0];
      const o = other.get(v);
      if (o && dv + o[0] < best) { best = dv + o[0]; meet = v; direct = null; }
      const off = fwd ? P.fo : P.bo, tg = fwd ? P.ft : P.bt, wt = fwd ? P.fw : P.bw, py = fwd ? P.fp : P.bp;
      // stall-on-demand
      let stalled = false;
      const offo = fwd ? P.bo : P.fo, tgo = fwd ? P.bt : P.ft, wto = fwd ? P.bw : P.fw;
      for (let j = offo[v]; j < offo[v + 1]; j++) {
        const x = map.get(tgo[j]);
        if (x && x[0] + wto[j] < dv) { stalled = true; break; }
      }
      if (stalled) continue;
      for (let j = off[v]; j < off[v + 1]; j++) {
        const x = tg[j], nd = dv + wt[j];
        const cur = map.get(x);
        if (!cur || nd < cur[0]) { map.set(x, [nd, v, py[j], j]); heap.push(nd, x); }
      }
    }
    return { best, meet, direct, df, db, settled };
  }

  // unpack a CH arc a->b (payload) into base edges [[edge, dir], ...]
  _unpack(P, a, b, pay, out) {
    const stack = [[a, b, pay]];
    while (stack.length) {
      const [x, y, p] = stack.pop();
      if (!(p & SC) && p < SC) {
        out.push([p >>> 1, p & 1]);
        continue;
      }
      const m = (p & 0x7fffffff) >>> 0;
      // arc x->m lives in m's backward list (source x), arc m->y in m's forward list (target y)
      let p1 = -1, w1 = Infinity, p2 = -1, w2 = Infinity;
      for (let j = P.bo[m]; j < P.bo[m + 1]; j++) if (P.bt[j] === x && P.bw[j] < w1) { w1 = P.bw[j]; p1 = P.bp[j]; }
      for (let j = P.fo[m]; j < P.fo[m + 1]; j++) if (P.ft[j] === y && P.fw[j] < w2) { w2 = P.fw[j]; p2 = P.fp[j]; }
      if (p1 < 0 || p2 < 0) throw new Error(`unpack failed ${x}->${m}->${y}`);
      stack.push([m, y, p2 >>> 0]);
      stack.push([x, m, p1 >>> 0]);
    }
  }

  route(from, to, profile = 'car', opts = {}) {
    const P = this.profiles[profile];
    if (!P) throw new Error('unknown profile ' + profile);
    const t0 = Date.now();
    const src = this.snap(from[0], from[1], profile);
    const dst = this.snap(to[0], to[1], profile);
    if (!src || !dst) return { code: 'NoSegment', message: `could not snap ${!src ? 'origin' : 'destination'} to the ${profile} network` };
    const r = this._search(P, src, dst);
    if (r.best === Infinity) return { code: 'NoRoute', message: 'no route found' };
    // assemble [edge, dir, fromFrac, toFrac]
    const segs = [];
    if (r.direct !== null) {
      segs.push([src.edge, r.direct, src.frac, dst.frac]);
    } else {
      const fwdArcs = [];
      let v = r.meet, x = r.df.get(v);
      while (x[1] >= 0) { fwdArcs.push([x[1], v, x[2]]); v = x[1]; x = r.df.get(v); }
      const startTag = x[2];
      fwdArcs.reverse();
      const bwdArcs = [];
      v = r.meet; x = r.db.get(v);
      while (x[1] >= 0) { bwdArcs.push([v, x[1], x[2]]); v = x[1]; x = r.db.get(v); }
      const endTag = x[2];
      const mid = [];
      for (const [a, b, p] of fwdArcs) this._unpack(P, a, b, p, mid);
      for (const [a, b, p] of bwdArcs) this._unpack(P, a, b, p, mid);
      if (startTag === 'sf') segs.push([src.edge, 0, src.frac, 1]);
      else segs.push([src.edge, 1, src.frac, 0]);
      for (const [e, d] of mid) segs.push([e, d, d ? 1 : 0, d ? 0 : 1]);
      if (endTag === 'tf') segs.push([dst.edge, 0, 0, dst.frac]);
      else segs.push([dst.edge, 1, 1, dst.frac]);
    }
    const res = this._assemble(segs, P, profile, src, dst, from, to);
    res.weight = r.best / 10;
    res.settled = r.settled;
    res.ms = Date.now() - t0;
    return res;
  }

  // slice of an edge's geometry between two length fractions, in travel order
  _slice(e, f0, f1) {
    const pts = this.edgeCoords(e);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const L = cum[cum.length - 1];
    const at = (f) => {
      const d = f * L;
      let i = 1;
      while (i < pts.length - 1 && cum[i] < d) i++;
      const seg = cum[i] - cum[i - 1];
      const t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
      return { i, p: [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])] };
    };
    const a = at(Math.min(f0, f1)), b = at(Math.max(f0, f1));
    const out = [a.p];
    for (let i = a.i; i < b.i; i++) out.push(pts[i]);
    out.push(b.p);
    if (f0 > f1) out.reverse();
    return out;
  }

  _assemble(segs, P, profile, src, dst, from, to) {
    const ew = P.ew;
    const legs = []; // per base-edge piece
    for (const [e, d, f0, f1] of segs) {
      const frac = Math.abs(f1 - f0);
      if (frac <= 0 && segs.length > 1) continue;
      const len = this.edgesF[6 * e + 5] * frac;
      const dur = (ew[4 * e + d] === INF ? 0 : ew[4 * e + d]) / 10 * frac;
      const way = this.edgesU[6 * e + 4];
      legs.push({ e, d, len, dur, way, coords: this._slice(e, f0, f1) });
    }
    // geometry
    const coords = [];
    for (const l of legs) {
      for (let i = 0; i < l.coords.length; i++) {
        const c = l.coords[i];
        const last = coords[coords.length - 1];
        if (last && Math.abs(last[0] - c[0]) < 1e-9 && Math.abs(last[1] - c[1]) < 1e-9) continue;
        coords.push([+c[0].toFixed(6), +c[1].toFixed(6)]);
      }
    }
    if (coords.length === 1) coords.push(coords[0]);
    // steps: group consecutive legs by name (+ref) and ferry / roundabout state
    const steps = [];
    const T = TURN[profile];
    let turnTotal = 0;
    const wayLabel = (w) => {
      const [nm, ref, cls] = this.names[this.wayName[w]];
      return { name: nm || '', ref: ref || '', cls, ferry: !!(this.wayFlags[w] & F_FERRY), round: !!(this.wayFlags[w] & F_ROUNDABOUT) };
    };
    const bear = (cs, atEnd) => {
      if (cs.length < 2) return 0;
      if (atEnd) {
        const a = cs[cs.length - 2], b = cs[cs.length - 1];
        return bearing(a[0], a[1], b[0], b[1]);
      }
      // look a few metres ahead to avoid tiny first segments
      return bearing(cs[0][0], cs[0][1], cs[1][0], cs[1][1]);
    };
    let cur = null;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const lab = wayLabel(l.way);
      const key = lab.name + '|' + lab.ref + '|' + lab.ferry + '|' + lab.round;
      if (cur && cur.key === key && !(lab.round && false)) {
        cur.distance += l.len; cur.duration += l.dur; cur.coords.push(...l.coords.slice(1));
        cur.endLeg = i;
        continue;
      }
      let maneuver;
      if (!cur) {
        maneuver = { type: 'depart', location: l.coords[0], bearing_before: 0, bearing_after: Math.round(bear(l.coords, false)) };
      } else {
        const bb = bear(legs[i - 1].coords, true), ba = bear(l.coords, false);
        maneuver = this._maneuver(bb, ba, cur.label, lab, l.coords[0]);
      }
      cur = { key, label: lab, distance: l.len, duration: l.dur, coords: l.coords.slice(), maneuver, endLeg: i };
      steps.push(cur);
    }
    // turn penalties (OSRM style), applied at every junction between legs
    if (T) {
      for (let i = 1; i < legs.length; i++) {
        const a = legs[i - 1], b = legs[i];
        const node = a.d ? this.edgesU[6 * a.e] : this.edgesU[6 * a.e + 1];
        if (!this._isJunction(node, P)) continue;
        const bb = bear(a.coords, true), ba = bear(b.coords, false);
        let ang = ((ba - bb + 540) % 360) - 180; // -180..180, + = right
        const uturn = Math.abs(ang) > 170 && a.e === b.e;
        let pen;
        if (ang >= 0) pen = T.p / (1 + Math.exp(-((13 / T.bias) * ang / 180 - 6.5 * T.bias)));
        else pen = T.p / (1 + Math.exp(-((13 * T.bias) * -ang / 180 - 6.5 / T.bias)));
        if (uturn) pen += T.uturn;
        turnTotal += pen;
        // attribute to the step containing leg b
        for (const s of steps) if (s.endLeg >= i) { s.duration += pen; break; }
      }
    }
    const last = legs[legs.length - 1];
    const lastPt = last.coords[last.coords.length - 1];
    const outSteps = steps.map((s) => ({
      name: s.label.name, ref: s.label.ref || undefined, mode: s.label.ferry ? 'ferry' : (profile === 'foot' ? 'walking' : profile === 'bike' ? 'cycling' : 'driving'),
      distance: Math.round(s.distance * 10) / 10, duration: Math.round(s.duration * 10) / 10,
      maneuver: s.maneuver, instruction: instruction(s.maneuver, s.label),
      geometry: s.coords.map((c) => [+c[0].toFixed(6), +c[1].toFixed(6)]),
    }));
    outSteps.push({
      name: '', distance: 0, duration: 0, mode: outSteps.length ? outSteps[outSteps.length - 1].mode : 'driving',
      maneuver: { type: 'arrive', location: lastPt, bearing_before: Math.round(bear(last.coords, true)), bearing_after: 0 },
      instruction: 'You have arrived at your destination', geometry: [lastPt, lastPt],
    });
    const distance = legs.reduce((s, l) => s + l.len, 0);
    const duration = legs.reduce((s, l) => s + l.dur, 0) + turnTotal;
    return {
      code: 'Ok', profile,
      distance: Math.round(distance * 10) / 10,
      duration: Math.round(duration * 10) / 10,
      geometry: { type: 'LineString', coordinates: coords },
      steps: outSteps,
      waypoints: [
        { location: [+src.lon.toFixed(6), +src.lat.toFixed(6)], distance: Math.round(src.dist * 10) / 10, name: wayLabel(this.edgesU[6 * src.edge + 4]).name },
        { location: [+dst.lon.toFixed(6), +dst.lat.toFixed(6)], distance: Math.round(dst.dist * 10) / 10, name: wayLabel(this.edgesU[6 * dst.edge + 4]).name },
      ],
      bbox: bboxOf(coords),
    };
  }

  _isJunction(node, P) {
    // degree > 2 in the profile's upward+downward graph is not cheap to get; use CH degree as a proxy:
    // nodes of degree <= 2 in the base graph are rare (only way boundaries), so count base arcs.
    if (!this._deg) this._buildDeg();
    return this._deg[node] > 2;
  }
  _buildDeg() {
    const deg = new Uint8Array(this.nodes.length / 2);
    for (let e = 0; e < this.E; e++) {
      const u = this.edgesU[6 * e], v = this.edgesU[6 * e + 1];
      if (deg[u] < 255) deg[u]++;
      if (deg[v] < 255) deg[v]++;
    }
    this._deg = deg;
  }

  _maneuver(bb, ba, prev, lab, loc) {
    let ang = ((ba - bb + 540) % 360) - 180;
    const a = Math.abs(ang);
    let modifier;
    if (a < 20) modifier = 'straight';
    else if (a < 60) modifier = ang > 0 ? 'slight right' : 'slight left';
    else if (a < 140) modifier = ang > 0 ? 'right' : 'left';
    else if (a < 170) modifier = ang > 0 ? 'sharp right' : 'sharp left';
    else modifier = 'uturn';
    let type = 'turn';
    if (lab.ferry && !prev.ferry) type = 'ferry';
    else if (!lab.ferry && prev.ferry) type = 'depart ferry';
    else if (lab.round && !prev.round) type = 'roundabout';
    else if (!lab.round && prev.round) type = 'exit roundabout';
    else if (/_link$/.test(lab.cls) && !/_link$/.test(prev.cls)) type = /^motorway|^trunk/.test(prev.cls) ? 'off ramp' : 'on ramp';
    else if (/_link$/.test(prev.cls) && /^motorway$|^trunk$/.test(lab.cls)) type = 'merge';
    else if (modifier === 'straight') type = lab.name && prev.name && lab.name !== prev.name ? 'new name' : 'continue';
    return { type, modifier, location: [+loc[0].toFixed(6), +loc[1].toFixed(6)], bearing_before: Math.round(bb), bearing_after: Math.round(ba) };
  }
}

function compass(b) {
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8];
}
function instruction(m, lab) {
  const road = lab.name || lab.ref || '';
  const onto = road ? ` onto ${road}` : '';
  switch (m.type) {
    case 'depart': return `Head ${compass(m.bearing_after)}${road ? ' on ' + road : ''}`;
    case 'ferry': return `Take the ferry${road ? ' ' + road : ''}`;
    case 'depart ferry': return `Leave the ferry${onto}`;
    case 'roundabout': return `Enter the roundabout${road ? ' (' + road + ')' : ''}`;
    case 'exit roundabout': return `Exit the roundabout${onto}`;
    case 'off ramp': return `Take the exit${m.modifier.includes('left') ? ' on the left' : ''}${lab.ref ? ' ' + lab.ref : ''}${lab.name ? ' toward ' + lab.name : ''}`;
    case 'on ramp': return `Take the ramp${m.modifier.includes('left') ? ' on the left' : m.modifier.includes('right') ? ' on the right' : ''}${road ? ' onto ' + road : ''}`;
    case 'merge': return `Merge${onto}`;
    case 'new name': return `Continue${onto}`;
    case 'continue': return `Continue straight${onto}`;
    default:
      if (m.modifier === 'uturn') return `Make a U-turn${onto}`;
      if (m.modifier === 'straight') return `Go straight${onto}`;
      return `Turn ${m.modifier}${onto}`;
  }
}
function bboxOf(coords) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of coords) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}

module.exports = { RouteEngine, PROFILES, hav, instruction };
