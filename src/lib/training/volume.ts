/**
 * Volume settimanale per muscolo: serie impegnative (riscaldamento escluso).
 * Un muscolo primario vale 1 serie, un muscolo secondario 0,5.
 *
 * Confronto con l'obiettivo: 10-12 serie a settimana per muscolo è "ok", sotto "basso", sopra "alto".
 * Il minimo efficace è 4 serie: sotto quella soglia `belowMinimum` è vero.
 *
 * Il volume si calcola da due fonti, tenute separate:
 * - `weeklyVolumeFromSessions`: le serie fatte nelle sedute registrate;
 * - `plannedWeeklyVolume`: le serie previste da una scheda (A/B in rotazione contano per la loro quota di settimana).
 */
import type { GymSession, ISODate, LoggedSet, MuscleGroup, WorkoutTemplate } from '../../db/types';
import { addDays, startOfWeek } from './dates';
import { MUSCLES, toLookup, type ExerciseSource } from './library';

export const PRIMARY_WEIGHT = 1;
export const SECONDARY_WEIGHT = 0.5;
export const TARGET_MIN_SETS = 10;
export const TARGET_MAX_SETS = 12;
export const MIN_EFFECTIVE_SETS = 4;

export type VolumeLevel = 'basso' | 'ok' | 'alto';

export interface VolumeLimits {
  /** Soglia inferiore dell'intervallo "ok" (default 10). */
  min?: number;
  /** Soglia superiore dell'intervallo "ok" (default 12). */
  max?: number;
}

export function classifyVolume(sets: number, limits: VolumeLimits = {}): VolumeLevel {
  const min = limits.min ?? TARGET_MIN_SETS;
  const max = limits.max ?? TARGET_MAX_SETS;
  if (sets < min) return 'basso';
  if (sets > max) return 'alto';
  return 'ok';
}

export function emptyByMuscle(): Record<MuscleGroup, number> {
  return Object.fromEntries(MUSCLES.map((m) => [m, 0])) as Record<MuscleGroup, number>;
}

export interface CountOptions {
  /** Ignora le serie con RPE registrato sotto questa soglia (le serie senza RPE contano). */
  minRpe?: number;
}

export interface SetCount {
  byMuscle: Record<MuscleGroup, number>;
  /** Serie allenanti contate (non pesate per muscolo). */
  totalSets: number;
  /** Esercizi non presenti nella libreria: le loro serie non sono contate. */
  unknownExercises: string[];
}

type CountableSet = Pick<LoggedSet, 'exerciseId'> & Partial<Pick<LoggedSet, 'type' | 'done' | 'rpe'>>;

/** Conta le serie fatte e allenanti per muscolo. */
export function countSets(sets: readonly CountableSet[], source?: ExerciseSource, opts: CountOptions = {}): SetCount {
  const lookup = toLookup(source);
  const byMuscle = emptyByMuscle();
  const unknown = new Set<string>();
  let total = 0;
  for (const s of sets) {
    if (s.done === false) continue;
    if (s.type === 'riscaldamento') continue;
    if (opts.minRpe !== undefined && s.rpe !== undefined && s.rpe < opts.minRpe) continue;
    const ex = lookup.get(s.exerciseId);
    if (!ex) {
      unknown.add(s.exerciseId);
      continue;
    }
    total++;
    for (const m of ex.primary) byMuscle[m] += PRIMARY_WEIGHT;
    for (const m of ex.secondary) byMuscle[m] += SECONDARY_WEIGHT;
  }
  return { byMuscle, totalSets: total, unknownExercises: [...unknown] };
}

export function setsByMuscle(
  sets: readonly CountableSet[],
  source?: ExerciseSource,
  opts: CountOptions = {},
): Record<MuscleGroup, number> {
  return countSets(sets, source, opts).byMuscle;
}

export interface MuscleVolume {
  muscle: MuscleGroup;
  sets: number;
  level: VolumeLevel;
  /** Sotto le 4 serie a settimana: meno del minimo efficace. */
  belowMinimum: boolean;
}

export interface VolumeReport {
  /** Lunedì della settimana (solo per le sedute registrate). */
  weekStart?: ISODate;
  byMuscle: Record<MuscleGroup, number>;
  /** I 14 muscoli, nell'ordine di `MUSCLES`, con il livello. */
  muscles: MuscleVolume[];
  totalSets: number;
  unknownExercises: string[];
}

export interface VolumeOptions extends VolumeLimits, CountOptions {
  /** Libreria da usare al posto di quella inclusa. */
  exercises?: ExerciseSource;
}

function toReport(count: SetCount, opts: VolumeOptions, weekStart?: ISODate): VolumeReport {
  const report: VolumeReport = {
    byMuscle: count.byMuscle,
    muscles: MUSCLES.map((muscle) => ({
      muscle,
      sets: count.byMuscle[muscle],
      level: classifyVolume(count.byMuscle[muscle], opts),
      belowMinimum: count.byMuscle[muscle] < MIN_EFFECTIVE_SETS,
    })),
    totalSets: count.totalSets,
    unknownExercises: count.unknownExercises,
  };
  if (weekStart) report.weekStart = weekStart;
  return report;
}

