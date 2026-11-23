import { useMemo } from 'react';
import { extent, linePath, useScrub, useWidth } from './chartKit';
import { fmt1, fmtDayShort, fmtInt, fmtSleep } from '@/lib/format';
import { parseISODate } from '@/lib/dates';

/* ------------------------------------------------------------ Peso */

export interface WeightPoint {
  date: string;
  kg: number;
}

/** Punti piccoli per le pesate, linea spessa per la tendenza, tacca dell'obiettivo a destra. */
export function WeightChart({ points, trend, targetKg }: { points: WeightPoint[]; trend: WeightPoint[]; targetKg?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const h = 150;
  const padL = 4;
  const padR = 36;
  const dates = useMemo(() => Array.from(new Set([...points, ...trend].map((p) => p.date))).sort(), [points, trend]);
  const [lo, hi] = extent([...points.map((p) => p.kg), ...trend.map((p) => p.kg), ...(targetKg ? [targetKg] : [])]);
  const x = (d: string) => {
    const i = dates.indexOf(d);
    return padL + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (w - padL - padR));
  };
  const y = (kg: number) => 8 + (1 - (kg - lo) / (hi - lo)) * (h - 24);
  const { idx, handlers } = useScrub(trend.length, (i) => x(trend[i].date));
  const sel = idx !== null ? trend[idx] : trend[trend.length - 1];
  const selPoint = sel ? points.find((p) => p.date === sel.date) : undefined;

  return (
    <div ref={ref} className="stack-sm">
      <div className="chart-readout">
        <span className="small muted">{sel ? (idx !== null ? fmtDayShort(parseISODate(sel.date)) : 'Tendenza') : ''}</span>
        <span className="num">
          {sel ? fmt1(sel.kg) : 'n.d.'}
          <span className="unit">kg</span>
          {selPoint && idx !== null && <span className="small muted"> pesata {fmt1(selPoint.kg)}</span>}
        </span>
      </div>
      <svg className="chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Andamento del peso" {...handlers}>
        {points.map((p) => (
          <circle key={p.date} cx={x(p.date)} cy={y(p.kg)} r={2} fill="var(--ink-3)" />
        ))}
        {trend.length > 1 && (
          <path
            d={linePath(trend.map((p) => [x(p.date), y(p.kg)]))}
            fill="none"
            stroke="var(--series-weight)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {targetKg !== undefined && (
          <g>
            <line x1={w - padR + 8} x2={w - padR + 20} y1={y(targetKg)} y2={y(targetKg)} stroke="var(--ink)" strokeWidth={2} />
            <text x={w - padR + 22} y={y(targetKg) + 4}>
              {fmt1(targetKg)}
            </text>
          </g>
        )}
        {idx !== null && sel && <line x1={x(sel.date)} x2={x(sel.date)} y1={0} y2={h - 12} stroke="var(--line-strong)" />}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------- HRV */

export interface HrvPoint {
  date: string;
  value?: number;
  low?: number;
  high?: number;
}

/** Fascia della base personale e un punto per notte; sotto la fascia il punto diventa ocra. */
export function HrvBand({ data }: { data: HrvPoint[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const h = 130;
  const vals = data.flatMap((d) => [d.value, d.low, d.high]).filter((n): n is number => n !== undefined);
  const [lo, hi] = extent(vals, 0.15);
  const x = (i: number) => 10 + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (w - 20));
  const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 20);
  const band = data
    .map((d, i) => (d.low !== undefined && d.high !== undefined ? { i, low: d.low, high: d.high } : null))
    .filter((b): b is { i: number; low: number; high: number } => b !== null);
  const bandPath =
    band.length > 1
      ? linePath(band.map((b) => [x(b.i), y(b.high)])) +
        ' ' +
        band
          .slice()
          .reverse()
          .map((b) => `L${x(b.i).toFixed(1)},${y(b.low).toFixed(1)}`)
          .join(' ') +
        ' Z'
      : '';
  const { idx, handlers } = useScrub(data.length, x);
  const sel = idx !== null ? data[idx] : [...data].reverse().find((d) => d.value !== undefined);

  return (
    <div ref={ref} className="stack-sm">
      <div className="chart-readout">
        <span className="small muted">{sel ? fmtDayShort(parseISODate(sel.date)) : ''}</span>
        <span className="num">
          {sel?.value !== undefined ? fmtInt(sel.value) : 'n.d.'}
          <span className="unit">ms</span>
          {sel?.low !== undefined && sel.high !== undefined && (
            <span className="small muted">
              {' '}
              normale {fmtInt(sel.low)}-{fmtInt(sel.high)}
            </span>
          )}
        </span>
      </div>
      <svg className="chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="HRV notturna e intervallo normale" {...handlers}>
        {bandPath && <path d={bandPath} fill="var(--sunken)" stroke="var(--line)" />}
        {data.map((d, i) =>
          d.value === undefined ? null : (
            <circle
              key={d.date}
              cx={x(i)}
              cy={y(d.value)}
              r={idx === i ? 5 : 3.5}
              fill={d.low !== undefined && d.value < d.low ? 'var(--warn)' : 'var(--series-hrv)'}
            />
          ),
        )}
      </svg>
    </div>
  );
}

/* ----------------------------------------------------------- Sonno */

export interface SleepNight {
  date: string;
  start?: string;
  end?: string;
  totalSec?: number;
  deepSec?: number;
  lightSec?: number;
  remSec?: number;
  awakeSec?: number;
}

/**
 * Sette notti impilate, ogni barra va dall'addormentamento al risveglio sull'asse delle ore
 * (allineato sulla mezzanotte). Dentro la barra la composizione delle fasi come bande di altezza diversa.
 */
export function SleepNights({ nights }: { nights: SleepNight[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const rowH = 22;
  const labelW = 64;
  const axisFrom = -4; // 20:00 del giorno prima
  const axisTo = 12; // 12:00
  const span = axisTo - axisFrom;
  const xh = (hour: number) => labelW + ((hour - axisFrom) / span) * (w - labelW - 8);
  const hourOf = (iso: string, nightDate: string) => {
    const d = new Date(iso);
    const base = parseISODate(nightDate);
    base.setHours(0, 0, 0, 0);
    return (d.getTime() - base.getTime()) / 3600000;
  };
  const h = nights.length * rowH + 22;

  return (
    <div ref={ref}>
      <svg className="chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Sonno delle ultime notti">
        {[-2, 0, 2, 4, 6, 8, 10].map((hr) => (
          <g key={hr}>
            <line x1={xh(hr)} x2={xh(hr)} y1={0} y2={h - 18} stroke={hr === 0 ? 'var(--line-strong)' : 'var(--line)'} />
            <text x={xh(hr)} y={h - 4} textAnchor="middle">
              {String((hr + 24) % 24).padStart(2, '0')}
            </text>
          </g>
        ))}
        {nights.map((n, i) => {
          const y0 = i * rowH + 3;
          const label = fmtDayShort(parseISODate(n.date)).replace('.', '');
          if (!n.start || !n.end) {
            return (
              <text key={n.date} x={0} y={y0 + 13}>
                {label} n.d.
              </text>
            );
          }
          const s = hourOf(n.start, n.date);
          const e = hourOf(n.end, n.date);
          const x0 = xh(Math.max(axisFrom, s));
          const x1 = xh(Math.min(axisTo, e));
          const parts: [number | undefined, number, string][] = [
            [n.deepSec, 16, 'var(--series-sleep)'],
            [n.remSec, 12, 'color-mix(in oklch, var(--series-sleep) 70%, var(--bg))'],
            [n.lightSec, 8, 'color-mix(in oklch, var(--series-sleep) 45%, var(--bg))'],
            [n.awakeSec, 4, 'var(--warn)'],
          ];
          const tot = parts.reduce((a, [v]) => a + (v ?? 0), 0);
          let cx = x0;
          return (
            <g key={n.date}>
              <text x={0} y={y0 + 13}>
                {label}
              </text>
              {tot > 0 ? (
                parts.map(([v, ph, fill], k) => {
                  if (!v) return null;
                  const pw = ((x1 - x0) * v) / tot;
                  const rect = <rect key={k} x={cx} y={y0 + (16 - ph) / 2} width={Math.max(0, pw - 1)} height={ph} rx={1.5} fill={fill} />;
                  cx += pw;
                  return rect;
                })
              ) : (
                <rect x={x0} y={y0 + 4} width={x1 - x0} height={8} rx={1.5} fill="var(--series-sleep)" />
              )}
              {n.totalSec !== undefined && (
                <title>
                  {label}: {fmtSleep(n.totalSec)}
                </title>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* --------------------------------------------------- Gradini e1RM */

export interface StepPoint {
  date: string;
  value: number;
  pr?: boolean;
}

/** Miglior serie per seduta come grafico a gradini; i record sono cerchi pieni con la data. */
export function StepChart({ data, unit = 'kg' }: { data: StepPoint[]; unit?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const h = 120;
  const [lo, hi] = extent(data.map((d) => d.value), 0.12);
  const x = (i: number) => 8 + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (w - 16));
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 28);
  const { idx, handlers } = useScrub(data.length, x);
  const sel = idx !== null ? data[idx] : data[data.length - 1];
  let d = '';
  data.forEach((p, i) => {
    if (i === 0) d += `M${x(i)},${y(p.value)}`;
    else d += ` H${x(i)} V${y(p.value)}`;
  });
  return (
    <div ref={ref} className="stack-sm">
      <div className="chart-readout">
        <span className="small muted">{sel ? fmtDayShort(parseISODate(sel.date)) : ''}</span>
        <span className="num">
          {sel ? fmt1(sel.value) : 'n.d.'}
          <span className="unit">{unit}</span>
          {sel?.pr && <span className="tag tag--accent"> record</span>}
        </span>
      </div>
      <svg className="chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Andamento della serie migliore" {...handlers}>
        <path d={d} fill="none" stroke="var(--series-strength)" strokeWidth={2} strokeLinejoin="round" />
        {data.map((p, i) =>
          p.pr ? <circle key={i} cx={x(i)} cy={y(p.value)} r={4.5} fill="var(--accent)" /> : <circle key={i} cx={x(i)} cy={y(p.value)} r={2} fill="var(--ink-2)" />,
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------- Traccia */

/** Traccia GPS disegnata da sola, monocroma con la linea in accento. Niente mappa, niente tile. */
export function RouteLine({ track, height = 220 }: { track: [number, number][]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  if (track.length < 2) return null;
  const lat0 = track.reduce((a, p) => a + p[0], 0) / track.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const pts = track.map(([la, lo]) => [lo * k, -la] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 16;
  const s = Math.min((w - 2 * pad) / (maxX - minX || 1), (height - 2 * pad) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (height - (maxY - minY) * s) / 2;
  const proj = pts.map(([px, py]) => [ox + (px - minX) * s, oy + (py - minY) * s] as [number, number]);
  return (
    <div ref={ref} className="photo-stage" style={{ aspectRatio: 'auto', height }}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Traccia della corsa">
        <path d={linePath(proj)} fill="none" stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={proj[0][0]} cy={proj[0][1]} r={4} fill="var(--ink)" />
        <circle cx={proj[proj.length - 1][0]} cy={proj[proj.length - 1][1]} r={4} fill="var(--surface-raised)" stroke="var(--ink)" strokeWidth={2} />
      </svg>
    </div>
  );
}
