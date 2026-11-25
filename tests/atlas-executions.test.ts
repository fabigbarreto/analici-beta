import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { atlasExecutionsRouter, makeExecutionsReader } from '../server/atlas-executions.ts';

test('the Analici session protects the Atlas execution history', async (t) => {
  const calls: unknown[] = [];
  const history = { ok: true, runs: [{ id: 'run-1', status: 'failed', collector: 'discovery_collector', collector_label: 'Descoberta' }] };
  let unavailable = false;
  const app = express();
  app.use('/api/atlas-executions', atlasExecutionsRouter((req) => req.get('Cookie') === 'session=fixture', {
    runs: async (filters) => {
      calls.push(filters);
      if (unavailable) throw new Error('private connection details');
      return history;
    },
    summary: async () => ({ ok: true, workers: [], extracao_ia: { execucoes: 0 } }),
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port + '/api/atlas-executions';
  const anonymous = await fetch(origin + '/runs');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('WWW-Authenticate'), null);
  const headers = { Cookie: 'session=fixture' };
  assert.equal((await fetch(origin + '/runs?collector=pncp&collector=other', { headers })).status, 400);
  assert.equal((await fetch(origin + '/runs?limit=200', { headers })).status, 400);
  assert.equal((await fetch(origin + '/summary?collector=pncp', { headers })).status, 400);
  assert.equal((await fetch(origin + '/pipeline', { headers })).status, 404);
  assert.equal((await fetch(origin + '/runs', { headers, method: 'POST' })).status, 404);
  assert.deepEqual(calls, []);
  const valid = await fetch(origin + '/runs?collector=pncp&run_status=failed&since_hours=24', { headers });
  assert.equal(valid.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await valid.json(), history);
  assert.deepEqual(calls, [{ collector: 'pncp', run_status: 'failed', since_hours: '24' }]);
  unavailable = true;
  const failed = await fetch(origin + '/runs', { headers });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('WWW-Authenticate'), null);
  assert.doesNotMatch(await failed.text(), /private connection details/);
});

test('Atlas rows, filters and IA totals work with only the dedicated column grants', {
  skip: !process.env.ATLAS_EXECUTIONS_TEST_DATABASE_URL,
}, async (t) => {
  const url = new URL(process.env.ATLAS_EXECUTIONS_TEST_DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/executions_test');
  const pool = new Pool({ connectionString: url.href });
  t.after(() => pool.end());
  await pool.query(`
    CREATE ROLE beta_execution_reader;
    CREATE TABLE public.collector_run (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collector_name varchar(100), started_at timestamptz,
      finished_at timestamptz, status varchar(20), items_found integer, error_message text,
      metrics jsonb, parameters jsonb
    );
    CREATE TABLE public.ai_run (total_tokens integer, input_chunk_ids uuid[], status varchar(30), expected_schema_version varchar(100));
    CREATE TABLE public.extracted_fact (status varchar(20));
    CREATE TABLE public.document_chunk (id uuid, status varchar(20), text text);
    INSERT INTO public.collector_run (collector_name,started_at,finished_at,status,items_found,error_message,metrics,parameters)
    VALUES
      ('discovery_collector', now() - interval '1 hour', now() - interval '1 hour' + interval '5 seconds',
       'failed', 0, 'Falha de teste', '{"failed":1}', '{"modality_code":6,"modality_name":"Pregão eletrônico"}'),
      ('other_worker', now() - interval '2 days', null, 'running', null, null, null, null);
    INSERT INTO public.document_chunk VALUES
      ('00000000-0000-0000-0000-000000000001', 'completed', 'restricted'),
      ('00000000-0000-0000-0000-000000000002', 'completed', 'restricted'),
      ('00000000-0000-0000-0000-000000000003', 'pending', 'restricted');
    INSERT INTO public.ai_run VALUES
      (10, ARRAY['00000000-0000-0000-0000-000000000001']::uuid[], 'completed', 'fact_extraction_schema_v1'),
      (20, ARRAY['00000000-0000-0000-0000-000000000002']::uuid[], 'failed', 'fact_extraction_schema_v1'),
      (null, null, 'running', null);
    INSERT INTO public.extracted_fact VALUES ('extracted'), ('extracted'), ('rejected');
  `);
  const grants = await readFile('deploy/atlas-executions-grants.sql', 'utf8');
  await pool.query(grants.replaceAll(':"reader"', 'beta_execution_reader'));
  const client = await pool.connect();
  try {
    await client.query('SET ROLE beta_execution_reader');
    const reader = makeExecutionsReader(client);
    const history = await reader.runs({});
    assert.deepEqual(history.runs.map(({ collector_label }) => collector_label), ['Descoberta', 'other_worker']);
    const filtered = await reader.runs({ collector: 'discovery_collector', run_status: 'failed', since_hours: '24' });
    assert.equal(filtered.runs.length, 1);
    assert.deepEqual(filtered.runs[0], history.runs[0]);
    assert.deepEqual(await reader.runs({ since_hours: '24', run_status: 'running' }), { ok: true, runs: [] });
    const summary = await reader.summary();
    assert.deepEqual(summary.extracao_ia, { execucoes: 3, tokens: 30, fatos_extraidos: 2, backlog: 1 });
    assert.ok(summary.workers.some(({ nome }) => nome === 'discovery_collector'));
    await assert.rejects(client.query('SELECT text FROM public.document_chunk'), { code: '42501' });
    await assert.rejects(client.query("UPDATE public.collector_run SET status = 'success'"), { code: '42501' });
  } finally {
    await client.query('RESET ROLE').finally(() => client.release());
  }
});