/** Volume della settimana (da lunedì a domenica) che contiene `weekOf`, dalle sedute registrate. */
export function weeklyVolumeFromSessions(
  sessions: readonly GymSession[],
  weekOf: ISODate,
  opts: VolumeOptions = {},
): VolumeReport {
  const start = startOfWeek(weekOf);
  const end = addDays(start, 6);
  const sets = sessions.filter((s) => s.date >= start && s.date <= end).flatMap((s) => s.sets);
  return toReport(countSets(sets, opts.exercises, opts), opts, start);
}

/** Una riga per settimana, dalla più vecchia, finendo con la settimana che contiene `lastWeekOf`. */
export function weeklyVolumeSeries(
  sessions: readonly GymSession[],
  lastWeekOf: ISODate,
  weeks: number,
  opts: VolumeOptions = {},
): VolumeReport[] {
  const last = startOfWeek(lastWeekOf);
  const out: VolumeReport[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(weeklyVolumeFromSessions(sessions, addDays(last, -7 * i), opts));
  return out;
}

/* ------------------------------------------------------------ Scheda pianificata */

export interface PlannedVolumeOptions extends VolumeOptions {
  /** Sedute di pesi a settimana (default 3): serve per le schede A/B in rotazione. */
  gymDaysPerWeek?: number;
  /** Volte a settimana per ogni seduta (id seduta -> numero): ha la precedenza sul calcolo. */
  occurrences?: Record<string, number>;
}

/**
 * Quante volte a settimana capita ogni seduta di pesi. Le sedute con un giorno fisso valgono 1;
 * quelle in rotazione si dividono i giorni di palestra rimasti (A/B tre volte a settimana: 1,5 ciascuna).
 */
export function templateOccurrences(
  templates: readonly WorkoutTemplate[],
  opts: Pick<PlannedVolumeOptions, 'gymDaysPerWeek' | 'occurrences'> = {},
): Record<string, number> {
  const strength = templates.filter((t) => t.kind === 'forza');
  const fixed = strength.filter((t) => t.dayOfWeek !== undefined);
  const rotating = strength.filter((t) => t.dayOfWeek === undefined);
  const free = Math.max(0, (opts.gymDaysPerWeek ?? 3) - fixed.length);
  const out: Record<string, number> = {};
  for (const t of strength) {
    const manual = opts.occurrences?.[t.id];
    if (manual !== undefined) out[t.id] = manual;
    else out[t.id] = t.dayOfWeek !== undefined ? 1 : rotating.length > 0 ? free / rotating.length : 0;
  }
  return out;
}

/** Volume settimanale previsto da una scheda (solo serie allenanti delle sedute di pesi). */
export function plannedWeeklyVolume(templates: readonly WorkoutTemplate[], opts: PlannedVolumeOptions = {}): VolumeReport {
  const lookup = toLookup(opts.exercises);
  const occ = templateOccurrences(templates, opts);
  const byMuscle = emptyByMuscle();
  const unknown = new Set<string>();
  let total = 0;
  for (const t of templates) {
    if (t.kind !== 'forza') continue;
    const times = occ[t.id] ?? 0;
    for (const pe of t.exercises) {
      const n = pe.sets.filter((s) => (s.type ?? 'normale') !== 'riscaldamento').length;
      if (n === 0) continue;
      const ex = lookup.get(pe.exerciseId);
      if (!ex) {
        unknown.add(pe.exerciseId);
        continue;
      }
      total += n * times;
      for (const m of ex.primary) byMuscle[m] += n * times * PRIMARY_WEIGHT;
      for (const m of ex.secondary) byMuscle[m] += n * times * SECONDARY_WEIGHT;
    }
  }
  return toReport({ byMuscle, totalSets: total, unknownExercises: [...unknown] }, opts);
}

/** Quante volte a settimana ogni muscolo è allenato come primario (sedute di pesi, serie allenanti). */
export function muscleFrequency(templates: readonly WorkoutTemplate[], opts: PlannedVolumeOptions = {}): Record<MuscleGroup, number> {
  const lookup = toLookup(opts.exercises);
  const occ = templateOccurrences(templates, opts);
  const freq = emptyByMuscle();
  for (const t of templates) {
    if (t.kind !== 'forza') continue;
    const hit = new Set<MuscleGroup>();
    for (const pe of t.exercises) {
      if (!pe.sets.some((s) => (s.type ?? 'normale') !== 'riscaldamento')) continue;
      for (const m of lookup.get(pe.exerciseId)?.primary ?? []) hit.add(m);
    }
    for (const m of hit) freq[m] += occ[t.id] ?? 0;
  }
  return freq;
}
