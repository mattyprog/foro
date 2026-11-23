/**
 * Adattamento settimanale delle calorie (proposta del lunedi).
 *
 * 1. Tendenza del peso: media mobile esponenziale delle pesate (alfa 0,1).
 * 2. Dispendio reale = media delle kcal registrate nella finestra (14-21 giorni)
 *    - variazione della tendenza (kg) x 7700 / giorni.
 * 3. Nuovo dispendio = 0,7 x precedente + 0,3 x reale.
 * 4. Sicurezza: almeno 5 pesate e 5 giorni registrati negli ultimi 7, la prima settimana non conta,
 *    al massimo +-150 kcal a settimana, mai sotto il metabolismo a riposo.
 * La proposta si riferisce al lunedi della settimana di asOf e usa i dati fino alla domenica prima.
 */
import type { Experience, FoodLogEntry, Goal, ISODate, WeightEntry } from '@/db/types';
import { roundTo } from './nutrients';
import { GOAL_ADJUSTMENT } from './targets';

export interface DailyIntake {
  date: ISODate;
  kcal: number;
}

export interface TrendPoint {
  date: ISODate;
  kg: number;
  trend: number;
}

export interface CheckInInput {
  /** Data di riferimento: vale la proposta del lunedi della sua settimana. */
  asOf: ISODate;
  weights: WeightEntry[];
  /** Kcal registrate per giorno (vedi dailyIntake). */
  intake: DailyIntake[];
  /** Dispendio in uso finora (ultima proposta accettata o stima di computeTargets). */
  previousTdee: number;
  /** Metabolismo a riposo (computeTargets().bmr.value). */
  bmr: number;
  goal: Goal;
  experience?: Experience;
  /** Surplus o deficit come frazione; default quello dell'obiettivo. */
  adjustmentPct?: number;
  /** Obiettivo calorico in uso, per mostrare la differenza. */
  currentTargetKcal?: number;
  /** Primo giorno di uso; default il piu tardi tra prima pesata e primo giorno registrato. */
  startDate?: ISODate;
}

export type RateStatus = 'sotto' | 'in linea' | 'sopra';

export interface CheckInProposal {
  status: 'proposta';
  monday: ISODate;
  window: { from: ISODate; to: ISODate; days: number };
  avgKcal: number;
  /** Giorni registrati completi nella finestra. */
  loggedDays: number;
  /** Pesate nella finestra. */
  weighIns: number;
  trendFromKg: number;
  trendToKg: number;
  trendChangeKg: number;
  ratePctPerMonth: number;
  /** Solo in massa: ritmo rispetto all'obiettivo. */
  rateStatus?: RateStatus;
  targetRatePct?: [number, number];
  measuredTdee: number;
  previousTdee: number;
  newTdee: number;
  kcalTarget: number;
  deltaKcal: number;
  limitedBy: ('max-150' | 'bmr')[];
  /** Motivazione in una riga. */
  reason: string;
}

export interface CheckInInsufficient {
  status: 'dati-insufficienti';
  monday: ISODate;
  missing: string[];
  reason: string;
}

export type CheckInResult = CheckInProposal | CheckInInsufficient;

export const KCAL_PER_KG = 7700;
export const TREND_ALPHA = 0.1;
export const MAX_WEEKLY_CHANGE = 150;
const DAYS_PER_MONTH = 30.44;

/* ------------------------------------------------------------ date (UTC, senza ora legale) */

function toUtc(d: ISODate): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

