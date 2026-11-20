import { useEffect, useMemo, useRef, useState } from 'react';
import { brTime, percent, plotColors, type DashboardData, type Metric } from './model';

const height = 226;
const frame = { left: 44, right: 11, top: 14, bottom: 25 };

export function HistoryChart({ title, metric, data, selected }: {
  title: string; metric: Metric; data: DashboardData; selected: string | null;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const from = Date.parse(data.start);
  const step = data.bucketMinutes * 60_000;
  const slots = Math.max(1, Math.floor((Date.parse(data.end) - from) / step));
  const plotWidth = Math.max(1, width - frame.left - frame.right);

  const series = useMemo(() => {
    const samples = metric === 'storage'
      ? data.storagePoints
      : data.points.map((point) => ({ nodeId: point.nodeId, time: point.time, value: point[metric] }));
    return data.nodes.map((node, index) => ({
      ...node, color: plotColors[index], values: new Map<number, number>(),
    })).filter((node) => !selected || selected === node.id).map((node) => {
      for (const sample of samples) {
        if (sample.nodeId !== node.id || !Number.isFinite(sample.value)) continue;
        const index = Math.round((Date.parse(sample.time) - from) / step);
        if (index >= 0 && index <= slots) node.values.set(index, sample.value);
      }
      return node;
    });
  }, [data.nodes, data.points, data.storagePoints, metric, selected, from, step, slots]);

  useEffect(() => { setHover(null); }, [data.period, selected]);

  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element || width < 1) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    element.width = width * ratio;
    element.height = height * ratio;
    const context = element.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.font = '12px system-ui, sans-serif';
    context.textBaseline = 'middle';
    context.fillStyle = '#526378';
    const x = (slot: number) => frame.left + (slot / slots) * plotWidth;
    const y = (value: number) => frame.top + (1 - Math.max(0, Math.min(100, value)) / 100) * (height - frame.top - frame.bottom);
    for (const value of [0, 25, 50, 75, 100]) {
      context.beginPath();
      context.strokeStyle = '#e4ebf3';
      context.lineWidth = 1;
      context.moveTo(frame.left, y(value));
      context.lineTo(width - frame.right, y(value));
      context.stroke();
      context.textAlign = 'right';
      context.fillText(value + '%', frame.left - 8, y(value));
    }
    const ticks = width > 410 ? 4 : 2;
    for (let i = 0; i <= ticks; i++) {
      const at = Math.round(slots * i / ticks);
      context.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
      context.fillText(brTime.format(from + at * step), x(at), height - 8);
    }
    for (const entry of series) {
      context.beginPath();
      context.lineWidth = 2;
      context.strokeStyle = entry.color;
      context.fillStyle = entry.color;
      let last: number | undefined;
      for (const [at, value] of [...entry.values].sort(([a], [b]) => a - b)) {
        if (last === undefined || at !== last + 1) context.moveTo(x(at), y(value));
        else context.lineTo(x(at), y(value));
        last = at;
      }
      context.stroke();
      for (const [at, value] of entry.values) {
        if (at === hover || (!entry.values.has(at - 1) && !entry.values.has(at + 1))) {
          context.beginPath();
          context.arc(x(at), y(value), at === hover ? 4 : 3, 0, 2 * Math.PI);
          context.fill();
        }
      }
    }
    if (hover !== null) {
      context.beginPath();
      context.setLineDash([4, 4]);
      context.strokeStyle = '#8193a7';
      context.lineWidth = 1;
      context.moveTo(x(hover), frame.top);
      context.lineTo(x(hover), height - frame.bottom);
      context.stroke();
    }
  }, [width, plotWidth, from, step, slots, series, hover]);

  const hasValues = series.some((entry) => entry.values.size > 0);
  return (
    <figure className={metric === 'storage' ? 'chart chart-wide' : 'chart'}>
      <figcaption><h3>{title}</h3><p>{metric === 'storage' && 'Partição / · '}Média a cada {data.bucketMinutes} min</p></figcaption>
      <div ref={plot} className="plot" tabIndex={hasValues ? 0 : undefined} role="group"
        aria-label={title + '. Use as setas para consultar os horários.'}
        onBlur={() => setHover(null)} onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          if (!hasValues) return;
          const left = event.currentTarget.getBoundingClientRect().left;
          const fraction = (event.clientX - left - frame.left) / plotWidth;
          setHover(fraction >= 0 && fraction <= 1 ? Math.round(fraction * slots) : null);
        }}
        onKeyDown={(event) => {
          if (!hasValues || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setHover((current) => event.key === 'Home' ? 0 : event.key === 'End' ? slots
            : Math.max(0, Math.min(slots, (current ?? slots) + (event.key === 'ArrowLeft' ? -1 : 1))));
        }}>
        <canvas ref={canvas} aria-hidden="true" />
        {!hasValues && <p className="plot-empty">Sem amostras neste período</p>}
      </div>
      <div className="legend" aria-live="polite">
        {hover !== null && <strong>{brTime.format(from + hover * step)}</strong>}
        {series.map((entry) => <span key={entry.id}><i aria-hidden="true" style={{ background: entry.color }} />{entry.label}
          {hover !== null && <strong>{percent(entry.values.get(hover))}</strong>}
        </span>)}
      </div>
    </figure>
  );
}
