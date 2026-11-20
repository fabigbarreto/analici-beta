import { periods, type DashboardData, type NodeStatus, type Period } from './model';

const nodes = [
  { id: 'node-1', label: 'Servidor A', description: 'Controle', status: 'online' },
  { id: 'node-2', label: 'Servidor B', description: 'Processamento', status: 'online' },
  { id: 'node-3', label: 'Servidor C', description: 'Aplicação', status: 'delayed' },
] as const;

export function demoDashboard(period: Period): DashboardData {
  const end = Date.now();
  const { minutes, bucketSeconds } = periods[period];
  const step = bucketSeconds * 1000;
  const slots = minutes * 60 / bucketSeconds;
  const start = end - slots * step;
  const values = (sample: number, node: number) => ({
    cpu: 21 + 13 * node + 8 * Math.sin(sample * .39 + node) + 3 * Math.sin(sample * .89),
    memory: 37 + 14 * node + 3.5 * Math.sin(sample * .22 + node),
  });

  const storage = (sample: number, node: number) => 24 + 11 * node + 0.7 * Math.sin(sample * .09 + node);
  const ageSeconds = (i: number) => i === 2 ? 245 : 4 + 3 * i;
  const lastCollectedAt = (i: number) => new Date(end - ageSeconds(i) * 1000).toISOString();
  const availableSlots = (i: number) => slots - Math.floor(ageSeconds(i) / bucketSeconds);

  return {
    period, bucketMinutes: bucketSeconds / 60, bucketSeconds, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    nodes: nodes.map((node, i) => {
      const sample = availableSlots(i) - 1;
      const storagePercent = storage(sample, i);
      const total = (200 + i * 100) * 1024 ** 3;
      const used = Math.round(total * storagePercent / 100);
      return {
        ...node, status: node.status as NodeStatus,
        collectedAt: lastCollectedAt(i), storageCollectedAt: lastCollectedAt(i),
        storage: storagePercent, storageUsedBytes: used, storageFreeBytes: total - used, storageTotalBytes: total,
        ...values(sample, i),
      };
    }),
    storagePoints: nodes.flatMap((node, i) =>
      Array.from({ length: availableSlots(i) }, (_, sample) => ({
        nodeId: node.id, time: new Date(start + sample * step).toISOString(),
        value: storage(sample, i),
      }))),
    points: nodes.flatMap((node, i) => Array.from({ length: availableSlots(i) }, (_, sample) => ({
      nodeId: node.id, time: new Date(start + sample * step).toISOString(), ...values(sample, i),
    }))),
  };
}