export function addDays(d: ISODate, n: number): ISODate {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function mondayOf(d: ISODate): ISODate {
  const dow = new Date(toUtc(d)).getUTCDay(); // 0 = domenica
  return addDays(d, -((dow + 6) % 7));
}

/* ------------------------------------------------------------ dati */

/** Tendenza del peso: una pesata per giorno (media se doppie), alfa applicato a ogni pesata. */
export function weightTrend(weights: WeightEntry[], alpha = TREND_ALPHA): TrendPoint[] {
  const byDate = new Map<ISODate, number[]>();
  for (const w of weights) {
    if (!Number.isFinite(w.kg) || w.kg <= 0) continue;
    const arr = byDate.get(w.date) ?? [];
    arr.push(w.kg);
    byDate.set(w.date, arr);
  }
  const dates = [...byDate.keys()].sort();
  const out: TrendPoint[] = [];
  let trend = 0;
  dates.forEach((date, i) => {
    const vals = byDate.get(date)!;
    const kg = vals.reduce((a, b) => a + b, 0) / vals.length;
    trend = i === 0 ? kg : trend + alpha * (kg - trend);
    out.push({ date, kg, trend });
  });
  return out;
}

/** Kcal registrate per giorno dal diario. */
export function dailyIntake(log: FoodLogEntry[]): DailyIntake[] {
  const byDate = new Map<ISODate, number>();
  for (const e of log) {
    const k = e.items.reduce((a, it) => a + (Number.isFinite(it.nutrients.kcal) ? it.nutrients.kcal : 0), 0);
    byDate.set(e.date, (byDate.get(e.date) ?? 0) + k);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, kcal]) => ({ date, kcal }));
}

