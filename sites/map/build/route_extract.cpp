// Pass 1 of the routing build (C++/libosmium): routable ways with OSRM-like
// car / bicycle / foot speeds, written as flat arrays for graph.cpp.
//
//   g++ -O3 -std=c++17 -o route_extract route_extract.cpp -lz -lbz2 -lexpat -lpthread
//   ./route_extract WORK/all.osm.pbf WORK/route
//
// Output (little endian), one record per way:
//   ways.bin      int32 car_fwd, car_bwd, bike_fwd, bike_bwd, foot (km/h * 10, 0 = no access), flags,
//                 name_id, float32 ferry duration (s, 0 = none), int32 class, int32 car_rate (x100)
//   way_off.bin   uint64 offsets into node arrays (n_ways + 1)
//   node_ids.bin  int64 node ids along ways;  node_ll.bin int32 lon*1e7, lat*1e7
//   names.json    [[name, ref, class], ...];  barriers.bin / signals.bin  sorted int64 node ids
//
// Rules follow OSRM's car.lua / bicycle.lua / foot.lua defaults (speeds by highway type,
// maxspeed * 0.8 for cars, access tag hierarchies, oneways, barriers, ferries 5 km/h or duration tag).
#include <osmium/handler.hpp>
#include <osmium/handler/node_locations_for_ways.hpp>
#include <osmium/index/map/sparse_mem_array.hpp>
#include <osmium/io/pbf_input.hpp>
#include <osmium/visitor.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <regex>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

using namespace std;

static const vector<string> CLASSES = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
    "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street",
    "service", "track", "road", "path", "footway", "cycleway", "pedestrian", "steps", "bridleway",
    "platform", "pier", "corridor", "busway", "ferry"};
static const map<string, double> CAR_SPEEDS = {
    {"motorway", 90}, {"motorway_link", 45}, {"trunk", 85}, {"trunk_link", 40}, {"primary", 65},
    {"primary_link", 30}, {"secondary", 55}, {"secondary_link", 25}, {"tertiary", 40}, {"tertiary_link", 20},
    {"unclassified", 25}, {"residential", 25}, {"living_street", 10}, {"service", 15}};
static const set<string> CAR_SERVICE_PENALTY = {"alley", "parking", "parking_aisle", "driveway", "drive-through", "drive-thru"};
static const set<string> CAR_ACCESS_BL = {"no", "agricultural", "forestry", "emergency", "psv", "customers", "private", "delivery"};
static const set<string> CAR_BARRIER_OK = {"cattle_grid", "border_control", "toll_booth", "sally_port", "gate", "lift_gate",
                                           "no", "entrance", "height_restrictor", "arch"};
static const map<string, double> MAXSPEED_TABLE = {{"urban", 50}, {"rural", 90}, {"trunk", 100}, {"motorway", 130},
                                                   {"walk", 5}, {"none", 140}, {"living_street", 10}};
static const map<string, double> BIKE_SPEEDS = {
    {"cycleway", 15}, {"primary", 15}, {"primary_link", 15}, {"secondary", 15}, {"secondary_link", 15},
    {"tertiary", 15}, {"tertiary_link", 15}, {"residential", 15}, {"unclassified", 15}, {"living_street", 10},
    {"road", 15}, {"service", 10}, {"track", 12}, {"path", 13}, {"trunk", 15}, {"trunk_link", 15}, {"busway", 15}};
static const set<string> BIKE_PUSH = {"footway", "pedestrian", "steps", "platform", "corridor", "bridleway"};
static const set<string> ACCESS_BL = {"no", "agricultural", "forestry", "private", "delivery", "emergency", "customers"};
static const set<string> FOOT_HW = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
                                    "unclassified", "residential", "road", "living_street", "service", "track", "path",
                                    "steps", "pedestrian", "platform", "footway", "pier", "trunk", "trunk_link",
                                    "cycleway", "corridor", "bridleway", "busway"};
enum { F_FERRY = 1, F_ROUNDABOUT = 2, F_TOLL = 4, F_BRIDGE = 8, F_TUNNEL = 16, F_CAR_ONEWAY = 32 };
static const double SPEED_REDUCTION = 0.8, FOOT_SPEED = 5, BIKE_WALK = 4, FERRY_SPEED = 5;

#pragma pack(push, 1)
struct WayRec { int32_t cf, cb, bf, bb, fs, flags, name; float dur; int32_t cls, rate; };
#pragma pack(pop)

static string tag(const osmium::TagList &t, const char *k) { const char *v = t.get_value_by_key(k); return v ? string(v) : string(); }
static string first(const string &v) { auto p = v.find(';'); return p == string::npos ? v : v.substr(0, p); }

