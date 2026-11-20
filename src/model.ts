export const periods = {
  '1h': { label: '1 hora', minutes: 60, interval: 1 },
  '6h': { label: '6 horas', minutes: 360, interval: 5 },
  '24h': { label: '24 horas', minutes: 1440, interval: 15 },
} as const;

export type Period = keyof typeof periods;
export type NodeStatus = 'online' | 'delayed' | 'offline' | 'unknown';
export type Metric = 'cpu' | 'memory' | 'storage';

export interface NodeConfig {
  id: string;
  label: string;
  description: string;
}

export interface NodeSnapshot extends NodeConfig {
  status: NodeStatus;
  collectedAt: string | null;
  cpu: number | null;
  memory: number | null;
  storage: number | null;
  storageCollectedAt: string | null;
}

export interface Sample {
  nodeId: string;
  time: string;
  cpu: number;
  memory: number;
}

export interface StorageSample {
  nodeId: string;
  time: string;
  value: number;
}

export interface DashboardData {
  period: Period;
  start: string;
  end: string;
  bucketMinutes: number;
  nodes: NodeSnapshot[];
  points: Sample[];
  storagePoints: StorageSample[];
}

export const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const percent = (value: number | null | undefined) =>
  value == null ? '—' : decimal.format(value) + '%';
export const brTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
});
export const brDate = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
export const plotColors = ['#2e63f0', '#8054be', '#a15416', '#177e76', '#be4568', '#54667b'];