const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const signed = (x: number, f: Intl.NumberFormat) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${f.format(Math.abs(x))}`;

/* ------------------------------------------------------------ proposta */

export function weeklyCheckIn(input: CheckInInput): CheckInResult {
  const monday = mondayOf(input.asOf);
  const end = addDays(monday, -1);
  const weights = input.weights.filter((w) => w.date <= end);
  const intake = new Map<ISODate, number>();
  for (const d of input.intake) if (d.date <= end) intake.set(d.date, (intake.get(d.date) ?? 0) + d.kcal);

  const insufficient = (missing: string[]): CheckInInsufficient => ({
    status: 'dati-insufficienti',
    monday,
    missing,
    reason: `Obiettivo invariato questa settimana: ${missing[0].charAt(0).toLowerCase()}${missing[0].slice(1)}`,
  });

  const trend = weightTrend(weights);
  const intakeDates = [...intake.keys()].sort();
  if (trend.length === 0 || intakeDates.length === 0) {
    const missing: string[] = [];
    if (trend.length === 0) missing.push('Non ci sono pesate: pesati al mattino, a digiuno, almeno 5 volte a settimana.');
    if (intakeDates.length === 0) missing.push('Non ci sono giorni registrati: registra tutto quello che mangi almeno 5 giorni a settimana.');
    return insufficient(missing);
  }

  const startDate = input.startDate ?? (trend[0].date > intakeDates[0] ? trend[0].date : intakeDates[0]);
  const eligibleStart = addDays(startDate, 7);
  const earliest = addDays(end, -20);
  const windowStart = eligibleStart > earliest ? eligibleStart : earliest;
  const windowDays = diffDays(windowStart, end) + 1;
  const minDayKcal = 0.5 * input.bmr;
  const missing: string[] = [];

  if (windowDays < 14) {
    missing.push(
      `La prima settimana non conta (acqua e glicogeno si assestano): servono almeno 14 giorni di dati dopo, finora ${Math.max(0, windowDays)}.`,
    );
  }

  const last7 = addDays(end, -6);
  const weighIns7 = trend.filter((p) => p.date >= last7).length;
  if (weighIns7 < 5) missing.push(`Negli ultimi 7 giorni ci sono ${weighIns7} pesate: ne servono almeno 5.`);

  let complete7 = 0;
  let incomplete7 = 0;
  for (let i = 0; i < 7; i++) {
    const k = intake.get(addDays(last7, i));
    if (k === undefined || k <= 0) continue;
    if (k >= minDayKcal) complete7++;
    else incomplete7++;
  }
  if (complete7 < 5) {
    missing.push(
      `Negli ultimi 7 giorni ci sono ${complete7} giorni registrati completi: ne servono almeno 5` +
        (incomplete7 > 0 ? ` (${incomplete7} giorni sotto ${nf0.format(minDayKcal)} kcal sono considerati incompleti).` : '.'),
    );
  }

  let completeW = 0;
  let sumW = 0;
  if (windowDays >= 14) {
    for (let i = 0; i < windowDays; i++) {
      const k = intake.get(addDays(windowStart, i));
      if (k !== undefined && k >= minDayKcal) {
        completeW++;
        sumW += k;
      }
    }
    const need = Math.ceil((windowDays * 5) / 7);
    if (completeW < need) {
      missing.push(`Negli ultimi ${windowDays} giorni ci sono ${completeW} giorni registrati completi: ne servono almeno ${need}.`);
    }
  }

  // tendenza alla fine del giorno prima della finestra e alla fine della finestra
  const before = addDays(windowStart, -1);
  const at = (d: ISODate) => {
    let p: TrendPoint | undefined;
    for (const q of trend) if (q.date <= d) p = q;
    return p;
  };
  let from = at(before);
  let span = windowDays;
  if (!from) {
    from = trend.find((p) => p.date >= windowStart);
    span = from ? diffDays(from.date, end) : 0;
    if (span < 7) missing.push('Le pesate sono iniziate da troppo poco: serve almeno una settimana di pesate nella finestra.');
  }
  const to = at(end);

  if (missing.length > 0 || !from || !to) return insufficient(missing.length ? missing : ['Pesate insufficienti.']);

  const avgKcal = sumW / completeW;
  const dT = to.trend - from.trend;
  const measured = avgKcal - (dT * KCAL_PER_KG) / span;
  const prev = input.previousTdee;
  let next = 0.7 * prev + 0.3 * measured;
  const limitedBy: CheckInProposal['limitedBy'] = [];
  if (next > prev + MAX_WEEKLY_CHANGE) {
    next = prev + MAX_WEEKLY_CHANGE;
    limitedBy.push('max-150');
  } else if (next < prev - MAX_WEEKLY_CHANGE) {
    next = prev - MAX_WEEKLY_CHANGE;
    limitedBy.push('max-150');
  }
  if (next < input.bmr) {
    next = input.bmr;
    limitedBy.push('bmr');
  }

  const adj = input.adjustmentPct ?? GOAL_ADJUSTMENT[input.goal][2];
  const target = Math.max(input.bmr, next * (1 + adj));
  const prevTarget = input.currentTargetKcal ?? Math.max(input.bmr, prev * (1 + adj));
  const kcalTarget = roundTo(target, 0);
  const deltaKcal = kcalTarget - roundTo(prevTarget, 0);
  const rate = (dT / from.trend) * (DAYS_PER_MONTH / span) * 100;

  let rateStatus: RateStatus | undefined;
  let targetRatePct: [number, number] | undefined;
  let rateTxt = '';
  if (input.goal === 'massa') {
    const beginner = !input.experience || input.experience === 'nuovo' || input.experience === 'meno-6-mesi';
    targetRatePct = beginner ? [0.5, 1] : [0.25, 0.75];
    const [lo, hi] = targetRatePct;
    rateStatus = rate < lo ? 'sotto' : rate > hi ? 'sopra' : 'in linea';
    const range = `${nf1.format(lo).replace(',0', '')}-${nf1.format(hi).replace(',0', '')}%`;
    rateTxt = rateStatus === 'in linea' ? `, in linea con l'obiettivo ${range}` : `, ${rateStatus} l'obiettivo ${range}`;
  }

  const limits =
    (limitedBy.includes('max-150') ? ' Variazione limitata a 150 kcal a settimana.' : '') +
    (limitedBy.includes('bmr') ? ' Non si scende sotto il metabolismo a riposo.' : '');
  const reason =
    `Tendenza del peso ${signed(dT, nf1)} kg in ${span} giorni (${signed(rate, nf1)}% al mese${rateTxt}) ` +
    `con ${nf0.format(avgKcal)} kcal in media: dispendio stimato ${nf0.format(next)} kcal, ` +
    `obiettivo ${nf0.format(kcalTarget)} kcal (${deltaKcal === 0 ? 'invariato' : signed(deltaKcal, nf0)}).${limits}`;

  return {
    status: 'proposta',
    monday,
    window: { from: windowStart, to: end, days: windowDays },
    avgKcal: roundTo(avgKcal, 0),
    loggedDays: completeW,
    weighIns: trend.filter((p) => p.date >= windowStart).length,
    trendFromKg: from.trend,
    trendToKg: to.trend,
    trendChangeKg: dT,
    ratePctPerMonth: rate,
    rateStatus,
    targetRatePct,
    measuredTdee: roundTo(measured, 0),
    previousTdee: prev,
    newTdee: roundTo(next, 0),
    kcalTarget,
    deltaKcal,
    limitedBy,
    reason,
  };
}
