import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { monitoringRouter, parseNodes, readDashboard } from '../server/monitoring.ts';
import type { DashboardData, Period } from '../src/model.ts';

const empty = (period: Period): DashboardData => ({
  period, bucketMinutes: 1, start: '', end: '', nodes: [], points: [],
});

test('only a verified and authorized account can read the dashboard', async (t) => {
  let reads = 0;
  let fail = false;
  const app = express();
  app.use('/unconfigured', monitoringRouter(null));
  app.use('/api', monitoringRouter({
    admins: new Set(['operator@example.test']),
    verify: async (token) => {
      if (token === 'invalid') throw new Error('invalid');
      return {
        email: token === 'external' ? 'external@example.test' : 'operator@example.test',
        email_verified: token !== 'unverified',
      };
    },
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
  const call = (url: string, token?: string) => fetch(base + url, {
    headers: token ? { Authorization: 'Bearer ' + token } : undefined,
  });
  assert.equal((await call('/unconfigured/dashboard')).status, 503);
  assert.equal((await call('/api/dashboard')).status, 401);
  assert.equal((await call('/api/dashboard', 'invalid')).status, 401);
  assert.equal((await call('/api/dashboard', 'unverified')).status, 403);
  assert.equal((await call('/api/dashboard', 'external')).status, 403);
  assert.equal((await call('/api/dashboard?period=constructor', 'verified')).status, 400);
  assert.equal((await call('/api/dashboard?period=1h&period=24h', 'verified')).status, 400);
  assert.equal(reads, 0);

  const response = await call('/api/dashboard?period=6h', 'verified');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), empty('6h'));
  fail = true;
  const error = await call('/api/dashboard', 'verified');
  assert.equal(error.status, 503);
  assert.doesNotMatch(await error.text(), /private connection detail/);
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