// 1 = allowed, 0 = denied, -1 = unset
static int access(const osmium::TagList &t, const vector<const char *> &hier, const set<string> &bl) {
  for (auto k : hier) {
    string v = tag(t, k);
    if (!v.empty()) return bl.count(first(v)) ? 0 : 1;
  }
  return -1;
}
static int oneway_of(const string &v) {
  if (v == "yes" || v == "1" || v == "true") return 1;
  if (v == "-1" || v == "reverse") return -1;
  if (v == "no" || v == "false" || v == "0") return 0;
  return 2;  // unset
}
static double parse_maxspeed(string v) {
  if (v.empty()) return 0;
  transform(v.begin(), v.end(), v.begin(), ::tolower);
  static const regex num(R"(^\s*([0-9.]+)\s*(mph|km/h|kmh|kph|knots)?\s*$)");
  smatch m;
  if (regex_match(v, m, num)) {
    double s = atof(m[1].str().c_str());
    if (m[2] == "mph") s *= 1.609344;
    else if (m[2] == "knots") s *= 1.852;
    return s;
  }
  auto c = v.find(':');
  string k = c == string::npos ? v : v.substr(c + 1);
  auto it = MAXSPEED_TABLE.find(k);
  return it == MAXSPEED_TABLE.end() ? 0 : it->second;
}
static double parse_duration(const string &v) {
  if (v.empty()) return 0;
  static const regex iso(R"(^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$)");
  smatch m;
  if (v[0] == 'P') {
    if (regex_match(v, m, iso)) return (m[1].matched ? stoi(m[1]) * 3600 : 0) + (m[2].matched ? stoi(m[2]) * 60 : 0) + (m[3].matched ? stoi(m[3]) : 0);
    return 0;
  }
  vector<double> parts; size_t s = 0;
  while (true) {
    size_t c = v.find(':', s);
    string p = v.substr(s, c == string::npos ? string::npos : c - s);
    char *end; double x = strtod(p.c_str(), &end);
    if (end == p.c_str()) return 0;
    parts.push_back(x);
    if (c == string::npos) break;
    s = c + 1;
  }
  if (parts.size() == 1) return parts[0] * 60;
  if (parts.size() == 2) return parts[0] * 3600 + parts[1] * 60;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
static bool starts(const string &s, const char *p) { return s.rfind(p, 0) == 0; }

struct Handler : public osmium::handler::Handler {
  vector<WayRec> ways;
  vector<uint64_t> offs{0};
  vector<int64_t> nids;
  vector<int32_t> ll;
  vector<int64_t> barriers, signals;
  vector<array<string, 3>> names;
  map<array<string, 3>, int> name_ids;
  map<string, int> cls_id;
  Handler() { for (size_t i = 0; i < CLASSES.size(); i++) cls_id[CLASSES[i]] = i; }

  void node(const osmium::Node &n) {
    auto &t = n.tags();
    if (t.empty()) return;
    string b = tag(t, "barrier");
    if (!b.empty() && !CAR_BARRIER_OK.count(b)) {
      if (access(t, {"motorcar", "motor_vehicle", "vehicle", "access"}, CAR_ACCESS_BL) != 1) barriers.push_back(n.id());
    }
    if (tag(t, "highway") == "traffic_signals") signals.push_back(n.id());
  }

  void way(const osmium::Way &w) {
    auto &t = w.tags();
    string hw = tag(t, "highway"), route = tag(t, "route");
    WayRec r{0, 0, 0, 0, 0, 0, 0, 0.f, 0, 100};
    if (route == "ferry") {
      r.flags = F_FERRY; r.dur = parse_duration(tag(t, "duration")); r.cls = cls_id["ferry"];
      int car = access(t, {"motorcar", "motor_vehicle", "vehicle", "access"}, CAR_ACCESS_BL);
      int bike = access(t, {"bicycle", "vehicle", "access"}, ACCESS_BL);
      int foot = access(t, {"foot", "access"}, ACCESS_BL);
      int sp = FERRY_SPEED * 10;
      r.cf = r.cb = car == 0 ? 0 : sp; r.bf = r.bb = bike == 0 ? 0 : sp; r.fs = foot == 0 ? 0 : sp;
    } else {
      if (hw.empty()) return;
      static const set<string> bad = {"construction", "proposed", "abandoned", "raceway", "elevator", "bus_stop", "via_ferrata", "razed", "disused"};
      if (bad.count(hw)) return;
      string area = tag(t, "area");
      if (area == "yes" && hw != "pedestrian" && hw != "footway" && hw != "platform") return;
      string junction = tag(t, "junction");
      if (junction == "roundabout" || junction == "circular") r.flags |= F_ROUNDABOUT;
      if (tag(t, "toll") == "yes") r.flags |= F_TOLL;
      string br = tag(t, "bridge"), tu = tag(t, "tunnel");
      if (!br.empty() && br != "no") r.flags |= F_BRIDGE;
      if (!tu.empty() && tu != "no") r.flags |= F_TUNNEL;
      int ow = oneway_of(tag(t, "oneway"));
      if (ow == 2) ow = (hw == "motorway" || junction == "roundabout" || junction == "circular") ? 1 : 0;
      // car
      auto cs = CAR_SPEEDS.find(hw);
      if (cs != CAR_SPEEDS.end()) {
        int acc = access(t, {"motorcar", "motor_vehicle", "vehicle", "access"}, CAR_ACCESS_BL);
        string svc = tag(t, "service");
        if (acc != 0 && svc != "emergency_access" && tag(t, "impassable") != "yes") {
          string adv = tag(t, "maxspeed:advisory"), ms = tag(t, "maxspeed");
          string msf = tag(t, "maxspeed:forward"), msb = tag(t, "maxspeed:backward");
          double f = parse_maxspeed(!msf.empty() ? msf : !adv.empty() ? adv : ms);
          double b = parse_maxspeed(!msb.empty() ? msb : !adv.empty() ? adv : ms);
          double sf = f > 0 ? f * SPEED_REDUCTION : cs->second, sb = b > 0 ? b * SPEED_REDUCTION : cs->second;
          if (CAR_SERVICE_PENALTY.count(svc)) r.rate = 50;
          if (ow >= 0) r.cf = lround(sf * 10);
          if (ow <= 0) r.cb = lround(sb * 10);
          if (ow != 0) r.flags |= F_CAR_ONEWAY;
        }
      }
      // bicycle
      int bacc = access(t, {"bicycle", "vehicle", "access"}, ACCESS_BL);
      if ((BIKE_SPEEDS.count(hw) || BIKE_PUSH.count(hw) || bacc == 1) && bacc != 0 && hw != "motorway" && hw != "motorway_link") {
        double s; bool push;
        if (BIKE_PUSH.count(hw) && bacc != 1) { s = hw == "steps" ? 2 : BIKE_WALK; push = true; }
        else { auto it = BIKE_SPEEDS.find(hw); s = it == BIKE_SPEEDS.end() ? 15 : it->second; push = false; }
        int bow = oneway_of(tag(t, "oneway:bicycle"));
        if (bow == 2) bow = (push || starts(tag(t, "cycleway"), "opposite") || starts(tag(t, "cycleway:left"), "opposite")) ? 0 : ow;
        r.bf = bow >= 0 ? lround(s * 10) : BIKE_WALK * 10;
        r.bb = bow <= 0 ? lround(s * 10) : BIKE_WALK * 10;
      }
      // foot
      int facc = access(t, {"foot", "access"}, ACCESS_BL);
      if ((FOOT_HW.count(hw) || facc == 1) && facc != 0 && hw != "motorway" && hw != "motorway_link") r.fs = FOOT_SPEED * 10;
      if (!r.cf && !r.cb && !r.bf && !r.bb && !r.fs) return;
      auto it = cls_id.find(hw);
      r.cls = it == cls_id.end() ? cls_id["road"] : it->second;
    }
    const auto &nl = w.nodes();
    if (nl.size() < 2) return;
    for (auto &n : nl) if (!n.location().valid()) return;
    array<string, 3> key{tag(t, "name"), tag(t, "ref"), CLASSES[r.cls]};
    auto ni = name_ids.find(key);
    if (ni == name_ids.end()) { ni = name_ids.emplace(key, names.size()).first; names.push_back(key); }
    r.name = ni->second;
    ways.push_back(r);
    for (auto &n : nl) { nids.push_back(n.ref()); ll.push_back(n.location().x()); ll.push_back(n.location().y()); }
    offs.push_back(nids.size());
  }
};

template <class T> void writef(const string &p, const vector<T> &v) { ofstream f(p, ios::binary); f.write((const char *)v.data(), v.size() * sizeof(T)); }
static string jesc(const string &s) {
  string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += c;
  }
  return o;
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: route_extract in.osm.pbf outdir\n"); return 1; }
  string out = argv[2];
  using Index = osmium::index::map::SparseMemArray<osmium::unsigned_object_id_type, osmium::Location>;
  Index index;
  osmium::handler::NodeLocationsForWays<Index> loc(index);
  loc.ignore_errors();
  Handler h;
  osmium::io::Reader reader{argv[1], osmium::osm_entity_bits::node | osmium::osm_entity_bits::way};
  osmium::apply(reader, loc, h);
  reader.close();
  sort(h.barriers.begin(), h.barriers.end());
  sort(h.signals.begin(), h.signals.end());
  writef(out + "/ways.bin", h.ways);
  writef(out + "/way_off.bin", h.offs);
  writef(out + "/node_ids.bin", h.nids);
  writef(out + "/node_ll.bin", h.ll);
  writef(out + "/barriers.bin", h.barriers);
  writef(out + "/signals.bin", h.signals);
  ofstream nf(out + "/names.json");
  nf << "[";
  for (size_t i = 0; i < h.names.size(); i++) {
    if (i) nf << ",";
    nf << "[\"" << jesc(h.names[i][0]) << "\",\"" << jesc(h.names[i][1]) << "\",\"" << h.names[i][2] << "\"]";
  }
  nf << "]\n";
  fprintf(stderr, "%zu routable ways, %zu way-nodes, %zu barriers, %zu signals\n", h.ways.size(), h.nids.size(),
          h.barriers.size(), h.signals.size());
  return 0;
}
