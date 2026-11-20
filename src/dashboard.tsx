import { useEffect, useState } from 'react';
import { Clock3, Cpu, HardDrive, MemoryStick, RefreshCw, Server, TriangleAlert, X } from 'lucide-react';
import { HistoryChart } from './history-chart';
import { brDate, brTimeWithSeconds, gibibytes, percent, periods, plotColors, type DashboardData, type NodeSnapshot, type Period } from './model';

export class AccessError extends Error {}

type Load = (period: Period, signal: AbortSignal) => Promise<DashboardData>;
type State = { period: Period; data: DashboardData | null; error: string | null; pending: boolean };

const statuses = {
  online: 'Online', delayed: 'Coleta atrasada', offline: 'Sem comunicação', unknown: 'Sem dados',
};

function NodeCard({ node, color, selected, select, storagePage }: {
  node: NodeSnapshot; color: string; selected: boolean; select: () => void; storagePage: boolean;
}) {
  const collectedAt = storagePage ? node.storageCollectedAt : node.collectedAt;
  return (
    <button type="button" className="node-card" aria-pressed={selected}
      style={{ borderTopColor: color }} onClick={select}>
      <span className="card-top">
        <span className="server-icon"><Server size={18} aria-hidden="true" /></span>
        <span className={'badge ' + node.status}>{statuses[node.status]}</span>
      </span>
      <span className="node-name">{node.label}</span>
      {node.description && <span className="node-description">{node.description}</span>}
      {storagePage ? (
        <span className="node-metrics storage-metrics">
          <span><span className="metric-label"><HardDrive size={15} aria-hidden="true" />Disco /</span>
            <strong>{percent(node.storage)}</strong></span>
          <span className="storage-capacity">
            <span><span>Ocupado</span><b>{gibibytes(node.storageUsedBytes)}</b></span>
            <span><span>Disponível</span><b>{gibibytes(node.storageFreeBytes)}</b></span>
            <span><span>Total</span><b>{gibibytes(node.storageTotalBytes)}</b></span>
          </span>
        </span>
      ) : (
        <span className="node-metrics">
          <span><span className="metric-label"><Cpu size={15} aria-hidden="true" />CPU</span><strong>{percent(node.cpu)}</strong></span>
          <span><span className="metric-label"><MemoryStick size={15} aria-hidden="true" />Memória</span><strong>{percent(node.memory)}</strong></span>
        </span>
      )}
      <span className="last-seen"><Clock3 size={14} aria-hidden="true" />
        {collectedAt ? 'Última coleta ' + brDate.format(new Date(collectedAt))
          : storagePage ? 'Sem leitura de disco' : 'Última coleta —'}
      </span>
    </button>
  );
}

export function Dashboard({ load, demo = false, storagePage = false }: { load: Load; demo?: boolean; storagePage?: boolean }) {
  const [period, setPeriod] = useState<Period>('15m');
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ period: '15m', data: null, error: null, pending: true });

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function run(background = false) {
      if (!background) setState((previous) => ({
        period, data: previous.period === period ? previous.data : null,
        error: null, pending: true,
      }));
      try {
        const data = await load(period, abort.signal);
        if (!abort.signal.aborted) setState({ period, data, error: null, pending: false });
      } catch (problem) {
        if (!abort.signal.aborted) setState((previous) => ({
          period, data: problem instanceof AccessError ? null : previous.data,
          error: problem instanceof Error ? problem.message : 'Falha ao consultar a telemetria.',
          pending: false,
        }));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void run(true), periods[period].refreshMs);
      }
    }
    void run();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [load, period, refresh]);

  const data = state.period === period ? state.data : null;
  const pending = state.period !== period || state.pending;
  const error = state.period === period ? state.error : null;
  const selectedNode = data?.nodes.find((node) => node.id === selected);
  const online = data?.nodes.filter((node) => node.status === 'online').length;

  return (
    <>
      <header className="topbar">
        <div><h1>{storagePage ? 'Armazenamento' : 'Monitoramento'}</h1>
          <p>{storagePage ? 'Ocupação do disco principal de cada VPS' : 'Disponibilidade e utilização das VPSs'}</p>
        </div>
        <div className="toolbar">
          {demo && <span className="badge demo">Demonstração · dados fictícios</span>}
          <button type="button" className="outline-button" disabled={pending} onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={16} aria-hidden="true" className={pending ? 'spinning' : undefined} />Atualizar
          </button>
        </div>
      </header>
      <div className="dashboard">
        {error && <div className="notice" role="alert"><TriangleAlert size={18} aria-hidden="true" />
          <span>{error}{data ? ' Exibindo a última consulta disponível.' : ''}</span>
        </div>}
        <section aria-labelledby="overview-title">
          <div className="section-heading">
            <h2 id="overview-title">{storagePage ? 'Ocupação por VPS' : 'Visão geral das VPSs'}</h2>
            <p role="status" className="muted">
              {data ? <><strong>{online} de {data.nodes.length} online</strong><span className="middot">·</span>Atualizado às {brTimeWithSeconds.format(new Date(data.end))}</>
                : pending ? 'Consultando a telemetria…' : 'Consulta indisponível'}
            </p>
          </div>
          {data && <div className="nodes">
            {data.nodes.map((node, index) => <NodeCard key={node.id} node={node} color={plotColors[index]}
              storagePage={storagePage} selected={selected === node.id} select={() => setSelected((current) => current === node.id ? null : node.id)} />)}
          </div>}
          {!data && pending && <div className="nodes" aria-hidden="true">{[1, 2, 3].map((i) => <div key={i} className="skeleton" />)}</div>}
        </section>

        <section aria-labelledby="history-title">
          <div className="section-heading history-heading">
            <div className="history-title">
              <h2 id="history-title">{storagePage ? 'Histórico do disco' : 'Histórico de utilização'}</h2>
              {selectedNode && (
                <button type="button" className="selected-chip" onClick={() => setSelected(null)}
                  aria-label={'Remover filtro de ' + selectedNode.label}>
                  {selectedNode.label}<X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="periods" role="group" aria-label="Período do histórico">
              {(Object.keys(periods) as Period[]).map((value) =>
                <button type="button" key={value} aria-pressed={value === period} onClick={() => setPeriod(value)}>
                  {periods[value].label}
                </button>)}
            </div>
          </div>
          {data ? <div className="charts">
            {storagePage ? (
              <HistoryChart title="Uso de armazenamento" metric="storage" data={data} selected={selectedNode?.id ?? null} />
            ) : (
              <>
                <HistoryChart title="Uso de CPU" metric="cpu" data={data} selected={selectedNode?.id ?? null} />
                <HistoryChart title="Uso de memória" metric="memory" data={data} selected={selectedNode?.id ?? null} />
              </>
            )}
          </div> : <p className="placeholder">{pending ? 'Carregando o histórico…' : 'O histórico aparecerá quando a consulta estiver disponível.'}</p>}
        </section>
        <footer className="footer">Horários de Brasília</footer>
      </div>
    </>
  );
}
