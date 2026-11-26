import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { atlasExecutionsRouter, makeExecutionsReader } from './atlas-executions.ts';
import { localAuth } from './auth.ts';
import { monitoringRouter, parseNodes, readDashboard, type DashboardOptions } from './monitoring.ts';

function secret(name: string) {
  const path = process.env[name + '_FILE'];
  return path ? readFileSync(path, 'utf8').trim() : undefined;
}

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

function readAuth() {
  const { BETA_PUBLIC_ORIGIN, BETA_ADMIN_USERNAME } = process.env;
  try {
    const hash = secret('BETA_ADMIN_PASSWORD_HASH');
    if (!BETA_PUBLIC_ORIGIN && !BETA_ADMIN_USERNAME && !hash) return localAuth(null);
    if (!BETA_PUBLIC_ORIGIN || !BETA_ADMIN_USERNAME || !hash) throw new Error('Missing login config');
    const url = new URL(BETA_PUBLIC_ORIGIN);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.origin !== BETA_PUBLIC_ORIGIN ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback &&
          ['127.0.0.1', 'localhost', '::1'].includes(host)))) {
      throw new Error('Invalid origin');
    }
    return localAuth({ origin: url.origin, username: BETA_ADMIN_USERNAME, hash });
  } catch {
    console.error('A configuração do login local é inválida.');
    return localAuth(null);
  }
}

function readOptions(authenticated: DashboardOptions['authenticated']): DashboardOptions | null {
  try {
    const database = secret('MONITORING_DATABASE_URL');
    const { MONITORING_NODES } = process.env;
    if (!database || !MONITORING_NODES) return null;
    const nodes = parseNodes(MONITORING_NODES);
    const url = new URL(database);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database protocol');
    const pool = new Pool({
      connectionString: url.href, max: 4,
      connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    });
    pool.on('error', () => console.error('Falha na conexão de leitura da telemetria.'));
    return { authenticated, read: (period) => readDashboard(pool, nodes, period) };
  } catch {
    console.error('A configuração do monitoramento é inválida.');
    return null;
  }
}

function readAtlasOptions() {
  try {
    const database = secret('ATLAS_EXECUTIONS_DATABASE_URL');
    if (!database) return null;
    const url = new URL(database);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid Atlas database protocol');
    const pool = new Pool({
      connectionString: url.href, max: 2, statement_timeout: 8_000,
      connectionTimeoutMillis: 4_000, idleTimeoutMillis: 30_000,
    });
    pool.on('error', () => console.error('Falha na conexão de leitura das execuções do Atlas.'));
    return makeExecutionsReader(pool);
  } catch {
    console.error('A configuração de leitura das execuções do Atlas é inválida.');
    return null;
  }
}

const app = express();
app.disable('x-powered-by');
if (process.env.BETA_TRUST_PROXY === '1') app.set('trust proxy', 1);
const auth = readAuth();
app.get('/mon/api/health', (_req, res) => { res.json({ status: 'ok' }); });
app.use('/mon/api/auth', auth.router);
app.use('/mon/api/monitoring', monitoringRouter(readOptions(auth.authenticated)));
app.use('/mon/api/atlas-executions', atlasExecutionsRouter(auth.authenticated, readAtlasOptions()));
app.use('/mon/api', (_req, res) => { res.status(404).json({ error: 'Rota não encontrada.' }); });
app.get(['/ocorrencias','/mon/ocorrencias'], (_req, res) => { res.redirect(308, '/mon/execucoes'); });

if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = resolve('dist/client');
  app.use('/mon/assets', express.static(resolve(dist, 'assets'), { index: false, immutable: true, maxAge: '1y' }));
  app.use('/mon', express.static(dist, { index: false }));
  app.get(['/mon/', '/mon/armazenamento', '/mon/execucoes', '/mon/workers'], (_req, res) => { res.sendFile(resolve(dist, 'index.html')); });
}
app.listen(port, host, () => console.log('ANALICI Mon iniciado na porta ' + port));
