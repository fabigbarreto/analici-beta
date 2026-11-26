import { Router, type Request } from 'express';
import type { Pool } from 'pg';

const workers = new Map([
  ['discovery_collector', 'Descoberta'],
  ['detail_collector', 'Detalhamento'],
  ['document_collector', 'Lista de Documentos'],
  ['document_download_collector', 'Baixa Documentos'],
  ['package_collector', 'Pacotes'],
  ['format_collector', 'Formato'],
  ['structure_collector', 'Fragmenta PDF'],
  ['content_collector', 'Extrai Conteúdo'],
  ['chunk_collector', 'Fragmenta Conteúdo'],
  ['contract_ai_extraction_collector', 'Espelho documental IA'],
  ['document_classification_collector', 'Classificação Documental'],
  ['contract_consolidation_collector', 'Consolidação do Conhecimento'],
  ['market_classification_worker', 'Classificação de Mercado'],
]);

export const workerDefinitions = Array.from(workers, ([name, label]) => ({ name, label }));

const filterColumns = {
  collector: (param: string) => 'collector_name = ' + param,
  run_status: (param: string) => 'status = ' + param,
  since_hours: (param: string) => 'started_at > now() - make_interval(hours => ' + param + '::int)',
};

const filters = {
  collector: /^[a-z0-9_-]{1,64}$/i,
  run_status: /^(success|failed|running)$/,
  since_hours: /^(24|168|720)$/,
} as const;

type ExecutionFilters = Partial<Record<keyof typeof filters, string>>;

export function makeExecutionsReader(pool: Pick<Pool, 'query'>) {
  return {
    async runs(query: ExecutionFilters) {
      const values: string[] = [];
      const conditions: string[] = [];
      for (const name of Object.keys(filterColumns) as (keyof typeof filterColumns)[]) {
        const value = query[name];
        if (value === undefined) continue;
        values.push(value);
        conditions.push(filterColumns[name]('$' + values.length));
      }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const { rows } = await pool.query<{ collector: string }>(`
        SELECT id, collector_name AS collector, started_at, status, items_found,
               error_message, metrics, parameters ->> 'modality_name' AS modality_name,
               parameters ->> 'modality_code' AS modality_code,
               extract(epoch FROM finished_at - started_at)::float8 AS duration_seconds
        FROM public.collector_run
        ${where}
        ORDER BY started_at DESC, id DESC
        LIMIT 100
      `, values);
      return { ok: true, runs: rows.map((row) => ({ ...row, collector_label: workers.get(row.collector) ?? row.collector })) };
    },

    async summary() {
      const { rows } = await pool.query(`
        WITH covered AS (
          SELECT DISTINCT unnest(input_chunk_ids) AS id FROM public.ai_run
          WHERE status = 'completed' AND expected_schema_version = 'fact_extraction_schema_v1'
        )
        SELECT count(*)::float8 AS execucoes, coalesce(sum(total_tokens), 0)::float8 AS tokens,
               (SELECT count(*)::float8 FROM public.extracted_fact WHERE status = 'extracted') AS fatos_extraidos,
               (SELECT count(*)::float8 FROM public.document_chunk c
                WHERE c.status = 'completed' AND NOT EXISTS (SELECT 1 FROM covered WHERE covered.id = c.id)) AS backlog
        FROM public.ai_run
      `);
      return {
        ok: true,
        workers: Array.from(workers, ([nome, label]) => ({ nome, label })),
        extracao_ia: rows[0],
      };
    },

    async workerHealth() {
      const { rows } = await pool.query(`
        WITH watched AS (
          SELECT * FROM unnest($1::text[], $2::text[]) AS worker(name, label)
        )
        SELECT worker.name, worker.label,
               latest.started_at AS last_started_at, latest.finished_at AS last_finished_at,
               latest.status AS last_status, latest.items_found AS last_items_found,
               latest.error_message AS last_error,
               latest.duration_seconds AS last_duration_seconds,
               coalesce(stats.runs_24h, 0)::int AS runs_24h,
               coalesce(stats.successes_24h, 0)::int AS successes_24h,
               coalesce(stats.failures_24h, 0)::int AS failures_24h,
               stats.average_duration_seconds
        FROM watched AS worker
        LEFT JOIN LATERAL (
          SELECT started_at, finished_at, status, items_found, error_message,
                 extract(epoch FROM finished_at - started_at)::float8 AS duration_seconds
          FROM public.collector_run
          WHERE collector_name = worker.name
          ORDER BY started_at DESC, id DESC LIMIT 1
        ) AS latest ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS runs_24h,
                 count(*) FILTER (WHERE status = 'success') AS successes_24h,
                 count(*) FILTER (WHERE status = 'failed') AS failures_24h,
                 avg(extract(epoch FROM finished_at - started_at))::float8 AS average_duration_seconds
          FROM public.collector_run
          WHERE collector_name = worker.name AND started_at >= now() - interval '24 hours'
        ) AS stats ON true
        ORDER BY worker.label
      `, [workerDefinitions.map(({ name }) => name), workerDefinitions.map(({ label }) => label)]);
      return { ok: true, workers: rows };
    },
  };
}

export function atlasExecutionsRouter(
  authenticated: (request: Request) => boolean,
  read: ReturnType<typeof makeExecutionsReader> | null,
) {
  const router = Router();
  router.get('/:resource', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!authenticated(req)) {
      res.status(401).json({ error: 'Entre no Analici para consultar as execuções.' });
      return;
    }
    const { resource } = req.params;
    if (resource !== 'runs' && resource !== 'summary' && resource !== 'workers') {
      res.status(404).json({ error: 'Consulta não encontrada.' });
      return;
    }
    const query: ExecutionFilters = {};
    for (const [name, value] of Object.entries(req.query)) {
      if (resource !== 'runs' || !Object.hasOwn(filters, name) || typeof value !== 'string' ||
          !filters[name as keyof typeof filters].test(value)) {
        res.status(400).json({ error: 'Filtro de execução inválido.' });
        return;
      }
      query[name as keyof typeof filters] = value;
    }
    if (!read) {
      res.status(503).json({ error: 'O histórico do Atlas está indisponível.' });
      return;
    }
    try {
      res.json(await (resource === 'runs' ? read.runs(query)
        : resource === 'workers' ? read.workerHealth() : read.summary()));
    } catch {
      res.status(503).json({ error: 'O histórico do Atlas está indisponível. Tente atualizar.' });
    }
  });
  return router;
}
