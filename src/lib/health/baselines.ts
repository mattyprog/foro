/**
 * Basi di confronto personali dai dati di benessere (HRV, FC a riposo, sonno).
 *
 * Idea: ogni numero si confronta con i valori abituali della stessa persona, mai con una tabella.
 * - finestra corta di 7 giorni e finestra lunga di 21 giorni, che per le decisioni finiscono IERI
 *   (un valore di oggi non entra nella propria base di confronto);
 * - media e deviazione standard per descrivere i valori; per l'intervallo normale si usano mediana e MAD
 *   (deviazione assoluta mediana), che non si lasciano trascinare da due o tre giorni storti di fila;
 * - ci vogliono almeno 14 giorni con dati prima di fidarsi: prima l'app "sta ancora imparando";
 * - un dato che manca non conta: non viene mai inventato né sostituito con una media.
 *
 * Le soglie sono valori di partenza prudenti e generali, non ancora verificati su fonti: si cambiano dalle opzioni.
 *
 * Unità: HRV in millisecondi (media notturna), FC a riposo in battiti al minuto, sonno in ore.
 */
import type { ISODate, WellnessDay } from '../../db/types';
import { addDays } from '../training/dates';

export type MetricKey = 'hrv' | 'fcRiposo' | 'sonnoOre';

/** Giorni con dati prima di fidarsi delle basi di confronto (14-21). */
export const BASELINE_MIN_DAYS = 14;
export const SHORT_WINDOW_DAYS = 7;
export const LONG_WINDOW_DAYS = 21;
/** Ampiezza dell'intervallo normale in deviazioni standard robuste (1,4826 x MAD) attorno alla mediana. */
export const RANGE_SD_MULTIPLIER = 1.5;
/** Ampiezza minima dell'intervallo normale, in frazione della mediana: evita allarmi per variazioni minuscole. */
export const RANGE_MIN_WIDTH_PCT = 0.08;
/** Valori minimi nei 21 giorni per calcolare l'intervallo normale. */
export const RANGE_MIN_VALUES = 10;

export type DaysInput = readonly WellnessDay[] | ReadonlyMap<ISODate, WellnessDay>;

/** Valore di una metrica in un giorno; undefined se manca o non è un numero sensato. */
export function metricValue(day: WellnessDay | undefined, metric: MetricKey): number | undefined {
  if (!day) return undefined;
  const raw = metric === 'hrv' ? day.hrvNightAvg : metric === 'fcRiposo' ? day.restingHr : day.sleepSec !== undefined ? day.sleepSec / 3600 : undefined;
  return raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Un giorno per data. Se una data compare due volte (orologio e inserimento manuale) i campi si uniscono. */
export function indexByDate(days: DaysInput): ReadonlyMap<ISODate, WellnessDay> {
  if (days instanceof Map) return days;
  const out = new Map<ISODate, WellnessDay>();
  for (const d of days as readonly WellnessDay[]) {
    const prev = out.get(d.date);
    if (!prev) {
      out.set(d.date, d);
      continue;
    }
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(d)) if (merged[k] === undefined && v !== undefined) merged[k] = v;
    out.set(d.date, merged as unknown as WellnessDay);
  }
  return out;
}

export interface DayValue {
  date: ISODate;
  value: number;
}

/** Valori degli ultimi `length` giorni fino a `endDate` incluso, in ordine di data; i giorni senza dato non compaiono. */
export function valuesInWindow(days: DaysInput, metric: MetricKey, endDate: ISODate, length: number): DayValue[] {
  const idx = indexByDate(days);
  const out: DayValue[] = [];
  for (let i = length - 1; i >= 0; i--) {
    const date = addDays(endDate, -i);
    const value = metricValue(idx.get(date), metric);
    if (value !== undefined) out.push({ date, value });
  }
  return out;
}

