import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { periods, type DashboardData, type NodeConfig, type NodeStatus, type Period } from '../src/model.ts';

export interface DashboardOptions {
  authenticated: (request: Request) => boolean;
  read: (period: Period) => Promise<DashboardData>;
}

export function monitoringRouter(options: DashboardOptions | null) {
  const router = Router();
  router.get('/dashboard', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!options) {
      res.status(503).json({ error: 'O acesso à telemetria ainda não está configurado.' });
      return;
    }
    if (!options.authenticated(req)) {
      res.status(401).json({ error: 'Entre para acessar o monitoramento.' });
      return;
    }
    const period = req.query.period ?? '1h';
    if (typeof period !== 'string' || !Object.hasOwn(periods, period)) {
      res.status(400).json({ error: 'Selecione 1h, 6h ou 24h.' });
      return;
    }
    try {
      res.json(await options.read(period as Period));
    } catch {
      res.status(503).json({ error: 'O histórico de telemetria está indisponível.' });
    }
  });
  return router;
}

export function parseNodes(raw: string): NodeConfig[] {
  const nodes: unknown = JSON.parse(raw);
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 6) throw new Error('Invalid nodes');
  const seen = new Set<string>();
  return nodes.map((node: Partial<NodeConfig> | null) => {
    if (!node || typeof node.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(node.id) || seen.has(node.id) ||
      typeof node.label !== 'string' || !node.label.trim() || node.label.length > 48 ||
      typeof node.description !== 'string' || node.description.length > 96) {
      throw new Error('Invalid node');
    }
    seen.add(node.id);
    return { id: node.id, label: node.label.trim(), description: node.description.trim() };
  });
}

function status(received: Date | null, now: Date): NodeStatus {
  if (!received) return 'unknown';
  const age = now.getTime() - received.getTime();
  return age <= 180_000 ? 'online' : age <= 600_000 ? 'delayed' : 'offline';
}

interface SnapshotRow {
  node_id: string;
  received_at: Date | null;
  collected_at: Date | null;
  cpu: number | null;
  memory: number | null;
  storage: number | null;
  storage_collected_at: Date | null;
}

interface SeriesRow {
  node_id: string;
  bucket: Date;
  cpu: number;
  memory: number;
}

export async function readDashboard(
  pool: Pick<Pool, 'connect'>, nodes: NodeConfig[], period: Period, end = new Date(),
): Promise<DashboardData> {
  const { minutes, interval } = periods[period];
  const start = new Date(end.getTime() - minutes * 60_000);
  const ids = nodes.map(({ id }) => id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const { rows: snapshot } = await client.query<SnapshotRow>(`
      SELECT watched.node_id, batch.received_at, host.collected_at,
             host.cpu_percent::float8 AS cpu, host.ram_percent::float8 AS memory,
             disk.percent::float8 AS storage, disk.collected_at AS storage_collected_at
      FROM unnest($1::text[]) AS watched(node_id)
      LEFT JOIN LATERAL (
        SELECT received_at FROM telemetry.metric_batches
        WHERE node_id = watched.node_id ORDER BY received_at DESC LIMIT 1
      ) AS batch ON true
      LEFT JOIN LATERAL (
        SELECT collected_at, cpu_percent, ram_percent FROM telemetry.host_metrics
        WHERE node_id = watched.node_id ORDER BY collected_at DESC LIMIT 1
      ) AS host ON true
      LEFT JOIN LATERAL (
        SELECT collected_at, percent FROM telemetry.disk_metrics
        WHERE node_id = watched.node_id AND mountpoint = '/' AND collected_at <= $2
        ORDER BY collected_at DESC LIMIT 1
      ) AS disk ON true
    `, [ids, end]);
    const { rows: samples } = await client.query<SeriesRow>(`
      SELECT node_id, date_bin($4::interval, collected_at, $2::timestamptz) AS bucket,
             avg(cpu_percent)::float8 AS cpu, avg(ram_percent)::float8 AS memory
      FROM telemetry.host_metrics
      WHERE node_id = ANY($1::text[]) AND collected_at >= $2 AND collected_at <= $3
      GROUP BY node_id, bucket ORDER BY bucket, node_id
    `, [ids, start, end, interval + ' minutes']);
    const { rows: storage } = await client.query<{ node_id: string; bucket: Date; value: number }>(`
      SELECT node_id, date_bin($4::interval, collected_at, $2::timestamptz) AS bucket,
             avg(percent)::float8 AS value
      FROM telemetry.disk_metrics
      WHERE node_id = ANY($1::text[]) AND mountpoint = '/'
        AND collected_at >= $2 AND collected_at <= $3
      GROUP BY node_id, bucket ORDER BY bucket, node_id
    `, [ids, start, end, interval + ' minutes']);
    await client.query('COMMIT');
    const byId = new Map(snapshot.map((row) => [row.node_id, row]));
    return {
      period, start: start.toISOString(), end: end.toISOString(), bucketMinutes: interval,
      nodes: nodes.map((node) => {
        const row = byId.get(node.id);
        return {
          ...node,
          status: status(row?.received_at ?? null, end),
          collectedAt: row?.collected_at?.toISOString() ?? null,
          cpu: row?.cpu ?? null, memory: row?.memory ?? null,
          storage: row?.storage ?? null, storageCollectedAt: row?.storage_collected_at?.toISOString() ?? null,
        };
      }),
      storagePoints: storage.map((row) => ({
        nodeId: row.node_id, time: row.bucket.toISOString(), value: row.value,
      })),
      points: samples.map((row) => ({
        nodeId: row.node_id, time: row.bucket.toISOString(), cpu: row.cpu, memory: row.memory,
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
