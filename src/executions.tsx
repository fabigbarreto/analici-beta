import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { brDate, brTimeWithSeconds, executionsLimit, periods, type ExecutionHistory, type Period } from './model';

const refreshMs = 15_000;

export function Executions({ demo, onExpired }: { demo: boolean; onExpired: (message: string) => void }) {
  const [node, setNode] = useState('');
  const [period, setPeriod] = useState<Period>('15m');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ query: string; data: ExecutionHistory } | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);

  const params = new URLSearchParams({ period });
  if (node) params.set('node', node);
  const query = params.toString();

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      if (!document.hidden) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
        try {
          const response = await fetch('/api/monitoring/executions?' + query, { cache: 'no-store', signal });
          if (response.status === 401) {
            if (!controller.signal.aborted) onExpired('Sua sessão expirou. Entre novamente.');
            return;
          }
          if (!response.ok) throw new Error('Histórico indisponível.');
          const data: ExecutionHistory = await response.json();
          if (controller.signal.aborted) return;
          setResult({ query, data });
          setFailedQuery(null);
        } catch {
          if (controller.signal.aborted) return;
          setFailedQuery(query);
        }
      }
      timer = setTimeout(() => void update(), refreshMs);
    }
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [demo, query, refresh, onExpired]);

  const current = result?.query === query ? result.data : null;
  const failed = failedQuery === query;
  const nodes = result?.data.nodes ?? [];
  const nodeLabels = new Map(nodes.map(({ id, label }) => [id, label]));

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Execuções</h1>
          <p>Histórico de coleta dos agentes de monitoramento do Analici</p>
        </div>
        {!demo && <button type="button" className="outline-button" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={16} aria-hidden="true" />Atualizar
        </button>}
      </header>
      <div className="dashboard">
        {demo ? <p className="placeholder">O histórico fica disponível com os dados reais do Monitoramento.</p> : (
          <section className="chart" aria-labelledby="executions-heading">
            <div className="section-heading">
              <h2 id="executions-heading">Lotes de telemetria recebidos</h2>
              {current && <span className="muted">Atualizado às {brTimeWithSeconds.format(new Date(current.updatedAt))}</span>}
            </div>
            <div className="operations-filters">
              <label>VPS
                <select value={node} onChange={(event) => setNode(event.target.value)}>
                  <option value="">Todas as VPSs</option>
                  {nodes.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label>Período
                <select value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
                  {Object.entries(periods).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            {failed && <p className="notice" role="alert">Não foi possível atualizar o histórico de execuções.</p>}
            {!current && !failed && <p className="muted" role="status">Carregando execuções…</p>}
            {current && current.batches.length === 0 && <p className="muted">Nenhum lote recebido no período selecionado.</p>}
            {current && current.batches.length > 0 && (
              <div className="operations-scroll" role="region" aria-label="Tabela de execuções" tabIndex={0}>
                <table className="operations-table">
                  <thead><tr><th scope="col">VPS</th><th scope="col">Recebido em (Brasília)</th></tr></thead>
                  <tbody>{current.batches.map(({ nodeId, receivedAt }, index) => (
                    <tr key={nodeId + receivedAt + index}>
                      <td>{nodeLabels.get(nodeId) ?? nodeId}</td>
                      <td><time dateTime={receivedAt}>{brDate.format(new Date(receivedAt))}</time></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <p className="footer">Até {executionsLimit} lotes por consulta · atualização a cada {refreshMs / 1_000} s</p>
          </section>
        )}
      </div>
    </>
  );
}
