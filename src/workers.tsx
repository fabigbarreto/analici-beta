import { useEffect, useState } from 'react';
import { Bot, CircleAlert, CircleCheck, CircleDashed, Clock3, RefreshCw } from 'lucide-react';
import { brDate, brTimeWithSeconds, decimal } from './model';

type WorkerRunStatus = 'success' | 'failed' | 'running' | string;
interface WorkerHealth {
  name: string;
  label: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: WorkerRunStatus | null;
  last_items_found: number | null;
  last_error: string | null;
  last_duration_seconds: number | null;
  runs_24h: number;
  successes_24h: number;
  failures_24h: number;
  average_duration_seconds: number | null;
}

const refreshMs = 15_000;
const date = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? brDate.format(new Date(value)) : 'Sem execuções registradas';
const count = (value: number | null) => value == null ? '—' : decimal.format(value);
function duration(value: number | null) {
  if (value == null) return '—';
  if (value < 60) return decimal.format(value) + ' s';
  const seconds = Math.round(value);
  return Math.floor(seconds / 60) + ' min ' + seconds % 60 + ' s';
}

function RunState({ status }: { status: WorkerRunStatus | null }) {
  if (status === 'running') return <span className="badge delayed"><CircleDashed size={14} aria-hidden="true" />Em execução</span>;
  if (status === 'failed') return <span className="badge offline"><CircleAlert size={14} aria-hidden="true" />Última execução falhou</span>;
  if (status === 'success') return <span className="badge online"><CircleCheck size={14} aria-hidden="true" />Última execução concluída</span>;
  return <span className="badge"><Clock3 size={14} aria-hidden="true" />Sem histórico</span>;
}

function WorkerCard({ worker }: { worker: WorkerHealth }) {
  return (
    <li className="chart worker-card">
      <div>
        <h3 className="worker-name"><Bot size={18} aria-hidden="true" /><span>{worker.label}</span></h3>
        <code className="worker-id">{worker.name}</code>
      </div>
      <div className="worker-result">
        <RunState status={worker.last_status} />
        {worker.last_error && <p className="worker-error">{worker.last_error}</p>}
      </div>
      <dl className="worker-details">
        <div className="worker-last-run">
          <dt>Última execução</dt>
          <dd>{date(worker.last_started_at)}</dd>
        </div>
        <div>
          <dt>Execuções · 24h</dt>
          <dd>{count(worker.runs_24h)}</dd>
        </div>
        <div>
          <dt>Falhas · 24h</dt>
          <dd className={worker.failures_24h ? 'worker-failures' : undefined}>{count(worker.failures_24h)}</dd>
        </div>
        <div>
          <dt>Duração média</dt>
          <dd>{duration(worker.average_duration_seconds)}</dd>
        </div>
      </dl>
    </li>
  );
}

export function Workers({ demo, onExpired }: { demo: boolean; onExpired: (message: string) => void }) {
  const [workers, setWorkers] = useState<WorkerHealth[] | null>(null);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      if (!document.hidden) {
        try {
          const response = await fetch('/mon/api/atlas-executions/workers', {
            cache: 'no-store', credentials: 'same-origin', redirect: 'error',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
          });
          if (response.status === 401) {
            onExpired('Sua sessão expirou. Entre novamente.');
            return;
          }
          if (!response.ok) throw new Error('Não foi possível consultar a saúde dos Workers.');
          const result = await response.json() as { ok: true; workers: WorkerHealth[] };
          if (result.ok !== true || !Array.isArray(result.workers)) throw new Error('Resposta inválida.');
          if (controller.signal.aborted) return;
          setWorkers(result.workers);
          setUpdated(Date.now());
          setError('');
        } catch {
          if (controller.signal.aborted) return;
          setError('Não foi possível atualizar os dados dos Workers. Tente atualizar novamente.');
        }
      }
      timer = setTimeout(() => void update(), refreshMs);
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [demo, onExpired, refresh]);

  const running = workers?.filter((worker) => worker.last_status === 'running').length ?? 0;
  const failed = workers?.reduce((sum, worker) => sum + worker.failures_24h, 0) ?? 0;
  const executions = workers?.reduce((sum, worker) => sum + worker.runs_24h, 0) ?? 0;

  return <>
    <header className="topbar">
      <div><h1>Saúde dos Workers</h1><p>Atividade e resultados recentes dos robôs do Atlas</p></div>
      {!demo && <div className="toolbar">
        {updated != null && <span className="muted">Atualizado às {brTimeWithSeconds.format(updated)}</span>}
        <button type="button" className="outline-button" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={16} aria-hidden="true" />Atualizar
        </button>
      </div>}
    </header>
    <div className="dashboard">
      {demo ? <p className="placeholder">A saúde dos Workers é consultada no histórico do Atlas e fica disponível no painel publicado.</p> : <>
        {error && <p className="notice" role="alert">{error}</p>}
        <section aria-labelledby="workers-overview">
          <div className="section-heading"><h2 id="workers-overview">Visão geral</h2>
            <p className="muted">Dados derivados das execuções registradas nas últimas 24 horas</p></div>
          <dl className="operations-summary">
            <div className="chart"><dt className="muted">Workers monitorados</dt><dd>{count(workers?.length ?? null)}</dd></div>
            <div className="chart"><dt className="muted">Workers com último registro em execução</dt><dd>{count(workers ? running : null)}</dd></div>
            <div className="chart"><dt className="muted">Execuções nas últimas 24h</dt><dd>{count(workers ? executions : null)}</dd></div>
            <div className="chart"><dt className="muted">Falhas nas últimas 24h</dt><dd className={failed ? 'worker-failures' : undefined}>{count(workers ? failed : null)}</dd></div>
          </dl>
        </section>
        <section aria-labelledby="worker-list-title">
          <div className="section-heading"><h2 id="worker-list-title">Estado por Worker</h2>
            <span className="muted">Atualização automática a cada 15 segundos</span></div>
          {workers && workers.length > 0 && (
            <ul className="worker-grid" role="list">
              {workers.map((worker) => <WorkerCard key={worker.name} worker={worker} />)}
            </ul>
          )}
          {!workers && !error && <p className="muted" role="status">Carregando Workers.</p>}
          {workers?.length === 0 && <p className="muted">Nenhum Worker encontrado.</p>}
          <p className="footer">O status reflete a última execução registrada. Este painel não mede heartbeat nem confirma que o processo do Worker está ativo fora de uma execução.</p>
        </section>
      </>}
    </div>
  </>;
}