export interface Stats {
  n: number;
  mean?: number;
  /** Deviazione standard campionaria (serve almeno 2 valori). */
  sd?: number;
  median?: number;
  /** Deviazione assoluta mediana. */
  mad?: number;
  min?: number;
  max?: number;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function describeValues(values: readonly number[]): Stats {
  const n = values.length;
  if (n === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const med = median(sorted);
  const mad = median(sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
  const stats: Stats = { n, mean, median: med, mad, min: sorted[0], max: sorted[n - 1] };
  if (n >= 2) stats.sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  return stats;
}

export interface NormalRange {
  low: number;
  high: number;
  /** Mediana dei valori. */
  center: number;
}

export interface RangeOptions {
  /** Ampiezza in deviazioni standard robuste (default 1,5). */
  sdMultiplier?: number;
  /** Ampiezza minima in frazione della mediana (default 0,08). */
  minWidthPct?: number;
  /** Valori minimi per calcolarlo (default 10). */
  minValues?: number;
}

/** Intervallo normale personale: mediana più o meno 1,5 deviazioni robuste, largo almeno l'8% della mediana. */
export function normalRange(values: readonly number[], opts: RangeOptions = {}): NormalRange | undefined {
  if (values.length < (opts.minValues ?? RANGE_MIN_VALUES)) return undefined;
  const s = describeValues(values);
  const center = s.median as number;
  const sigma = 1.4826 * (s.mad as number);
  const half = Math.max((opts.sdMultiplier ?? RANGE_SD_MULTIPLIER) * sigma, (opts.minWidthPct ?? RANGE_MIN_WIDTH_PCT) * center);
  return { low: center - half, high: center + half, center };
}

export interface MetricBaseline {
  metric: MetricKey;
  /** Ultimi 7 giorni. */
  last7: Stats;
  /** Ultimi 21 giorni. */
  last21: Stats;
  /** Intervallo normale dai 21 giorni, se ci sono abbastanza valori. */
  range?: NormalRange;
}

export interface Baselines {
  /** Ultimo giorno incluso nelle finestre (ieri, o oggi con `includeToday`). */
  windowEnd: ISODate;
  hrv: MetricBaseline;
  fcRiposo: MetricBaseline;
  sonno: MetricBaseline;
  /** Giorni distinti, nei 21 giorni della finestra, con almeno un dato tra HRV, FC a riposo e sonno. */
  daysWithData: number;
  daysNeeded: number;
  /** Ci sono abbastanza giorni per fidarsi dei confronti personali. */
  ready: boolean;
  daysLeft: number;
}

export interface BaselineOptions extends RangeOptions {
  /** Finestre fino a oggi compreso (per i grafici); di default finiscono ieri. */
  includeToday?: boolean;
  minDays?: number;
}

function metricBaseline(days: DaysInput, metric: MetricKey, end: ISODate, opts: BaselineOptions): MetricBaseline {
  const v21 = valuesInWindow(days, metric, end, LONG_WINDOW_DAYS).map((x) => x.value);
  const v7 = valuesInWindow(days, metric, end, SHORT_WINDOW_DAYS).map((x) => x.value);
  const base: MetricBaseline = { metric, last7: describeValues(v7), last21: describeValues(v21) };
  const range = normalRange(v21, opts);
  if (range) base.range = range;
  return base;
}

/** Medie, intervalli personali e stato di apprendimento a una certa data. */
export function computeBaselines(days: DaysInput, today: ISODate, opts: BaselineOptions = {}): Baselines {
  const idx = indexByDate(days);
  const end = opts.includeToday ? today : addDays(today, -1);
  let daysWithData = 0;
  for (let i = 0; i < LONG_WINDOW_DAYS; i++) {
    const d = idx.get(addDays(end, -i));
    if (metricValue(d, 'hrv') !== undefined || metricValue(d, 'fcRiposo') !== undefined || metricValue(d, 'sonnoOre') !== undefined) {
      daysWithData++;
    }
  }
  const daysNeeded = opts.minDays ?? BASELINE_MIN_DAYS;
  return {
    windowEnd: end,
    hrv: metricBaseline(idx, 'hrv', end, opts),
    fcRiposo: metricBaseline(idx, 'fcRiposo', end, opts),
    sonno: metricBaseline(idx, 'sonnoOre', end, opts),
    daysWithData,
    daysNeeded,
    ready: daysWithData >= daysNeeded,
    daysLeft: Math.max(0, daysNeeded - daysWithData),
  };
}
