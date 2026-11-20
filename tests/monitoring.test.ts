import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { localAuth } from '../server/auth.ts';
import { monitoringRouter, parseNodes, readDashboard } from '../server/monitoring.ts';
import type { DashboardData, Period } from '../src/model.ts';

const empty = (period: Period): DashboardData => ({
  period, bucketMinutes: 1, start: '', end: '', nodes: [], points: [],
});

test('local sessions protect telemetry, expire and can be revoked', async (t) => {
  const origin = 'https://beta.example.test';
  const password = 'fixture for a test account';
  const salt = Buffer.alloc(16, 42);
  const digest = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  let time = Date.now();
  const auth = localAuth({ origin, username: 'operator', hash: ['scrypt', salt.toString('hex'), digest.toString('hex')].join('$') }, () => time);
  let reads = 0;
  let fail = false;
  const app = express();
  app.use('/auth', auth.router);
  app.use('/unconfigured-auth', localAuth(null).router);
  app.use('/unconfigured', monitoringRouter(null));
  app.use('/api', monitoringRouter({
    authenticated: auth.authenticated,
    read: async (period) => {
      reads++;
      if (fail) throw new Error('private connection detail');
      return empty(period);
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const call = (url: string, cookie?: string) => fetch(base + url, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  const login = (name: string, secret: string, source = origin) => fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: source },
    body: JSON.stringify({ username: name, password: secret }),
  });

  assert.equal((await call('/unconfigured-auth/session')).status, 503);
  assert.equal((await call('/unconfigured/dashboard')).status, 503);
  assert.equal((await call('/api/dashboard')).status, 401);
  assert.equal((await call('/api/dashboard', '__Host-beta-session=' + 'A'.repeat(43))).status, 401);
  assert.deepEqual(await (await call('/auth/session')).json(), { authenticated: false });
  assert.equal((await login('operator', password, 'https://wrong.example.test')).status, 403);
  assert.equal((await login('unknown', password)).status, 401);
  assert.equal((await login('operator', 'invalid password')).status, 401);
  const signedIn = await login('operator', password);
  assert.equal(signedIn.status, 204);
  const cookieHeader = signedIn.headers.get('set-cookie') ?? '';
  assert.match(cookieHeader, /; HttpOnly/);
  assert.match(cookieHeader, /; Secure/);
  assert.match(cookieHeader, /; SameSite=Strict/);
  assert.match(cookieHeader, /; Path=\//);
  assert.doesNotMatch(cookieHeader, /; Domain=/);
  const cookie = cookieHeader.split(';')[0];
  assert.match(cookie, /^__Host-beta-session=/);
  assert.deepEqual(await (await call('/auth/session', cookie)).json(), { authenticated: true });
  assert.equal((await call('/api/dashboard?period=constructor', cookie)).status, 400);
  assert.equal((await call('/api/dashboard?period=1h&period=24h', cookie)).status, 400);
  assert.equal(reads, 0);

  const response = await call('/api/dashboard?period=6h', cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), empty('6h'));
  fail = true;
  const error = await call('/api/dashboard', cookie);
  assert.equal(error.status, 503);
  assert.doesNotMatch(await error.text(), /private connection detail/);

  const logout = (source: string) => fetch(base + '/auth/logout', {
    method: 'POST', headers: { Cookie: cookie, Origin: source },
  });
  assert.equal((await logout('https://wrong.example.test')).status, 403);
  assert.deepEqual(await (await call('/auth/session', cookie)).json(), { authenticated: true });
  assert.equal((await logout(origin)).status, 204);
  assert.equal((await call('/api/dashboard', cookie)).status, 401);

  const secondLogin = await login('operator', password);
  assert.equal(secondLogin.status, 204);
  const secondCookie = secondLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await login('operator', 'invalid password')).status, 401);
  assert.equal((await login('operator', password)).status, 429);
  time += 8 * 60 * 60 * 1000;
  assert.equal((await call('/api/dashboard', secondCookie)).status, 401);
  assert.equal((await login('operator', password)).status, 204);
});

test('node configuration rejects duplicate and invalid IDs', () => {
  const one = { id: 'node-1', label: 'VPS A', description: 'Exemplo' };
  assert.deepEqual(parseNodes(JSON.stringify([one])), [one]);
  assert.throws(() => parseNodes(JSON.stringify([one, one])));
  assert.throws(() => parseNodes(JSON.stringify([{ ...one, id: ' node-1' }])));
});

test('the PostgreSQL reader uses stored samples, preserves gaps and distinguishes node states', {
  skip: !process.env.BETA_TEST_DATABASE_URL,
}, async (t) => {
  const url = new URL(process.env.BETA_TEST_DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/monitoring_test');
  const pool = new Pool({ connectionString: url.href });
  t.after(() => pool.end());
  await pool.query(`
    CREATE SCHEMA telemetry;
    CREATE TABLE telemetry.metric_batches (node_id varchar(32), received_at timestamptz);
    CREATE TABLE telemetry.host_metrics (node_id varchar(32), collected_at timestamptz, cpu_percent numeric, ram_percent numeric);
    INSERT INTO telemetry.metric_batches VALUES
      ('node-1', '2026-11-20T14:00:00Z'), ('node-2', '2026-11-20T13:55:30Z'), ('node-4', '2026-11-20T13:00:00Z');
    INSERT INTO telemetry.host_metrics VALUES
      ('node-1', '2026-11-20T13:49:10Z', 30, 50),
      ('node-1', '2026-11-20T13:50:10Z', 20, 40),
      ('node-1', '2026-11-20T14:00:00Z', 0, 53),
      ('node-5', '2026-11-20T14:00:00Z', 99, 99);
  `);
  const nodes = [1, 2, 3, 4].map((n) => ({ id: 'node-' + n, label: 'VPS ' + n, description: '' }));
  const data = await readDashboard(pool, nodes, '6h', new Date('2026-11-20T14:01:00Z'));
  assert.equal(data.bucketMinutes, 5);
  assert.deepEqual(data.nodes.map(({ id, status, cpu }) => [id, status, cpu]), [
    ['node-1', 'online', 0], ['node-2', 'delayed', null],
    ['node-3', 'unknown', null], ['node-4', 'offline', null],
  ]);
  assert.deepEqual(data.points.map(({ nodeId, cpu, memory }) => [nodeId, cpu, memory]), [
    ['node-1', 25, 45], ['node-1', 0, 53],
  ]);
  assert.ok(Date.parse(data.points[1].time) - Date.parse(data.points[0].time) > data.bucketMinutes * 60_000);
});
