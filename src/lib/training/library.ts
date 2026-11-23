/**
 * Libreria esercizi di Foro: carica src/data/esercizi.json e offre ricerca, sostituzioni e valori di partenza.
 *
 * Insiemi chiusi (documentati qui e verificati dai test):
 * - muscoli: i 14 di `MuscleGroup`;
 * - attrezzi: quelli di `Equipment`;
 * - schemi motori (`Exercise.pattern`):
 *     multiarticolari: spinta-orizzontale, spinta-verticale, tirata-orizzontale, tirata-verticale,
 *                      squat, hinge, affondo
 *     complementari:   isolamento-<muscolo> (per ogni muscolo tranne addome), core, trasporto
 *
 * Convenzioni sul carico (`LoggedSet.kg`):
 * - manubri e kettlebell: kg del singolo attrezzo, non la somma;
 * - corpo libero: kg aggiunti (0 = solo peso corporeo);
 * - macchine assistite (`assisted`): kg di aiuto, meno è meglio;
 * - esercizi a tempo (`timed`): `reps` sono secondi.
 */
import data from '../../data/esercizi.json';
import type {
  Equipment,
  Exercise,
  MuscleGroup,
  PlannedExercise,
  PlannedSet,
  ProgressionRule,
} from '../../db/types';

export const MUSCLES: readonly MuscleGroup[] = [
  'petto', 'dorsali', 'spalle', 'bicipiti', 'tricipiti', 'avambracci', 'quadricipiti', 'femorali',
  'glutei', 'polpacci', 'addome', 'lombari', 'trapezi', 'adduttori',
];

export const EQUIPMENT: readonly Equipment[] = [
  'bilanciere', 'manubri', 'macchina', 'cavi', 'corpo-libero', 'kettlebell', 'elastici', 'multipower', 'altro',
];

/** Schemi dei movimenti multiarticolari: intervallo 6-10 ripetizioni, recuperi lunghi. */
export const COMPOUND_PATTERNS: readonly string[] = [
  'spinta-orizzontale', 'spinta-verticale', 'tirata-orizzontale', 'tirata-verticale', 'squat', 'hinge', 'affondo',
];

/** Gli addominali si allenano con lo schema 'core', per questo non hanno 'isolamento-addome'. */
export const ISOLATION_PATTERNS: readonly string[] = MUSCLES.filter((m) => m !== 'addome').map(
  (m) => `isolamento-${m}`,
);

export const PATTERNS: readonly string[] = [...COMPOUND_PATTERNS, 'core', 'trasporto', ...ISOLATION_PATTERNS];

export const EXERCISES: readonly Exercise[] = data as unknown as Exercise[];

export type ExerciseSource = readonly Exercise[] | ReadonlyMap<string, Exercise> | Record<string, Exercise>;

const BUNDLED = new Map<string, Exercise>(EXERCISES.map((e) => [e.id, e]));

/** Normalizza qualunque forma di elenco in una Map id -> esercizio (di default la libreria inclusa). */
export function toLookup(source?: ExerciseSource): ReadonlyMap<string, Exercise> {
  if (!source) return BUNDLED;
  if (source instanceof Map) return source;
  if (Array.isArray(source)) return new Map((source as readonly Exercise[]).map((e) => [e.id, e]));
  return new Map(Object.entries(source as Record<string, Exercise>));
}

export function getExercise(id: string, source?: ExerciseSource): Exercise | undefined {
  return toLookup(source).get(id);
}

export function requireExercise(id: string, source?: ExerciseSource): Exercise {
  const ex = getExercise(id, source);
  if (!ex) throw new Error(`Esercizio sconosciuto: ${id}`);
  return ex;
}

export function isCompound(ex: Pick<Exercise, 'pattern'>): boolean {
  return COMPOUND_PATTERNS.includes(ex.pattern);
}

export function isTimed(ex: Pick<Exercise, 'timed'>): boolean {
  return ex.timed === true;
}

export function isAssisted(ex: Pick<Exercise, 'assisted'>): boolean {
  return ex.assisted === true;
}

/** Intervallo di ripetizioni di partenza: 6-10 multiarticolari, 10-15 complementari, 30-60 s a tempo. */
export function defaultRepRange(ex: Pick<Exercise, 'pattern' | 'timed'>): [number, number] {
  if (isTimed(ex)) return [30, 60];
  return isCompound(ex) ? [6, 10] : [10, 15];
}

/** Recupero di partenza in secondi: 150 multiarticolari (120-180), 75 complementari (60-90). */
export function defaultRestSec(ex: Pick<Exercise, 'pattern' | 'timed'>): number {
  if (isTimed(ex)) return 60;
  return isCompound(ex) ? 150 : 75;
}

/** RPE obiettivo: 7 sui multiarticolari (3 ripetizioni di riserva), 8 sui complementari. */
export function defaultRpe(ex: Pick<Exercise, 'pattern'>): number {
  return isCompound(ex) ? 7 : 8;
}

export interface PlannedExerciseOptions {
  /** Serie allenanti (default 3). */
  sets?: number;
  /** Serie di riscaldamento prima di quelle allenanti (default 0). */
  warmups?: number;
  reps?: [number, number];
  restSec?: number;
  rpe?: number;
  progression?: ProgressionRule;
  incrementKg?: number;
  note?: string;
  supersetGroup?: string;
}

