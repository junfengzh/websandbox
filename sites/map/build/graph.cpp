// Routing graph + contraction hierarchy builder for websandbox map.
//
//   g++ -O3 -march=native -std=c++17 -o graph graph.cpp
//   ./graph WORK/route OUT/route
//
// Reads the arrays written by route_extract.py and writes (little endian):
//   nodes.bin          int32 lon*1e7, lat*1e7 per graph node
//   edges.bin          per base edge: uint32 u, v, geom_off, geom_n, way; float32 length_m
//   geom.bin           int32 lon,lat pairs (simplified edge geometry incl. endpoints)
//   ways.bin           per way: uint32 name_id, uint8 class, uint8 flags, uint16 pad
//   names.json         copied
//   grid.bin           header {uint32 ncells, nentries}, uint32 cell keys[ncells], uint32 off[ncells+1],
//                      uint32 edge ids[nentries]  (cell = 0.005 deg)
//   <p>.edgew.bin      per base edge: uint32 dur_fwd, dur_bwd, w_fwd, w_bwd  (deciseconds, 0xFFFFFFFF = none)
//   <p>.comp.bin       uint8 per base edge: 1 if the edge belongs to a large component for profile p
//   <p>.ch.bin         header {uint32 n, m_fwd, m_bwd}, fwd: uint32 off[n+1], to[m], w[m], pay[m];
//                      bwd: same. pay: bit31 set -> shortcut via node (pay & 0x7fffffff),
//                      else base edge id * 2 + dir (dir 1 = traversed v->u)
// Profiles: car, bike, foot.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <tuple>
#include <iostream>
#include <numeric>
#include <queue>
#include <string>
#include <vector>

using namespace std;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int64_t i64;
static const u32 INF = 0xFFFFFFFFu;

#pragma pack(push, 1)
struct WayIn { int32_t cf, cb, bf, bb, fs, flags, name; float dur; int32_t cls, rate; };
struct EdgeOut { u32 u, v, goff, gn, way; float len; };
struct WayOut { u32 name; uint8_t cls, flags; uint16_t pad; };
#pragma pack(pop)

static double now() { return chrono::duration<double>(chrono::steady_clock::now().time_since_epoch()).count(); }

template <class T> vector<T> readv(const string &p) {
  ifstream f(p, ios::binary | ios::ate);
  if (!f) { cerr << "cannot read " << p << "\n"; exit(1); }
  size_t n = f.tellg();
  vector<T> v(n / sizeof(T));
  f.seekg(0);
  f.read((char *)v.data(), n);
  return v;
}
template <class T> void writev(ofstream &f, const vector<T> &v) { f.write((const char *)v.data(), v.size() * sizeof(T)); }
template <class T> void writef(const string &p, const vector<T> &v) { ofstream f(p, ios::binary); writev(f, v); }

static double hav(int32_t lon1, int32_t lat1, int32_t lon2, int32_t lat2) {
  const double R = 6371008.8, d = M_PI / 180.0 / 1e7;
  double p1 = lat1 * d, p2 = lat2 * d, dp = (lat2 - lat1) * d, dl = (lon2 - lon1) * d;
  double a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2);
  return 2 * R * asin(min(1.0, sqrt(a)));
}

// Douglas-Peucker on E7 coords, tolerance in metres (planar approx).
static void dp(const vector<pair<int32_t, int32_t>> &pts, size_t a, size_t b, double tol2, double kx, vector<char> &keep) {
  if (b <= a + 1) return;
  double ax = pts[a].first * kx, ay = pts[a].second, bx = pts[b].first * kx, by = pts[b].second;
  double dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, best = -1; size_t bi = a;
  for (size_t i = a + 1; i < b; i++) {
    double px = pts[i].first * kx - ax, py = pts[i].second - ay, d2;
    if (L == 0) d2 = px * px + py * py;
    else { double t = max(0.0, min(1.0, (px * dx + py * dy) / L)); double ex = px - t * dx, ey = py - t * dy; d2 = ex * ex + ey * ey; }
    if (d2 > best) { best = d2; bi = i; }
  }
  if (best > tol2) { keep[bi] = 1; dp(pts, a, bi, tol2, kx, keep); dp(pts, bi, b, tol2, kx, keep); }
}

