'use strict';
// Tiny shared toolkit used by every service: JSON logs, Prometheus metrics,
// a minimal router, HTTP helpers. It has no npm dependencies on purpose.
const http = require('node:http');
const crypto = require('node:crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function makeLogger(service) {
  return function log(level, msg, extra = {}) {
    const min = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
    if ((LEVELS[level] ?? LEVELS.info) < min) return;
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...extra }) + '\n'
    );
  };
}

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

const json = (status, body, headers) => ({ status, body, headers });

// ---------------------------------------------------------------- metrics
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function createMetrics() {
  const help = new Map();
  const counters = new Map();
  const histograms = new Map();
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  const fmt = (labels) => {
    const entries = Object.entries(labels);
    if (!entries.length) return '';
    return '{' + entries.map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}';
  };

  function inc(name, labels = {}, by = 1, helpText = name) {
    if (!help.has(name)) help.set(name, helpText);
    if (!counters.has(name)) counters.set(name, new Map());
    const series = counters.get(name);
    const key = JSON.stringify(labels);
    const current = series.get(key) || { labels, value: 0 };
    current.value += by;
    series.set(key, current);
  }

  function observe(name, labels, value, helpText = name) {
    if (!help.has(name)) help.set(name, helpText);
    if (!histograms.has(name)) histograms.set(name, new Map());
    const series = histograms.get(name);
    const key = JSON.stringify(labels);
    let h = series.get(key);
    if (!h) {
      h = { labels, buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
      series.set(key, h);
    }
    BUCKETS.forEach((b, i) => {
      if (value <= b) h.buckets[i] += 1;
    });
    h.sum += value;
    h.count += 1;
  }

  function render() {
    const out = [];
    for (const [name, series] of counters) {
      out.push(`# HELP ${name} ${help.get(name)}`, `# TYPE ${name} counter`);
      for (const { labels, value } of series.values()) out.push(`${name}${fmt(labels)} ${value}`);
    }
    for (const [name, series] of histograms) {
      out.push(`# HELP ${name} ${help.get(name)}`, `# TYPE ${name} histogram`);
      for (const h of series.values()) {
        BUCKETS.forEach((b, i) => out.push(`${name}_bucket${fmt({ ...h.labels, le: b })} ${h.buckets[i]}`));
        out.push(`${name}_bucket${fmt({ ...h.labels, le: '+Inf' })} ${h.count}`);
        out.push(`${name}_sum${fmt(h.labels)} ${h.sum}`);
        out.push(`${name}_count${fmt(h.labels)} ${h.count}`);
      }
    }
    const mem = process.memoryUsage();
    out.push(
      '# HELP process_uptime_seconds Seconds since the process started.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${process.uptime()}`,
      '# HELP process_heap_used_bytes Node.js heap in use.',
      '# TYPE process_heap_used_bytes gauge',
      `process_heap_used_bytes ${mem.heapUsed}`,
      '# HELP process_resident_memory_bytes Resident memory size.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${mem.rss}`
    );
    return out.join('\n') + '\n';
  }

  return { inc, observe, render };
}

// ------------------------------------------------------------------ router
function compile(route) {
  const method = (route.method || 'GET').toUpperCase();
  if (route.prefix !== undefined) {
    const p = route.prefix.replace(/\/+$/, '');
    return {
      method,
      label: `${p}/*`,
      match: (path) => (path === p || path.startsWith(p + '/') ? {} : null),
      handler: route.handler,
    };
  }
  const names = [];
  const source = route.path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, n) => {
      names.push(n);
      return '([^/]+)';
    });
  const re = new RegExp('^' + source + '/?$');
  return {
    method,
    label: route.path,
    match: (path) => {
      const m = re.exec(path);
      if (!m) return null;
      return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    },
    handler: route.handler,
  };
}

function readBody(req, limit = 1_000_000) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  if (!buf.length) throw httpError(400, 'JSON body required');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