/** Costruisce un PlannedExercise con intervalli, recuperi e RPE coerenti col metodo. */
export function buildPlannedExercise(ex: Exercise, opts: PlannedExerciseOptions = {}): PlannedExercise {
  const reps = opts.reps ?? defaultRepRange(ex);
  const restSec = opts.restSec ?? defaultRestSec(ex);
  const rpe = opts.rpe ?? defaultRpe(ex);
  const sets: PlannedSet[] = [];
  for (let i = 0; i < (opts.warmups ?? 0); i++) {
    sets.push({ reps: [Math.min(8, reps[1]), Math.min(10, reps[1])], restSec: 60, type: 'riscaldamento' });
  }
  for (let i = 0; i < (opts.sets ?? 3); i++) sets.push({ reps: [reps[0], reps[1]], rpe, restSec, type: 'normale' });
  const planned: PlannedExercise = {
    exerciseId: ex.id,
    sets,
    progression: opts.progression ?? 'doppia',
    incrementKg: opts.incrementKg ?? ex.defaultIncrementKg ?? 2.5,
  };
  if (opts.note) planned.note = opts.note;
  if (opts.supersetGroup) planned.supersetGroup = opts.supersetGroup;
  return planned;
}

/** Minuscolo, senza accenti né punteggiatura: "Farmer's walk" -> "farmer s walk". */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface SearchOptions {
  muscle?: MuscleGroup;
  /** Se vero, il muscolo può essere anche secondario (di default solo primario). */
  includeSecondary?: boolean;
  equipment?: Equipment | readonly Equipment[];
  pattern?: string;
}

function matchesFilters(e: Exercise, o: SearchOptions): boolean {
  if (o.muscle) {
    const ok = e.primary.includes(o.muscle) || (o.includeSecondary === true && e.secondary.includes(o.muscle));
    if (!ok) return false;
  }
  if (o.equipment) {
    const list = Array.isArray(o.equipment) ? (o.equipment as readonly Equipment[]) : [o.equipment as Equipment];
    if (!list.includes(e.equipment)) return false;
  }
  if (o.pattern && e.pattern !== o.pattern) return false;
  return true;
}

/** Cerca per nome o alias (tutte le parole devono comparire); i nomi che iniziano come la ricerca vengono prima. */
export function searchExercises(query: string, opts: SearchOptions = {}, source?: ExerciseSource): Exercise[] {
  const all = [...toLookup(source).values()].filter((e) => matchesFilters(e, opts));
  const q = normalizeText(query);
  if (!q) return all;
  const tokens = q.split(' ');
  const scored: { e: Exercise; score: number; order: number }[] = [];
  all.forEach((e, order) => {
    const name = normalizeText(e.name);
    const aliases = (e.aliases ?? []).map(normalizeText);
    let score = -1;
    if (name === q) score = 0;
    else if (aliases.includes(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (aliases.some((a) => a.startsWith(q))) score = 3;
    else if (tokens.every((t) => name.includes(t))) score = 4;
    else if (tokens.every((t) => name.includes(t) || aliases.some((a) => a.includes(t)))) score = 5;
    else if (aliases.some((a) => tokens.every((t) => a.includes(t)))) score = 5;
    if (score >= 0) scored.push({ e, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.e);
}

export interface SubstituteOptions {
  equipment?: Equipment | readonly Equipment[];
  exclude?: readonly string[];
  limit?: number;
}

/**
 * Alternative con lo stesso schema motorio, in ordine di vicinanza: stesso muscolo primario,
 * stesso tipo di misura (ripetizioni o secondi), stesso attrezzo.
 */
export function substitutesFor(
  exercise: Exercise | string,
  opts: SubstituteOptions = {},
  source?: ExerciseSource,
): Exercise[] {
  const ex = typeof exercise === 'string' ? requireExercise(exercise, source) : exercise;
  const exclude = new Set(opts.exclude ?? []);
  const equip = opts.equipment ? (Array.isArray(opts.equipment) ? opts.equipment : [opts.equipment]) : undefined;
  const out: { e: Exercise; score: number; order: number }[] = [];
  [...toLookup(source).values()].forEach((e, order) => {
    if (e.id === ex.id || exclude.has(e.id) || e.pattern !== ex.pattern) return;
    if (equip && !equip.includes(e.equipment as Equipment)) return;
    let score = 0;
    if (e.primary[0] === ex.primary[0]) score += 4;
    else if (e.primary.some((m) => ex.primary.includes(m))) score += 2;
    if (isTimed(e) === isTimed(ex)) score += 3;
    if (e.equipment === ex.equipment) score += 1;
    out.push({ e, score, order });
  });
  const sorted = out.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.e);
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
}

const garminNorm = (s: string) => s.trim().toUpperCase().replace(/[\s-]+/g, '_');

/**
 * Abbina un esercizio registrato dall'orologio (categoria e nome del profilo FIT) a uno della libreria.
 * Prima cerca 'CATEGORIA/NOME', poi un esercizio che dichiara la sola categoria. Senza categoria cerca il solo nome.
 */
export function findByGarmin(
  category: string | undefined,
  name: string | undefined,
  source?: ExerciseSource,
): Exercise | undefined {
  const all = [...toLookup(source).values()];
  const cat = category ? garminNorm(category) : undefined;
  const nm = name ? garminNorm(name) : undefined;
  if (cat && nm) {
    const exact = all.find((e) => e.garminKeys?.includes(`${cat}/${nm}`));
    if (exact) return exact;
  }
  if (!cat && nm) {
    const byName = all.find((e) => e.garminKeys?.some((k) => k.endsWith(`/${nm}`)));
    if (byName) return byName;
  }
  if (cat) return all.find((e) => e.garminKeys?.includes(cat));
  return undefined;
}
