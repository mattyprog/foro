/**
 * 1RM stimato, tonnellaggio, record personali e storico per esercizio.
 *
 * Regole:
 * - e1RM con la formula di Epley: kg x (1 + ripetizioni / 30); con 1 ripetizione vale il carico stesso;
 * - oltre 12 ripetizioni la stima è poco affidabile: viene segnalata e non genera record di e1RM;
 * - il riscaldamento e le serie non fatte non contano mai;
 * - per i record serve uno storico: alla prima volta non c'è nulla con cui confrontarsi.
 */
import type { GymSession, ISODate, LoggedSet } from '../../db/types';
import { fmtKg, fmtNum } from './format';
import { getExercise, type ExerciseSource } from './library';
import type { PersistedGymSession } from './types';

export const E1RM_MAX_RELIABLE_REPS = 12;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Serie fatta e allenante (non riscaldamento). */
export function isWorkingSet(s: Pick<LoggedSet, 'done' | 'type'>): boolean {
  return s.done && s.type !== 'riscaldamento';
}

/** 1RM stimato con Epley, arrotondato a 2 decimali. Undefined senza carico o senza ripetizioni. */
export function e1rm(kg: number, reps: number): number | undefined {
  if (!Number.isFinite(kg) || !Number.isFinite(reps) || kg <= 0 || reps < 1) return undefined;
  if (reps === 1) return r2(kg);
  return r2(kg * (1 + reps / 30));
}

export interface E1rmEstimate {
  value: number;
  /** Falso oltre 12 ripetizioni. */
  reliable: boolean;
  warning?: string;
}

export function estimateE1rm(kg: number, reps: number): E1rmEstimate | undefined {
  const value = e1rm(kg, reps);
  if (value === undefined) return undefined;
  if (reps <= E1RM_MAX_RELIABLE_REPS) return { value, reliable: true };
  return {
    value,
    reliable: false,
    warning: `Stima poco affidabile: con più di ${E1RM_MAX_RELIABLE_REPS} ripetizioni il 1RM si calcola male.`,
  };
}

export interface TonnageOptions {
  includeWarmup?: boolean;
  exerciseId?: string;
}

/** Somma di kg x ripetizioni delle serie fatte, di default senza riscaldamento. */
export function tonnage(sets: readonly LoggedSet[], opts: TonnageOptions = {}): number {
  let total = 0;
  for (const s of sets) {
    if (!s.done) continue;
    if (!opts.includeWarmup && s.type === 'riscaldamento') continue;
    if (opts.exerciseId && s.exerciseId !== opts.exerciseId) continue;
    total += s.kg * s.reps;
  }
  return total;
}

export function sessionTonnage(session: Pick<GymSession, 'sets'>, opts: TonnageOptions = {}): number {
  return tonnage(session.sets, opts);
}

/* --------------------------------------------------------------------- Record */

export interface RecordOptions {
  /** Macchina assistita: i kg sono l'aiuto, meno è meglio. */
  assisted?: boolean;
  /** Esercizio a tempo: le ripetizioni sono secondi, niente e1RM. */
  timed?: boolean;
}

export type RecordKind = 'carico' | 'ripetizioni' | 'e1rm';

export interface RecordHit {
  tipo: RecordKind;
  exerciseId: string;
  kg: number;
  reps: number;
  /** kg per il carico, ripetizioni (o secondi) per le ripetizioni, kg stimati per l'e1RM. */
  valore: number;
  precedente: number;
}

/** Il meglio dello storico di un esercizio: tutto ciò che serve per riconoscere un record. */
export interface RecordBaseline {
  /** Serie allenanti considerate: 0 vuol dire nessuno storico. */
  count: number;
  /** Carico massimo (con macchine assistite: l'aiuto minimo). */
  bestKg?: number;
  /** Migliori ripetizioni per ogni carico, con il carico come chiave testuale ("62.5"). */
  bestRepsByKg: Record<string, number>;
  bestE1rm?: number;
}

const kgKey = (kg: number) => String(r2(kg));

export function buildBaseline(sets: readonly LoggedSet[], opts: RecordOptions = {}): RecordBaseline {
  const base: RecordBaseline = { count: 0, bestRepsByKg: {} };
  for (const s of sets) {
    if (!isWorkingSet(s) || !(s.reps > 0)) continue;
    base.count++;
    const k = kgKey(s.kg);
    base.bestRepsByKg[k] = Math.max(base.bestRepsByKg[k] ?? 0, s.reps);
    if (opts.assisted) {
      base.bestKg = base.bestKg === undefined ? s.kg : Math.min(base.bestKg, s.kg);
    } else if (s.kg > 0) {
      base.bestKg = base.bestKg === undefined ? s.kg : Math.max(base.bestKg, s.kg);
    }
    if (!opts.assisted && !opts.timed && s.reps <= E1RM_MAX_RELIABLE_REPS) {
      const e = e1rm(s.kg, s.reps);
      if (e !== undefined) base.bestE1rm = Math.max(base.bestE1rm ?? 0, e);
    }
  }
  return base;
}

