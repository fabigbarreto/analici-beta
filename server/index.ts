import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Pool } from 'pg';
import { monitoringRouter, parseNodes, readDashboard, type DashboardOptions } from './monitoring.ts';

function readOptions(): DashboardOptions | null {
  const { FIREBASE_PROJECT_ID, MONITORING_ADMIN_EMAILS, MONITORING_DATABASE_URL, MONITORING_NODES } = process.env;
  if (!FIREBASE_PROJECT_ID || !MONITORING_ADMIN_EMAILS || !MONITORING_DATABASE_URL || !MONITORING_NODES) return null;
  try {
    const nodes = parseNodes(MONITORING_NODES);
    const admins = new Set(MONITORING_ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
    if (!admins.size) return null;
    const url = new URL(MONITORING_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    const auth = getAuth(initializeApp({ projectId: FIREBASE_PROJECT_ID }));
    const pool = new Pool({
      connectionString: url.href, max: 4,
      connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    });
    pool.on('error', () => console.error('Falha na conexão de leitura da telemetria.'));
    return {
      admins,
      verify: (token) => auth.verifyIdToken(token),
      read: (period) => readDashboard(pool, nodes, period),
    };
  } catch {
    console.error('A configuração do monitoramento é inválida.');
    return null;
  }
}

const app = express();
app.disable('x-powered-by');
const options = readOptions();
app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
app.use('/api/monitoring', monitoringRouter(options));
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Rota não encontrada.' }); });

if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = resolve('dist');
  app.use(express.static(dist, { index: false }));
  app.get('/', (_req, res) => { res.sendFile(resolve(dist, 'index.html')); });
}
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
app.listen(port, host, () => console.log('ANALICI Beta iniciado na porta ' + port));
