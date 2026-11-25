import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { atlasExecutionsRouter, makeExecutionsReader } from '../server/atlas-executions.ts';

test('Atlas runs and summary use the Analici session and a scoped server request', async (t) => {
  const token = 'A'.repeat(43);
  const calls: string[] = [];
  const runs = { ok: true, runs: [{ id: 'run-1', status: 'failed' }] };
  const summary = { ok: true, workers: [{ nome: 'pncp', label: 'PNCP' }], extracao_ia: { execucoes: 7 } };
  let unauthorized = false;
  const read = makeExecutionsReader('https://atlas.example.test', token, async (target, init) => {
    const outbound = new URL(String(target));
    assert.equal(outbound.origin, 'https://atlas.example.test');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer ' + token);
    assert.equal(headers.get('Cookie'), null);
    calls.push(outbound.pathname + outbound.search);
    if (unauthorized) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Atlas"' } });
    return Response.json(outbound.pathname === '/api/runs' ? runs : summary);
  });

  const app = express();
  app.use('/api/atlas-executions', atlasExecutionsRouter((req) => req.get('Cookie') === 'session=fixture', read));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port + '/api/atlas-executions';
  const anonymous = await fetch(origin + '/runs', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('WWW-Authenticate'), null);
  const headers = { Cookie: 'session=fixture' };
  assert.equal((await fetch(origin + '/runs?collector=pncp&collector=other', { headers })).status, 400);
  assert.equal((await fetch(origin + '/runs?limit=200', { headers })).status, 400);
  assert.equal((await fetch(origin + '/summary?collector=pncp', { headers })).status, 400);
  assert.equal((await fetch(origin + '/pipeline', { headers })).status, 404);
  assert.equal((await fetch(origin + '/runs', { headers, method: 'POST' })).status, 404);
  assert.deepEqual(calls, []);

  const history = await fetch(origin + '/runs?collector=pncp&run_status=failed&since_hours=24', { headers });
  assert.equal(history.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await history.json(), runs);
  assert.deepEqual(await (await fetch(origin + '/summary', { headers })).json(), summary);
  assert.deepEqual(calls, ['/api/runs?collector=pncp&run_status=failed&since_hours=24&limit=100', '/api/executions-summary']);

  unauthorized = true;
  const upstreamAuthFailure = await fetch(origin + '/runs', { headers });
  assert.equal(upstreamAuthFailure.status, 503);
  assert.equal(upstreamAuthFailure.headers.get('WWW-Authenticate'), null);
  assert.ok(!(await upstreamAuthFailure.text()).includes(token));
});
