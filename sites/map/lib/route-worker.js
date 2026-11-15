'use strict';
// Worker thread: owns one RouteEngine (read-only base data) and answers route requests.
const { parentPort, workerData } = require('worker_threads');
const { RouteEngine } = require('./route-core');

const engine = new RouteEngine(workerData.dir, { profiles: workerData.profiles });
parentPort.postMessage({ ready: true });
parentPort.on('message', (msg) => {
  const { id, method, args } = msg;
  try {
    let result;
    if (method === 'route') result = engine.route(args.from, args.to, args.profile, args.opts || {});
    else if (method === 'snap') result = engine.snap(args.lon, args.lat, args.profile);
    else if (method === 'table') {
      result = args.sources.map((s) => args.destinations.map((d) => {
        const r = engine.route(s, d, args.profile);
        return r.code === 'Ok' ? { distance: r.distance, duration: r.duration } : null;
      }));
    } else throw new Error('unknown method ' + method);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