function send(res, r) {
  const headers = { ...(r.headers || {}) };
  let payload = '';
  if (r.body !== undefined && r.body !== null) {
    if (Buffer.isBuffer(r.body) || typeof r.body === 'string') {
      payload = r.body;
      headers['content-type'] = r.contentType || headers['content-type'] || 'text/plain; charset=utf-8';
    } else {
      payload = JSON.stringify(r.body);
      headers['content-type'] = 'application/json; charset=utf-8';
    }
  }
  headers['content-length'] = Buffer.byteLength(payload);
  res.writeHead(r.status, headers);
  res.end(payload);
}

function createService({ name, log = makeLogger(name), routes, onClose }) {
  const metrics = createMetrics();
  const table = routes.map(compile);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://internal');
    const path = url.pathname;
    const reqId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', reqId);

    if (path === '/healthz') return send(res, json(200, { status: 'ok', service: name }));
    if (path === '/metrics') {
      return send(res, { status: 200, body: metrics.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' });
    }

    const started = process.hrtime.bigint();
    let label = 'unmatched';
    let result;
    try {
      let route = null;
      let params = {};
      for (const r of table) {
        if (r.method !== req.method) continue;
        const m = r.match(path);
        if (m) {
          route = r;
          params = m;
          break;
        }
      }
      if (!route) throw httpError(404, 'not found');
      label = route.label;
      const rawBody = await readBody(req);
      const ctx = {
        req,
        url,
        params,
        query: Object.fromEntries(url.searchParams),
        rawBody,
        reqId,
        log,
        metrics,
        json: () => parseJson(rawBody),
      };
      result = (await route.handler(ctx)) || json(204);
    } catch (err) {
      const status = err.status || (err instanceof URIError ? 400 : 500);
      if (status >= 500 && !err.status) log('error', 'unhandled error', { reqId, path, error: err.message });
      result = json(status, {
        error: err.status ? err.message : status === 400 ? 'bad request' : 'internal error',
        ...(err.extra || {}),
      });
    }

    send(res, result);
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    metrics.inc('http_requests_total', { method: req.method, route: label, status: result.status }, 1, 'Total HTTP requests handled.');
    metrics.observe('http_request_duration_seconds', { method: req.method, route: label }, seconds, 'HTTP request latency in seconds.');
    log('info', 'request', { reqId, method: req.method, path, status: result.status, ms: Math.round(seconds * 1000) });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('error', 'fatal request error', { error: err.message });
      if (!res.headersSent) send(res, json(500, { error: 'internal error' }));
      else res.end();
    });
  });

  async function close() {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections?.();
    });
    if (onClose) await onClose();
  }

  return { server, log, metrics, close };
}

function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

async function run(build, defaultPort) {
  const svc = await build(process.env);
  const port = await listen(svc.server, Number(process.env.PORT || defaultPort));
  svc.log('info', 'listening', { port });
  const stop = async () => {
    svc.log('info', 'shutting down');
    await svc.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// ---------------------------------------------------------- http helpers
async function callJson(url, { method = 'GET', body, reqId, timeoutMs = 5000 } = {}) {
  const headers = { accept: 'application/json' };
  if (reqId) headers['x-request-id'] = reqId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw httpError(502, `upstream unavailable: ${new URL(url).host}`);
  }
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, data };
}

// Forward the incoming request to `base`, removing `stripPrefix` from the path.
async function proxy(ctx, base, stripPrefix = '') {
  const path = ctx.url.pathname.slice(stripPrefix.length) || '/';
  const target = base.replace(/\/$/, '') + path + ctx.url.search;
  const headers = { 'x-request-id': ctx.reqId };
  const type = ctx.req.headers['content-type'];
  if (type) headers['content-type'] = type;
  const hasBody = ctx.rawBody.length > 0;
  let resp;
  try {
    resp = await fetch(target, {
      method: ctx.req.method,
      headers,
      body: hasBody ? ctx.rawBody : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw httpError(502, `upstream unavailable: ${new URL(base).host}`);
  }
  return {
    status: resp.status,
    body: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') || 'application/octet-stream',
    headers: resp.headers.get('x-cache') ? { 'x-cache': resp.headers.get('x-cache') } : undefined,
  };
}

async function retry(fn, { tries = 30, delayMs = 2000, log, what = 'operation' } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw err;
      if (log) log('warn', `${what} failed, retrying`, { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { makeLogger, createService, listen, run, json, httpError, callJson, proxy, retry };
