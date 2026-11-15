'use strict';
// Per-request / per-job context (AsyncLocalStorage), so site code can call
// kit.db(), kit.now(), kit.jobs.enqueue() without threading the tenant around.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

class HttpError extends Error {
  constructor(statusCode, message, extra) {
    super(message || String(statusCode));
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}
const httpError = (status, message, extra) => new HttpError(status, message, extra);

function ctx() {
  const c = als.getStore();
  if (!c) throw new Error('kit: no tenant context (call inside a route handler, job, or tenant.run())');
  return c;
}

const isLoopback = (a) => !!a && (a.startsWith('127.') || a === '::1' || a.startsWith('::ffff:127.'));

// "YYYY-MM-DD HH:MM:SS" (UTC) -- SQLite's datetime() format, sortable as text.
const sqlTime = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
// Parse an ISO / SQLite datetime string as UTC.
const parseTime = (s) => (s instanceof Date ? s.getTime() : typeof s === 'number' ? s : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z'));

module.exports = { als, ctx, HttpError, httpError, isLoopback, sqlTime, parseTime };
