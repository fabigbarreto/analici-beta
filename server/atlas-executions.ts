import { Router, type Request } from 'express';

const source = {
  runs: '/api/runs',
  summary: '/api/executions-summary',
} as const;
type Resource = keyof typeof source;

const filters = {
  collector: /^[a-z0-9_-]{1,64}$/i,
  run_status: /^(success|failed|running)$/,
  since_hours: /^(24|168|720)$/,
} as const;

export function makeExecutionsReader(origin: string, token: string, fetchData = fetch) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Invalid Atlas executions configuration');
  }
  return async (resource: Resource, query: URLSearchParams): Promise<unknown> => {
    const target = new URL(source[resource], base);
    target.search = query.toString();
    const response = await fetchData(target, {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Atlas returned an invalid response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 4 * 1024 * 1024) throw new Error('Atlas response exceeds the maximum size');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data?.ok !== true || (resource === 'runs' ? !Array.isArray(data.runs) : !Array.isArray(data.workers) || !data.extracao_ia)) {
      throw new Error('Atlas returned an invalid result');
    }
    return data;
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
    if (!Object.hasOwn(source, resource)) {
      res.status(404).json({ error: 'Consulta não encontrada.' });
      return;
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(req.query)) {
      if (resource !== 'runs' || !Object.hasOwn(filters, name) || typeof value !== 'string' ||
          !filters[name as keyof typeof filters].test(value)) {
        res.status(400).json({ error: 'Filtro de execução inválido.' });
        return;
      }
      query.set(name, value);
    }
    if (resource === 'runs') query.set('limit', '100');
    if (!read) {
      res.status(503).json({ error: 'O histórico do Atlas está indisponível.' });
      return;
    }
    try {
      res.json(await read(resource as Resource, query));
    } catch {
      res.status(503).json({ error: 'O histórico do Atlas está indisponível. Tente atualizar.' });
    }
  });
  return router;
}