function isBaseline(x: readonly LoggedSet[] | RecordBaseline): x is RecordBaseline {
  return !Array.isArray(x);
}

/**
 * Record ottenuti da `sets` rispetto a `previous` (serie passate o base già calcolata):
 * carico massimo, ripetizioni a parità di carico, e1RM. Al più uno per tipo.
 */
export function detectRecords(
  exerciseId: string,
  sets: readonly LoggedSet[],
  previous: readonly LoggedSet[] | RecordBaseline,
  opts: RecordOptions = {},
): RecordHit[] {
  const base = isBaseline(previous)
    ? previous
    : buildBaseline(previous.filter((s) => s.exerciseId === exerciseId), opts);
  if (base.count === 0) return [];
  const cur = sets.filter((s) => s.exerciseId === exerciseId && isWorkingSet(s) && s.reps > 0);
  if (cur.length === 0) return [];
  const hits: RecordHit[] = [];

  // carico massimo (con macchine assistite: meno aiuto)
  let top: LoggedSet | undefined;
  for (const s of cur) {
    if (!opts.assisted && !(s.kg > 0)) continue;
    const better = !top || (opts.assisted ? s.kg < top.kg : s.kg > top.kg) || (s.kg === top.kg && s.reps > top.reps);
    if (better) top = s;
  }
  if (top) {
    const improves =
      base.bestKg === undefined ? !opts.assisted : opts.assisted ? top.kg < base.bestKg : top.kg > base.bestKg;
    if (improves) {
      hits.push({
        tipo: 'carico',
        exerciseId,
        kg: top.kg,
        reps: top.reps,
        valore: top.kg,
        precedente: base.bestKg ?? 0,
      });
    }
  }

  // ripetizioni a parità di carico: il carico più alto (o l'aiuto più basso) in cui si è migliorato
  const bestNow = new Map<string, LoggedSet>();
  for (const s of cur) {
    const k = kgKey(s.kg);
    const prev = bestNow.get(k);
    if (!prev || s.reps > prev.reps) bestNow.set(k, s);
  }
  let repHit: RecordHit | undefined;
  for (const [k, s] of bestNow) {
    const before = base.bestRepsByKg[k];
    if (before === undefined || s.reps <= before) continue;
    const better = !repHit || (opts.assisted ? s.kg < repHit.kg : s.kg > repHit.kg);
    if (better) {
      repHit = { tipo: 'ripetizioni', exerciseId, kg: s.kg, reps: s.reps, valore: s.reps, precedente: before };
    }
  }
  if (repHit) hits.push(repHit);

  // 1RM stimato: solo da serie affidabili
  if (!opts.assisted && !opts.timed && base.bestE1rm !== undefined) {
    let bestSet: LoggedSet | undefined;
    let bestVal = 0;
    for (const s of cur) {
      if (s.reps > E1RM_MAX_RELIABLE_REPS) continue;
      const e = e1rm(s.kg, s.reps);
      if (e !== undefined && e > bestVal) {
        bestVal = e;
        bestSet = s;
      }
    }
    if (bestSet && bestVal > base.bestE1rm) {
      hits.push({
        tipo: 'e1rm',
        exerciseId,
        kg: bestSet.kg,
        reps: bestSet.reps,
        valore: bestVal,
        precedente: base.bestE1rm,
      });
    }
  }
  return hits;
}

/** Record di un'intera seduta rispetto alle sedute passate (concluse). */
export function detectSessionRecords(
  sessionSets: readonly LoggedSet[],
  history: readonly GymSession[],
  source?: ExerciseSource,
): RecordHit[] {
  const ids = [...new Set(sessionSets.map((s) => s.exerciseId))];
  const past = history.filter((h) => h.endedAt);
  const hits: RecordHit[] = [];
  for (const id of ids) {
    const ex = getExercise(id, source);
    const opts: RecordOptions = { assisted: ex?.assisted === true, timed: ex?.timed === true };
    const previous = past.flatMap((h) => h.sets.filter((s) => s.exerciseId === id));
    hits.push(...detectRecords(id, sessionSets, previous, opts));
  }
  return hits;
}

/** Riga in italiano per un record. */
export function describeRecord(hit: RecordHit, exerciseName: string, opts: RecordOptions = {}): string {
  switch (hit.tipo) {
    case 'carico':
      return opts.assisted
        ? `${exerciseName}: meno aiuto, ${fmtKg(hit.kg)} (prima ${fmtKg(hit.precedente)})`
        : `${exerciseName}: nuovo massimo di carico, ${fmtKg(hit.kg)} (prima ${fmtKg(hit.precedente)})`;
    case 'ripetizioni':
      if (opts.timed) return `${exerciseName}: ${fmtNum(hit.reps)} secondi (prima ${fmtNum(hit.precedente)})`;
      return hit.kg > 0
        ? `${exerciseName}: ${fmtNum(hit.reps)} ripetizioni con ${fmtKg(hit.kg)} (prima ${fmtNum(hit.precedente)})`
        : `${exerciseName}: ${fmtNum(hit.reps)} ripetizioni a corpo libero (prima ${fmtNum(hit.precedente)})`;
    case 'e1rm':
      return `${exerciseName}: 1RM stimato ${fmtKg(hit.valore)} (prima ${fmtKg(hit.precedente)})`;
  }
}

