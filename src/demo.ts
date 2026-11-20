import { periods, type DashboardData, type NodeStatus, type Period } from './model';

const nodes = [
  { id: 'node-1', label: 'Servidor A', description: 'Controle', status: 'online' },
  { id: 'node-2', label: 'Servidor B', description: 'Processamento', status: 'online' },
  { id: 'node-3', label: 'Servidor C', description: 'Aplicação', status: 'delayed' },
] as const;

export function demoDashboard(period: Period): DashboardData {
  const end = Date.now();
  const { minutes, interval } = periods[period];
  const start = end - minutes * 60_000;
  const values = (sample: number, node: number) => ({
    cpu: 21 + 13 * node + 8 * Math.sin(sample * .39 + node) + 3 * Math.sin(sample * .89),
    memory: 37 + 14 * node + 3.5 * Math.sin(sample * .22 + node),
  });

  const storage = (sample: number, node: number) => 24 + 11 * node + 0.7 * Math.sin(sample * .09 + node);
  const lastCollectedAt = (i: number) => new Date(end - (i === 2 ? 245_000 : 41_000 + 25_000 * i)).toISOString();

  return {
    period, bucketMinutes: interval, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    nodes: nodes.map((node, i) => ({
      ...node, status: node.status as NodeStatus,
      collectedAt: lastCollectedAt(i), storageCollectedAt: lastCollectedAt(i),
      storage: storage(Math.floor(minutes / interval) - 2, i),
      ...values(Math.floor(minutes / interval) - 2, i),
    })),
    storagePoints: nodes.flatMap((node, i) =>
      Array.from({ length: minutes / interval - (i === 2 ? Math.ceil(4 / interval) : 0) }, (_, sample) => ({
        nodeId: node.id, time: new Date(start + sample * interval * 60_000).toISOString(),
        value: storage(sample, i),
      }))),
    points: nodes.flatMap((node, i) => Array.from({ length: minutes / interval }, (_, sample) => ({
      nodeId: node.id, time: new Date(start + sample * interval * 60_000).toISOString(), ...values(sample, i),
    })).filter((_point, sample) => i !== 2 || sample < minutes / interval - Math.ceil(4 / interval))),
  };
}
