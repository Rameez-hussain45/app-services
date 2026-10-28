'use strict';
const { createService, makeLogger, json, httpError, retry, run } = require('../../../shared/lib');

const NAME = 'users-service';
const SEED = [
  { name: 'Alice Johnson', email: 'alice@example.com' },
  { name: 'Bob Smith', email: 'bob@example.com' },
  { name: 'Carol Diaz', email: 'carol@example.com' },
];

// ----- storage: in memory by default, PostgreSQL when DATABASE_URL is set
function memoryStore() {
  const users = SEED.map((u, i) => ({ id: i + 1, ...u }));
  let next = users.length + 1;
  return {
    kind: 'memory',
    async list() {
      return users;
    },
    async get(id) {
      return users.find((u) => u.id === id) || null;
    },
    async create({ name, email }) {
      if (users.some((u) => u.email === email)) throw httpError(409, 'email already exists');
      const user = { id: next++, name, email };
      users.push(user);
      return user;
    },
    async close() {},
  };
}

async function postgresStore(url, log) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5 });
  await retry(
    () =>
      pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now())`),
    { log, what: 'postgres connection' }
  );
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    for (const u of SEED) {
      await pool.query('INSERT INTO users (name, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.name, u.email]);
    }
  }
  return {
    kind: 'postgres',
    async list() {
      return (await pool.query('SELECT id, name, email FROM users ORDER BY id')).rows;
    },
    async get(id) {
      return (await pool.query('SELECT id, name, email FROM users WHERE id = $1', [id])).rows[0] || null;
    },
    async create({ name, email }) {
      try {
        const res = await pool.query('INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email', [name, email]);
        return res.rows[0];
      } catch (err) {
        if (err.code === '23505') throw httpError(409, 'email already exists');
        throw err;
      }
    },
    close: () => pool.end(),
  };
}

// ----- cache: nothing by default, Redis when REDIS_URL is set
function noCache() {
  return { kind: 'none', get: async () => null, set: async () => {}, close: async () => {} };
}

function redisCache(url, log) {
  const { createClient } = require('redis');
  const client = createClient({ url, socket: { reconnectStrategy: (n) => Math.min(n * 200, 3000) } });
  client.on('error', (err) => log('warn', 'redis error', { error: err.message }));
  client.connect().catch(() => {});
  return {
    kind: 'redis',
    async get(key) {
      try {
        return client.isReady ? await client.get(key) : null;
      } catch {
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      try {
        if (client.isReady) await client.set(key, value, { EX: ttlSeconds });
      } catch {
        /* cache failures must never break a request */
      }
    },
    async close() {
      try {
        await client.quit();
      } catch {
        /* ignore */
      }
    },
  };
}

async function build(env = process.env) {
  const log = makeLogger(NAME);
  const store = env.DATABASE_URL ? await postgresStore(env.DATABASE_URL, log) : memoryStore();
  const cache = env.REDIS_URL ? redisCache(env.REDIS_URL, log) : noCache();
  log('info', 'storage ready', { store: store.kind, cache: cache.kind });

  const routes = [
    { method: 'GET', path: '/users', handler: async () => json(200, await store.list()) },
    {
      method: 'GET',
      path: '/users/:id',
      handler: async (ctx) => {
        const id = Number(ctx.params.id);
        if (!Number.isInteger(id) || id < 1) throw httpError(400, 'id must be a positive integer');
        const key = `user:${id}`;
        const hit = await cache.get(key);
        if (hit) {
          ctx.metrics.inc('user_cache_hits_total', {}, 1, 'User lookups answered from cache.');
          return json(200, JSON.parse(hit), { 'x-cache': 'HIT' });
        }
        const user = await store.get(id);
        if (!user) throw httpError(404, 'user not found');
        ctx.metrics.inc('user_cache_misses_total', {}, 1, 'User lookups that went to the database.');
        await cache.set(key, JSON.stringify(user), 30);
        return json(200, user, { 'x-cache': 'MISS' });
      },
    },
    {
      method: 'POST',
      path: '/users',
      handler: async (ctx) => {
        const { name, email } = ctx.json();
        if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'name is required');
        if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'a valid email is required');
        const user = await store.create({ name: name.trim(), email: email.trim().toLowerCase() });
        ctx.metrics.inc('users_created_total', {}, 1, 'Users created.');
        return json(201, user);
      },
    },
  ];

  return createService({
    name: NAME,
    log,
    routes,
    onClose: async () => {
      await cache.close();
      await store.close();
    },
  });
}

module.exports = { build };
if (require.main === module) run(build, 3001);