/* ---------------------------------------------------------------- Storico */

export interface HistoryOptions {
  /** Quante sedute al massimo (default 5). */
  limit?: number;
  /** Include anche le sedute non chiuse (default no). */
  includeUnfinished?: boolean;
  /** Modi di seduta da escludere (default: solo lo scarico, che ha carichi ridotti di proposito). */
  excludeModes?: readonly string[];
}

const modeOf = (s: GymSession): string | undefined => (s as PersistedGymSession).foro?.modo;

function byRecency(a: GymSession, b: GymSession): number {
  return a.date === b.date ? (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0) : a.date < b.date ? 1 : -1;
}

export interface HistoryEntry {
  /** Data della seduta (assente se lo storico arriva già senza date). */
  date?: ISODate;
  /** Serie fatte di quell'esercizio, riscaldamento compreso. */
  sets: LoggedSet[];
}

/**
 * Come `historyForExercise`, ma con la data di ogni seduta (serve per "ultima volta: 12 novembre").
 */
export function historyEntriesForExercise(
  sessions: readonly GymSession[],
  exerciseId: string,
  opts: HistoryOptions = {},
): HistoryEntry[] {
  const exclude = opts.excludeModes ?? ['scarico'];
  const out: HistoryEntry[] = [];
  for (const s of [...sessions].sort(byRecency)) {
    if (!opts.includeUnfinished && !s.endedAt) continue;
    const mode = modeOf(s);
    if (mode && exclude.includes(mode)) continue;
    const sets = s.sets.filter((x) => x.exerciseId === exerciseId && x.done);
    if (!sets.some(isWorkingSet)) continue;
    out.push({ date: s.date, sets });
    if (out.length >= (opts.limit ?? 5)) break;
  }
  return out;
}

/**
 * Serie fatte di un esercizio, una lista per seduta dalla più recente alla più vecchia.
 * Una seduta entra solo se ha almeno una serie allenante fatta di quell'esercizio.
 */
export function historyForExercise(
  sessions: readonly GymSession[],
  exerciseId: string,
  opts: HistoryOptions = {},
): LoggedSet[][] {
  return historyEntriesForExercise(sessions, exerciseId, opts).map((e) => e.sets);
}

/* -------------------------------------------------------- Grafico a gradini */

export interface E1rmPoint {
  date: ISODate;
  sessionId?: number;
  /** Serie che ha dato il miglior e1RM della seduta. */
  kg: number;
  reps: number;
  e1rm: number;
  /** Falso se la seduta ha solo serie oltre 12 ripetizioni. */
  reliable: boolean;
  /** Massimo progressivo delle stime affidabili fino a questa seduta (la linea a gradini). */
  best?: number;
  /** Vero se questa seduta supera il massimo precedente. */
  isRecord: boolean;
}

export interface E1rmSeriesOptions {
  /** Include solo sedute chiuse (default no: contano le serie fatte anche in una seduta aperta). */
  onlyFinished?: boolean;
}

/** Per ogni seduta la serie col miglior e1RM, in ordine di data, con il massimo progressivo per il grafico a gradini. */
export function e1rmSeries(
  sessions: readonly GymSession[],
  exerciseId: string,
  opts: E1rmSeriesOptions = {},
): E1rmPoint[] {
  const ordered = [...sessions].sort((a, b) => -byRecency(a, b));
  const points: E1rmPoint[] = [];
  let running: number | undefined;
  for (const s of ordered) {
    if (opts.onlyFinished && !s.endedAt) continue;
    let bestReliable: { set: LoggedSet; value: number } | undefined;
    let bestAny: { set: LoggedSet; value: number } | undefined;
    for (const x of s.sets) {
      if (x.exerciseId !== exerciseId || !isWorkingSet(x)) continue;
      const v = e1rm(x.kg, x.reps);
      if (v === undefined) continue;
      if (!bestAny || v > bestAny.value) bestAny = { set: x, value: v };
      if (x.reps <= E1RM_MAX_RELIABLE_REPS && (!bestReliable || v > bestReliable.value)) {
        bestReliable = { set: x, value: v };
      }
    }
    const pick = bestReliable ?? bestAny;
    if (!pick) continue;
    const reliable = bestReliable !== undefined;
    const isRecord = reliable && running !== undefined && pick.value > running;
    if (reliable) running = Math.max(running ?? 0, pick.value);
    const point: E1rmPoint = {
      date: s.date,
      kg: pick.set.kg,
      reps: pick.set.reps,
      e1rm: pick.value,
      reliable,
      best: running,
      isRecord,
    };
    if (s.id !== undefined) point.sessionId = s.id;
    points.push(point);
  }
  return points;
}