// ---------------------------------------------------------------- CH
struct Arc { u32 to, w, pay; };
struct CH {
  u32 n;
  vector<vector<Arc>> out, in;
  vector<char> done;
  vector<u32> level, delnb;
  // witness search state
  vector<u32> dist, stamp; u32 cur = 0;
  vector<u32> touched;

  void add_arc(u32 u, u32 v, u32 w, u32 pay) {
    for (auto &a : out[u]) if (a.to == v) {
      if (w < a.w) { a.w = w; a.pay = pay; for (auto &b : in[v]) if (b.to == u) { b.w = w; b.pay = pay; break; } }
      return;
    }
    out[u].push_back({v, w, pay});
    in[v].push_back({u, w, pay});
  }
  // Dijkstra from s on uncontracted graph without node x, up to maxd, settle limit.
  void witness(u32 s, u32 x, u32 maxd, int limit) {
    cur++;
    if (cur == 0) { fill(stamp.begin(), stamp.end(), 0); cur = 1; }
    typedef pair<u32, u32> P;
    priority_queue<P, vector<P>, greater<P>> pq;
    stamp[s] = cur; dist[s] = 0; pq.push({0, s});
    int settled = 0;
    while (!pq.empty()) {
      auto [d, v] = pq.top(); pq.pop();
      if (d > dist[v]) continue;
      if (d > maxd || ++settled > limit) break;
      for (auto &a : out[v]) {
        if (a.to == x || done[a.to]) continue;
        u32 nd = d + a.w;
        if (stamp[a.to] != cur || nd < dist[a.to]) { stamp[a.to] = cur; dist[a.to] = nd; pq.push({nd, a.to}); }
      }
    }
  }
  u32 getd(u32 v) const { return stamp[v] == cur ? dist[v] : INF; }

