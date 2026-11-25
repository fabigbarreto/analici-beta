import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { localAuth } from '../server/auth.ts';
import { monitoringRouter, parseNodes, readDashboard, readExecutions } from '../server/monitoring.ts';
import { executionsLimit, type DashboardData, type Period } from '../src/model.ts';

const empty = (period: Period): DashboardData => ({
  period, bucketMinutes: 1, bucketSeconds: 60, start: '', end: '', nodes: [], points: [], storagePoints: [],
});

test('local sessions protect telemetry, expire and can be revoked', async (t) => {
  const origin = 'https://beta.example.test';
  const password = 'fixture for a test account';
  const salt = Buffer.alloc(16, 42);
  const digest = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  let time = Date.now();
  const auth = localAuth({ origin, username: 'operator', hash: ['scrypt', salt.toString('hex'), digest.toString('hex')].join('$') }, () => time);
  let reads = 0;
  const nodes = [{ id: 'node-1', label: 'VPS A', description: '' }];
  const executions = { updatedAt: new Date(time).toISOString(), nodes: [{ id: 'node-1', label: 'VPS A' }], batches: [] };
  const executionFilters: [Period, string | undefined][] = [];
  let fail = false;
  const app = express();
  app.use('/auth', auth.router);
  app.use('/unconfigured-auth', localAuth(null).router);
  app.use('/unconfigured', monitoringRouter(null));
  app.use('/api', monitoringRouter({
    authenticated: auth.authenticated,
    nodes,
    read: async (period) => {
      reads++;
      if (fail) throw new Error('private connection detail');
      return empty(period);
    },
    readExecutions: async (period, nodeId) => {
      executionFilters.push([period, nodeId]);
      return executions;
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
  const rejected = await call('/api/executions');
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('www-authenticate'), null);
  assert.equal(rejected.headers.get('cache-control'), 'private, no-store');
  assert.equal(executionFilters.length, 0);
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
  assert.equal((await call('/api/executions?node=unknown', cookie)).status, 400);
  assert.equal((await call('/api/executions?node=node-1&node=node-1', cookie)).status, 400);
  assert.equal((await call('/api/executions?period=constructor', cookie)).status, 400);
  assert.deepEqual(executionFilters, []);
  const history = await call('/api/executions?period=6h&node=node-1', cookie);
  assert.equal(history.status, 200);
  assert.equal(history.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await history.json(), executions);
  assert.deepEqual(executionFilters, [['6h', 'node-1']]);

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
  assert.equal((await call('/api/executions', cookie)).status, 401);

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
    CREATE TABLE telemetry.disk_metrics (node_id varchar(32), collected_at timestamptz, mountpoint varchar(128), percent numeric, used_bytes bigint, free_bytes bigint, total_bytes bigint);
    INSERT INTO telemetry.disk_metrics VALUES
      ('node-1', '2026-11-20T13:49:10Z', '/', 25, 25, 70, 100),
      ('node-1', '2026-11-20T13:50:10Z', '/', 35, 35, 60, 100),
      ('node-1', '2026-11-20T14:00:00Z', '/var', 99, 99, 0, 100),
      ('node-2', '2026-11-20T13:55:30Z', '/', 0, 0, 95, 100),
      ('node-5', '2026-11-20T14:00:00Z', '/', 99, 99, 0, 100);
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
  assert.equal(data.bucketSeconds, 300);
  assert.deepEqual(data.nodes.map(({ id, status, cpu }) => [id, status, cpu]), [
    ['node-1', 'online', 0], ['node-2', 'delayed', null],
    ['node-3', 'unknown', null], ['node-4', 'offline', null],
  ]);
  assert.deepEqual(data.points.map(({ nodeId, cpu, memory }) => [nodeId, cpu, memory]), [
    ['node-1', 25, 45], ['node-1', 0, 53],
  ]);
  assert.deepEqual(data.nodes.map(({ id, storage, storageCollectedAt }) => [id, storage, storageCollectedAt]), [
    ['node-1', 35, '2026-11-20T13:50:10.000Z'], ['node-2', 0, '2026-11-20T13:55:30.000Z'],
    ['node-3', null, null], ['node-4', null, null],
  ]);
  assert.deepEqual(data.storagePoints.map(({ nodeId, value }) => [nodeId, value]), [
    ['node-1', 30], ['node-2', 0],
  ]);
  assert.equal(data.nodes[0].storageUsedBytes, 35);
  assert.equal(data.nodes[0].storageFreeBytes, 60);
  assert.equal(data.nodes[0].storageTotalBytes, 100);
  assert.equal(data.nodes[1].storageUsedBytes, 0);
  assert.equal(data.nodes[2].storageTotalBytes, null);
  const recent = await readDashboard(pool, nodes, '15m', new Date('2026-11-20T14:01:07Z'));
  assert.equal(recent.bucketSeconds, 10);
  assert.equal(recent.start, '2026-11-20T13:46:00.000Z');
  assert.deepEqual(recent.storagePoints.map(({ time }) => time), [
    '2026-11-20T13:49:10.000Z', '2026-11-20T13:50:10.000Z', '2026-11-20T13:55:30.000Z',
  ]);
  assert.ok(Date.parse(data.points[1].time) - Date.parse(data.points[0].time) > data.bucketMinutes * 60_000);

  await pool.query(`
    CREATE ROLE execution_reader LOGIN;
    GRANT USAGE ON SCHEMA telemetry TO execution_reader;
    GRANT SELECT (node_id, received_at) ON telemetry.metric_batches TO execution_reader;
    INSERT INTO telemetry.metric_batches VALUES
      ('node-5', '2026-11-20T14:00:30Z'), ('node-1', '2026-11-20T14:01:01Z');
  `);
  const end = new Date('2026-11-20T14:01:00Z');
  const reader = await pool.connect();
  try {
    await reader.query('SET ROLE execution_reader');
    const history = await readExecutions(reader, nodes, '15m', undefined, end);
    assert.deepEqual(history.batches, [
      { nodeId: 'node-1', receivedAt: '2026-11-20T14:00:00.000Z' },
      { nodeId: 'node-2', receivedAt: '2026-11-20T13:55:30.000Z' },
    ]);
    const selected = await readExecutions(reader, nodes, '15m', 'node-2', end);
    assert.deepEqual(selected.batches, history.batches.slice(1));
    assert.deepEqual(selected.nodes, history.nodes);
    assert.deepEqual((await readExecutions(reader, nodes, '15m', 'node-4', end)).batches, []);
    await reader.query('RESET ROLE');
    await reader.query(`
      INSERT INTO telemetry.metric_batches (node_id, received_at)
      SELECT 'node-1', '2026-11-20T14:00:00Z'::timestamptz - n * interval '1 second'
      FROM generate_series(1, 110) AS n
    `);
    await reader.query('SET ROLE execution_reader');
    assert.equal((await readExecutions(reader, nodes, '15m', undefined, end)).batches.length, executionsLimit);
  } finally {
    await reader.query('RESET ROLE').finally(() => reader.release());
  }
});
