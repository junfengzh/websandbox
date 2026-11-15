'use strict';
// Worker thread: owns one Geocoder (read-only geocode.db) so slow searches never block the
// site's event loop. Messages: {id, method, args: [...]} -> {id, result} | {id, error}.
const { parentPort, workerData } = require('worker_threads');
const { Geocoder } = require('./geocode');

const g = new Geocoder(workerData.db);
const METHODS = new Set(['search', 'autocomplete', 'reverse', 'nearby', 'get', 'lookup']);
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!METHODS.has(method)) throw new Error('unknown method ' + method);
    parentPort.postMessage({ id, result: g[method](...args) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