  // returns number of shortcuts; if apply, adds them
  int contract(u32 v, bool apply, int limit) {
    int sc = 0;
    vector<Arc> ins, outs;
    for (auto &a : in[v]) if (!done[a.to]) ins.push_back(a);
    for (auto &a : out[v]) if (!done[a.to]) outs.push_back(a);
    vector<tuple<u32, u32, u32>> add;
    for (auto &ia : ins) {
      u32 u = ia.to, maxd = 0;
      for (auto &oa : outs) if (oa.to != u) maxd = max(maxd, ia.w + oa.w);
      if (maxd == 0) continue;
      witness(u, v, maxd, limit);
      for (auto &oa : outs) {
        if (oa.to == u) continue;
        u32 viaw = ia.w + oa.w;
        if (getd(oa.to) > viaw) { sc++; if (apply) add.emplace_back(u, oa.to, viaw); }
      }
    }
    if (apply) for (auto &[a, b, w] : add) add_arc(a, b, w, 0x80000000u | v);
    return sc;
  }
  int prio(u32 v) {
    int deg = 0;
    for (auto &a : in[v]) if (!done[a.to]) deg++;
    for (auto &a : out[v]) if (!done[a.to]) deg++;
    int sc = contract(v, false, 60);
    return 4 * (sc - deg) + 2 * (int)delnb[v] + (int)level[v];
  }
  void build() {
    double t0 = now();
    done.assign(n, 0); level.assign(n, 0); delnb.assign(n, 0); dist.assign(n, INF); stamp.assign(n, 0);
    typedef pair<int, u32> P;
    priority_queue<P, vector<P>, greater<P>> pq;
    for (u32 v = 0; v < n; v++) if (!out[v].empty() || !in[v].empty()) pq.push({prio(v), v});
    u32 order = 0, total = pq.size();
    vector<u32> rank(n, 0);
    while (!pq.empty()) {
      auto [p, v] = pq.top(); pq.pop();
      if (done[v]) continue;
      int np = prio(v);
      if (!pq.empty() && np > pq.top().first) { pq.push({np, v}); continue; }
      contract(v, true, 500);
      done[v] = 1; rank[v] = ++order;
      // neighbours: update level / deleted count, re-prioritise lazily
      vector<u32> nb;
      for (auto &a : in[v]) if (!done[a.to]) nb.push_back(a.to);
      for (auto &a : out[v]) if (!done[a.to]) nb.push_back(a.to);
      sort(nb.begin(), nb.end()); nb.erase(unique(nb.begin(), nb.end()), nb.end());
      for (u32 x : nb) { delnb[x]++; level[x] = max(level[x], level[v] + 1); }
      if (order % 500000 == 0) fprintf(stderr, "    contracted %u/%u  %.0fs\n", order, total, now() - t0);
      // drop arcs into v from neighbours' lists (not needed in the final upward graphs)
      for (u32 x : nb) {
        auto &o = out[x]; o.erase(remove_if(o.begin(), o.end(), [&](const Arc &a) { return a.to == v; }), o.end());
        auto &i = in[x]; i.erase(remove_if(i.begin(), i.end(), [&](const Arc &a) { return a.to == v; }), i.end());
      }
    }
    this->rank = rank;
    fprintf(stderr, "    CH done in %.0fs\n", now() - t0);
  }
  vector<u32> rank;
  void write(const string &path) {
    // forward upward: out[v] arcs to higher rank. backward upward: in[v] arcs from higher rank.
    vector<u32> fo(n + 1, 0), bo(n + 1, 0), ft, fw, fp, bt, bw, bp;
    for (u32 v = 0; v < n; v++) {
      for (auto &a : out[v]) if (rank[a.to] > rank[v]) { ft.push_back(a.to); fw.push_back(a.w); fp.push_back(a.pay); }
      fo[v + 1] = ft.size();
      for (auto &a : in[v]) if (rank[a.to] > rank[v]) { bt.push_back(a.to); bw.push_back(a.w); bp.push_back(a.pay); }
      bo[v + 1] = bt.size();
    }
    ofstream f(path, ios::binary);
    u32 hdr[3] = {n, (u32)ft.size(), (u32)bt.size()};
    f.write((char *)hdr, sizeof hdr);
    writev(f, fo); writev(f, ft); writev(f, fw); writev(f, fp);
    writev(f, bo); writev(f, bt); writev(f, bw); writev(f, bp);
    fprintf(stderr, "    wrote %s: %u fwd + %u bwd arcs\n", path.c_str(), hdr[1], hdr[2]);
  }
};

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: graph IN OUT [profiles=car,bike,foot]\n"); return 1; }
  string in = argv[1], out = argv[2];
  string profs = argc > 3 ? argv[3] : "car,bike,foot";
  double t0 = now();
  auto ways = readv<WayIn>(in + "/ways.bin");
  auto woff = readv<u64>(in + "/way_off.bin");
  auto nids = readv<i64>(in + "/node_ids.bin");
  auto nll = readv<int32_t>(in + "/node_ll.bin");
  auto barriers = readv<i64>(in + "/barriers.bin");
  auto signals = readv<i64>(in + "/signals.bin");
  size_t W = ways.size(), M = nids.size();
  fprintf(stderr, "%zu ways, %zu way-nodes\n", W, M);

  // unique node ids and usage counts
  vector<i64> uid(nids);
  sort(uid.begin(), uid.end()); uid.erase(unique(uid.begin(), uid.end()), uid.end());
  vector<u32> wn(M);
  vector<uint8_t> cnt(uid.size(), 0);
  for (size_t i = 0; i < M; i++) {
    wn[i] = lower_bound(uid.begin(), uid.end(), nids[i]) - uid.begin();
    if (cnt[wn[i]] < 255) cnt[wn[i]]++;
  }
  vector<char> isbar(uid.size(), 0), issig(uid.size(), 0);
  for (i64 b : barriers) { auto it = lower_bound(uid.begin(), uid.end(), b); if (it != uid.end() && *it == b) isbar[it - uid.begin()] = 1; }
  for (i64 b : signals) { auto it = lower_bound(uid.begin(), uid.end(), b); if (it != uid.end() && *it == b) issig[it - uid.begin()] = 1; }
  vector<u32> gid(uid.size(), INF);
  vector<int32_t> nodes_ll;
  auto junction = [&](u32 k) { return cnt[k] > 1 || isbar[k]; };
  auto getg = [&](u32 k, size_t i) {
    if (gid[k] == INF) { gid[k] = nodes_ll.size() / 2; nodes_ll.push_back(nll[2 * i]); nodes_ll.push_back(nll[2 * i + 1]); }
    return gid[k];
  };
  fprintf(stderr, "%zu unique nodes  %.0fs\n", uid.size(), now() - t0);

  // split ways into base edges
  vector<EdgeOut> edges;
  vector<int32_t> geom;
  struct EP { int car_f, car_b, bike_f, bike_b, foot; u32 sig_f, sig_b; bool bar; };
  vector<EP> ep;
  vector<double> waylen(W, 0);
  for (size_t w = 0; w < W; w++) {
    for (u64 i = woff[w] + 1; i < woff[w + 1]; i++) waylen[w] += hav(nll[2 * (i - 1)], nll[2 * (i - 1) + 1], nll[2 * i], nll[2 * i + 1]);
  }
  for (size_t w = 0; w < W; w++) {
    u64 a = woff[w], b = woff[w + 1];
    u64 s = a;
    for (u64 i = a + 1; i < b; i++) {
      if (i != b - 1 && !junction(wn[i])) continue;
      // edge s..i
      vector<pair<int32_t, int32_t>> pts;
      double len = 0; u32 sf = 0, sb = 0; bool bar = false;
      for (u64 j = s; j <= i; j++) {
        pts.push_back({nll[2 * j], nll[2 * j + 1]});
        if (j > s) len += hav(nll[2 * (j - 1)], nll[2 * (j - 1) + 1], nll[2 * j], nll[2 * j + 1]);
        if (issig[wn[j]]) { if (j > s) sf++; if (j < i) sb++; }
        if (isbar[wn[j]]) bar = true;
      }
      u32 gu = getg(wn[s], s), gv = getg(wn[i], i);
      if (gu != gv || len > 0) {
        vector<char> keep(pts.size(), 0); keep[0] = keep.back() = 1;
        double kx = cos(pts[0].second / 1e7 * M_PI / 180);
        double tol = 1.0 / 0.0111;  // 1 m in E7 lat units (1e-7 deg = 0.0111 m)
        dp(pts, 0, pts.size() - 1, tol * tol, kx, keep);
        EdgeOut e{gu, gv, (u32)(geom.size() / 2), 0, (u32)w, (float)len};
        for (size_t k = 0; k < pts.size(); k++) if (keep[k]) { geom.push_back(pts[k].first); geom.push_back(pts[k].second); e.gn++; }
        edges.push_back(e);
        ep.push_back({ways[w].cf, ways[w].cb, ways[w].bf, ways[w].bb, ways[w].fs, sf, sb, bar});
      }
      s = i;
    }
  }
  u32 N = nodes_ll.size() / 2, E = edges.size();
  fprintf(stderr, "%u graph nodes, %u base edges, %zu geom points  %.0fs\n", N, E, geom.size() / 2, now() - t0);
  { vector<i64>().swap(uid); vector<u32>().swap(wn); vector<i64>().swap(nids); }

  writef(out + "/nodes.bin", nodes_ll);
  writef(out + "/edges.bin", edges);
  writef(out + "/geom.bin", geom);
  {
    vector<WayOut> wo(W);
    for (size_t w = 0; w < W; w++) wo[w] = {(u32)ways[w].name, (uint8_t)ways[w].cls, (uint8_t)ways[w].flags, 0};
    writef(out + "/ways.bin", wo);
    ifstream ni(in + "/names.json", ios::binary); ofstream no(out + "/names.json", ios::binary); no << ni.rdbuf();
  }
  // grid
  {
    const double C = 0.005;
    vector<pair<u32, u32>> ce;
    for (u32 e = 0; e < E; e++) {
      auto &ed = edges[e];
      for (u32 k = 0; k + 1 < ed.gn; k++) {
        double x1 = geom[2 * (ed.goff + k)] / 1e7, y1 = geom[2 * (ed.goff + k) + 1] / 1e7;
        double x2 = geom[2 * (ed.goff + k + 1)] / 1e7, y2 = geom[2 * (ed.goff + k + 1) + 1] / 1e7;
        int c1 = floor((min(x1, x2) + 180) / C), c2 = floor((max(x1, x2) + 180) / C);
        int r1 = floor((min(y1, y2) + 90) / C), r2 = floor((max(y1, y2) + 90) / C);
        for (int r = r1; r <= r2; r++) for (int c = c1; c <= c2; c++) ce.push_back({(u32)r * 72000u + (u32)c, e});
      }
    }
    sort(ce.begin(), ce.end()); ce.erase(unique(ce.begin(), ce.end()), ce.end());
    vector<u32> keys, offs, ids;
    for (size_t i = 0; i < ce.size(); i++) {
      if (keys.empty() || keys.back() != ce[i].first) { keys.push_back(ce[i].first); offs.push_back(i); }
      ids.push_back(ce[i].second);
    }
    offs.push_back(ce.size());
    ofstream f(out + "/grid.bin", ios::binary);
    u32 hdr[2] = {(u32)keys.size(), (u32)ids.size()};
    f.write((char *)hdr, sizeof hdr); writev(f, keys); writev(f, offs); writev(f, ids);
    fprintf(stderr, "grid: %u cells, %u entries\n", hdr[0], hdr[1]);
  }

  // profiles
  size_t pos = 0;
  while (pos < profs.size()) {
    size_t c = profs.find(',', pos); if (c == string::npos) c = profs.size();
    string p = profs.substr(pos, c - pos); pos = c + 1;
    double tp = now();
    fprintf(stderr, "profile %s\n", p.c_str());
    vector<u32> ew(4 * (size_t)E, INF);
    for (u32 e = 0; e < E; e++) {
      auto &x = ep[e]; auto &way = ways[edges[e].way];
      int sf, sb; u32 extra_f = 0, extra_b = 0; double rate = 1.0;
      if (p == "car") { sf = x.car_f; sb = x.car_b; extra_f = 20 * x.sig_f; extra_b = 20 * x.sig_b; rate = way.rate / 100.0; if (x.bar) sf = sb = 0; }
      else if (p == "bike") { sf = x.bike_f; sb = x.bike_b; }
      else { sf = sb = x.foot; }
      bool ferry = way.flags & 1;
      double len = edges[e].len;
      auto dur = [&](int sp, u32 extra) -> u32 {
        if (ferry && way.dur > 0 && waylen[edges[e].way] > 0) return (u32)max(1.0, round(way.dur * 10 * len / waylen[edges[e].way]));
        if (sp <= 0) return INF;
        return (u32)max(1.0, round(len / (sp / 10.0 / 3.6) * 10)) + extra;
      };
      bool okf = sf > 0, okb = sb > 0;  // ferries: 5 km/h unless a duration tag gives the time
      if (okf) { ew[4 * e] = dur(sf, extra_f); ew[4 * e + 2] = (u32)round(ew[4 * e] / rate); }
      if (okb) { ew[4 * e + 1] = dur(sb, extra_b); ew[4 * e + 3] = (u32)round(ew[4 * e + 1] / rate); }
    }
    writef(out + "/" + p + ".edgew.bin", ew);
    // components (weak) for snapping
    vector<u32> par(N); iota(par.begin(), par.end(), 0);
    function<u32(u32)> find = [&](u32 x) { while (par[x] != x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (u32 e = 0; e < E; e++) if (ew[4 * e] != INF || ew[4 * e + 1] != INF) { u32 a = find(edges[e].u), b = find(edges[e].v); if (a != b) par[a] = b; }
    vector<u32> csz(N, 0);
    for (u32 v = 0; v < N; v++) csz[find(v)]++;
    vector<uint8_t> big(E, 0);
    u32 nbig = 0;
    for (u32 e = 0; e < E; e++) if ((ew[4 * e] != INF || ew[4 * e + 1] != INF) && csz[find(edges[e].u)] >= 500) { big[e] = 1; nbig++; }
    writef(out + "/" + p + ".comp.bin", big);
    fprintf(stderr, "  %u/%u edges in large components\n", nbig, E);
    // CH
    CH ch; ch.n = N; ch.out.resize(N); ch.in.resize(N);
    for (u32 e = 0; e < E; e++) {
      u32 u = edges[e].u, v = edges[e].v;
      if (u == v) continue;
      if (ew[4 * e + 2] != INF) ch.add_arc(u, v, ew[4 * e + 2], e * 2);
      if (ew[4 * e + 3] != INF) ch.add_arc(v, u, ew[4 * e + 3], e * 2 + 1);
    }
    ch.build();
    ch.write(out + "/" + p + ".ch.bin");
    fprintf(stderr, "  profile %s done in %.0fs\n", p.c_str(), now() - tp);
  }
  fprintf(stderr, "all done in %.0fs\n", now() - t0);
  return 0;
}
