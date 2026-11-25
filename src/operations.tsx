import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { brDate, brTimeWithSeconds, decimal } from './model';

const statuses = {
  success: { label: 'Concluída', badge: 'online' },
  failed: { label: 'Falhou', badge: 'offline' },
  running: { label: 'Em execução', badge: 'delayed' },
} as const;
const periods = [['24', 'Últimas 24 horas'], ['168', 'Últimos 7 dias'], ['720', 'Últimos 30 dias']] as const;
const refreshMs = 15_000;
const summaryRefreshMs = 120_000;

interface Run {
  id: string;
  started_at: string;
  collector: string;
  collector_label: string;
  modality_code: string | null;
  modality_name: string | null;
  status: string;
  items_found: number | null;
  duration_seconds: number | null;
  error_message: string | null;
  metrics: Record<string, unknown> | null;
}

interface Pipeline {
  ok: true;
  workers: { nome: string; label: string }[];
  extracao_ia: {
    execucoes: number | null;
    fatos_extraidos: number | null;
    tokens: number | null;
    backlog: number | null;
  };
}

interface OperationsState {
  query: string;
  runs: Run[] | null;
  updated: number | null;
  problem?: 'atlas-login' | 'history';
}

class AtlasLoginRequired extends Error {}

async function readAtlas<T extends { ok: true }>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    headers: { Accept: 'application/json' }, signal,
  });
  if (response.status === 401) throw new AtlasLoginRequired();
  if (!response.ok) throw new Error('Falha na consulta ao Atlas.');
  const data = await response.json() as T;
  if (data?.ok !== true) throw new Error('Falha na consulta ao Atlas.');
  return data;
}

const quantity = (value: number | null) => value == null ? '—' : decimal.format(value);
const runDate = (value: string) => Number.isFinite(Date.parse(value)) ? brDate.format(new Date(value)) : '—';

function duration(value: number | null) {
  if (value == null) return '—';
  if (value < 60) return quantity(value) + ' s';
  const seconds = Math.round(value);
  return Math.floor(seconds / 60) + ' min ' + seconds % 60 + ' s';
}

function details(run: Run) {
  if (run.error_message) return run.error_message;
  return Object.entries(run.metrics ?? {})
    .filter((metric): metric is [string, number] => typeof metric[1] === 'number' && metric[1] > 0)
    .slice(0, 3)
    .map(([name, value]) => name.replaceAll('_', ' ') + ' ' + quantity(value))
    .join(' · ') || '—';
}

function RunTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <p className="muted">Nenhuma execução encontrada para estes filtros.</p>;
  return (
    <div className="operations-scroll" role="region" aria-label="Tabela de execuções" tabIndex={0}>
      <table className="operations-table">
        <thead><tr>
          {['ID', 'Início (Brasília)', 'Robô', 'Modalidade', 'Status', 'Processados', 'Duração', 'Detalhe'].map((label) =>
            <th key={label} scope="col">{label}</th>)}
        </tr></thead>
        <tbody>{runs.map((run) => {
          const status = Object.hasOwn(statuses, run.status) ? statuses[run.status as keyof typeof statuses] : undefined;
          return (
            <tr key={run.id}>
              <td><code title={run.id}>{run.id.slice(0, 8)}</code></td>
              <td>{runDate(run.started_at)}</td>
              <td>{run.collector_label || run.collector}</td>
              <td>{[run.modality_code, run.modality_name].filter(Boolean).join(' · ') || '—'}</td>
              <td><span className={'badge ' + (status?.badge ?? '')}>
                {status?.label ?? run.status}
              </span></td>
              <td>{quantity(run.items_found)}</td>
              <td>{duration(run.duration_seconds)}</td>
              <td className="operations-detail">{details(run)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function Operations({ demo, onExpired }: { demo: boolean; onExpired: (message: string) => void }) {
  const [collector, setCollector] = useState('');
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<OperationsState | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>();
  const [knownWorkers, setKnownWorkers] = useState<Map<string, string>>(() => new Map());

  const params = new URLSearchParams({ limit: '100' });
  if (collector) params.set('collector', collector);
  if (status) params.set('run_status', status);
  if (period) params.set('since_hours', period);
  const query = params.toString();

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      if (!document.hidden) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
        try {
          const session = await fetch('/api/auth/session', { cache: 'no-store', signal });
          if (!session.ok) throw new Error('Sessão indisponível.');
          const { authenticated } = await session.json();
          if (authenticated !== true) {
            if (!controller.signal.aborted) onExpired('Sua sessão expirou. Entre novamente.');
            return;
          }
          const history = await readAtlas<{ ok: true; runs: Run[] }>('/atlas/api/runs?' + query, signal);
          if (!Array.isArray(history.runs)) throw new Error('Histórico inválido.');
          if (controller.signal.aborted) return;
          setState({ query, runs: history.runs, updated: Date.now() });
          setKnownWorkers((previous) => {
            const next = new Map(previous);
            for (const run of history.runs) next.set(run.collector, run.collector_label || run.collector);
            return next;
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof AtlasLoginRequired) {
            setState({ query, runs: null, updated: null, problem: 'atlas-login' });
            setPipeline(undefined);
            setKnownWorkers(new Map());
            return;
          }
          setState((previous) => ({
            query,
            runs: previous?.query === query ? previous.runs : null,
            updated: previous?.query === query ? previous.updated : null,
            problem: 'history',
          }));
        }
      }
      timer = setTimeout(() => void update(), refreshMs);
    }
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [demo, onExpired, query, refresh]);

  const historyLoaded = state?.runs != null;
  useEffect(() => {
    if (!historyLoaded) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function updateSummary() {
      if (!document.hidden) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
        try {
          const result = await readAtlas<Pipeline>('/atlas/api/pipeline', signal);
          if (!Array.isArray(result.workers) || !result.extracao_ia) throw new Error('Resumo inválido.');
          if (controller.signal.aborted) return;
          setPipeline(result);
        } catch {
          if (!controller.signal.aborted) setPipeline(null);
          return;
        }
      }
      timer = setTimeout(() => void updateSummary(), summaryRefreshMs);
    }
    void updateSummary();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [historyLoaded, refresh]);

  const current = state?.query === query ? state : null;
  const summary = pipeline?.extracao_ia;
  const workers = new Map(knownWorkers);
  for (const worker of pipeline?.workers ?? []) workers.set(worker.nome, worker.label);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Ocorrências e Execuções</h1>
          <p>Histórico de coleta e processamento do Atlas</p>
        </div>
        {!demo && (
          <div className="toolbar operations-actions">
            <a className="outline-button" href="/atlas/operacao" target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />Abrir Atlas Web
            </a>
            <button type="button" className="outline-button" onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCw size={16} aria-hidden="true" />Atualizar
            </button>
          </div>
        )}
      </header>
      <div className="dashboard">
        {demo ? <p className="placeholder">O histórico fica disponível no painel publicado com acesso ao Atlas.</p> : <>
          {current?.problem === 'atlas-login' && (
            <p className="notice" role="status">Use Abrir Atlas Web para entrar. Depois volte e clique em Atualizar.</p>
          )}
          {current?.problem === 'history' &&
            <p className="notice" role="alert">Não foi possível atualizar o histórico. Se precisar entrar no Atlas, use Abrir Atlas Web e volte para atualizar.</p>}
          {summary && (
            <section aria-labelledby="ai-summary">
              <div className="section-heading"><h2 id="ai-summary">Extração por IA</h2></div>
              <dl className="operations-summary">
                {([
                  ['Execuções', summary.execucoes],
                  ['Fatos extraídos', summary.fatos_extraidos],
                  ['Tokens processados', summary.tokens],
                  ['Pendências', summary.backlog],
                ] as const).map(([label, value]) => (
                  <div className="chart" key={label}><dt className="muted">{label}</dt><dd>{quantity(value)}</dd></div>
                ))}
              </dl>
            </section>
          )}
          {historyLoaded && pipeline === null && <p className="footer">Resumo de IA temporariamente indisponível.</p>}
          <section className="chart" aria-labelledby="runs-heading">
            <div className="section-heading">
              <h2 id="runs-heading">Histórico de execuções</h2>
              {current?.updated != null &&
                <span className="muted">Atualizado às {brTimeWithSeconds.format(current.updated)}</span>}
            </div>
            <div className="operations-filters">
              <label>Robô
                <select value={collector} onChange={(event) => setCollector(event.target.value)}>
                  <option value="">Todos os robôs</option>
                  {collector && !workers.has(collector) &&
                    <option value={collector}>{collector}</option>}
                  {Array.from(workers, ([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label>Status
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">Todos os status</option>
                  {Object.entries(statuses).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>Período
                <select value={period} onChange={(event) => setPeriod(event.target.value)}>
                  <option value="">Todo o período</option>
                  {periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            {current?.runs ? <RunTable runs={current.runs} />
              : !current && <p className="muted" role="status">Carregando execuções…</p>}
            <p className="footer">Até 100 execuções por consulta · atualização a cada 15 s</p>
          </section>
        </>}
      </div>
    </>
  );
}
