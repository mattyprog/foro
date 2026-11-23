/**
 * Modalità palestra: stato e logica pura della seduta (nessun React, nessun accesso al database).
 *
 * Come si usa:
 *   let s = startSession(template, sessioniPassate, Date.now());          // valori dell'ultima volta + suggerimenti
 *   s = withSessionId(s, await db.sessions.add(toGymSession(s)));          // la seduta è subito in Dexie, senza endedAt
 *   s = completeSet(s, chiaveSerie, Date.now());                           // un tocco: il recupero parte da solo
 *   ...a ogni cambio: await db.sessions.put(toGymSession(s));              // così si riprende con resumeSession
 *   const { session, summary } = finishSession(s, Date.now(), { history });
 *   await db.sessions.put(session);
 *
 * Regole:
 * - tutte le funzioni sono pure: restituiscono un nuovo stato e non toccano quello ricevuto;
 * - gli istanti dello stato sono millisecondi epoch; il timer di recupero salva l'istante di fine
 *   (`rest.endsAt`) e si ricostruisce dall'orologio di sistema, quindi sopravvive allo sfondo e alla
 *   chiusura dell'app;
 * - una serie si registra in due tocchi o meno: i valori dell'ultima volta sono già compilati
 *   (o quelli più leggeri, se il suggerimento dice di scendere o la seduta è di scarico) e il
 *   suggerimento di progressione si applica con un tocco (`applySuggestion`);
 * - il carico segue le convenzioni della libreria esercizi (manubri: kg del singolo attrezzo; corpo
 *   libero: kg aggiunti; macchine assistite: kg di aiuto; esercizi a tempo: le ripetizioni sono secondi).
 */
import type {
  Exercise,
  GymSession,
  ISODate,
  LoggedSet,
  MuscleGroup,
  PlannedExercise,
  PlannedSet,
  SetType,
  WorkoutTemplate,
} from '../../db/types';
import { deviceOffsetMin, localDateOf, toISOWithOffset, toMs, type Instant } from './dates';
import {
  buildPlannedExercise,
  defaultRepRange,
  defaultRestSec,
  getExercise,
  isAssisted,
  isTimed,
  requireExercise,
  type ExerciseSource,
} from './library';
import { evaluateExercise, setsForMode } from './progression';
import {
  buildBaseline,
  describeRecord,
  detectRecords,
  e1rm,
  E1RM_MAX_RELIABLE_REPS,
  historyEntriesForExercise,
  isWorkingSet,
  type HistoryEntry,
  type RecordHit,
  type RecordOptions,
} from './records';
import type {
  ForoSessionMeta,
  HistoryByExercise,
  PersistedGymSession,
  RecordBaselineLite,
  RestTimer,
  SessionExercise,
  SessionMode,
  SessionSet,
  SessionState,
} from './types';
import { countSets } from './volume';

export type { RestTimer, SessionExercise, SessionMode, SessionSet, SessionState } from './types';

/** Avviso a 10 secondi dalla fine del recupero. */
export const REST_WARNING_SEC = 10;
/** Il recupero dopo un riscaldamento non supera mai un minuto. */
export const WARMUP_REST_MAX_SEC = 60;
export const RPE_MIN = 6;
export const RPE_MAX = 10;
const HISTORY_LIMIT = 5;

/** Storico: sedute passate oppure già raggruppato per esercizio (`LoggedSet[][]`, dalla più recente). */
export type HistorySource = readonly GymSession[] | HistoryByExercise;

function isSessionList(h: HistorySource): h is readonly GymSession[] {
  return Array.isArray(h);
}

/* ------------------------------------------------------------------ Storico */

function pastFor(history: HistorySource | undefined, exerciseId: string, limit = HISTORY_LIMIT): HistoryEntry[] {
  if (!history) return [];
  if (isSessionList(history)) return historyEntriesForExercise(history, exerciseId, { limit });
  return (history[exerciseId] ?? [])
    .filter((sets) => sets.some(isWorkingSet))
    .slice(0, limit)
    .map((sets) => ({ sets }));
}

/** Tutte le serie passate di un esercizio (per i record: contano anche gli scarichi, mai le sedute non chiuse). */
function allSetsOf(history: HistorySource, exerciseId: string): LoggedSet[] {
  if (isSessionList(history)) {
    return history.filter((h) => h.endedAt).flatMap((h) => h.sets.filter((s) => s.exerciseId === exerciseId));
  }
  return (history[exerciseId] ?? []).flat();
}

const recordFlags = (ex?: Exercise): RecordOptions => ({ assisted: ex ? isAssisted(ex) : false, timed: ex ? isTimed(ex) : false });

function baselineFor(history: HistorySource, ex: Exercise): RecordBaselineLite {
  return buildBaseline(allSetsOf(history, ex.id), recordFlags(ex));
}

function withBaseline(
  baselines: Record<string, RecordBaselineLite>,
  ex: Exercise,
  history: HistorySource | undefined,
): Record<string, RecordBaselineLite> {
  if (!history || baselines[ex.id]) return baselines;
  return { ...baselines, [ex.id]: baselineFor(history, ex) };
}

/* ------------------------------------------------------------- Costruzione */

type Counters = SessionState['counters'];

function newKey(c: Counters, kind: 'exercise' | 'set'): string {
  c[kind] += 1;
  return `${kind === 'exercise' ? 'e' : 's'}${c[kind]}`;
}

interface EntryCtx {
  counters: Counters;
  mode: SessionMode;
  /** Falso: le serie sono già quelle volute (sostituzione, esercizio aggiunto): cambiano solo i carichi. */
  reduceSets: boolean;
  maxRpe?: number;
  barbellStepKg?: number;
  exerciseOrigin: 'piano' | 'aggiunto';
  setOrigin: (planIndex: number) => 'piano' | 'aggiunta';
  replacedExerciseId?: string;
}

const byIndex = (a: LoggedSet, b: LoggedSet) => a.setIndex - b.setIndex;
const workingSorted = (sets: readonly LoggedSet[]): LoggedSet[] => sets.filter(isWorkingSet).sort(byIndex);

/** Il suggerimento chiede un carico più facile di quello dell'ultima volta (con le macchine assistite: più aiuto). */
function isEasier(suggestedKg: number | undefined, previousKg: number, assisted: boolean): boolean {
  if (suggestedKg === undefined) return false;
  return assisted ? suggestedKg > previousKg : suggestedKg < previousKg;
}

/**
 * Un esercizio della seduta, con serie precompilate.
 * Valori precompilati: quelli dell'ultima volta; se il suggerimento è più leggero (carico che scende,
 * seduta di scarico) o è la prima volta, quelli del suggerimento. Il riscaldamento parte sempre dal suggerimento.
 */
function buildExerciseEntry(pe: PlannedExercise, ex: Exercise, past: readonly HistoryEntry[], ctx: EntryCtx): SessionExercise {
  const evaluation = evaluateExercise(
    pe,
    past.map((p) => p.sets),
    ex,
    { mode: ctx.mode, maxRpe: ctx.maxRpe, barbellStepKg: ctx.barbellStepKg, reduceSets: ctx.reduceSets },
  );
  const assisted = isAssisted(ex);
  const lastWork = past.length > 0 ? workingSorted(past[0].sets) : [];
  const key = newKey(ctx.counters, 'exercise');
  let w = 0;
  const sets = evaluation.suggestions.map((sg): SessionSet => {
    const plan = pe.sets[sg.index];
    const warm = sg.type === 'riscaldamento';
    const prev = !warm && lastWork.length > 0 ? lastWork[Math.min(w, lastWork.length - 1)] : undefined;
    if (!warm) w += 1;
    const reuse = prev !== undefined && ctx.mode !== 'scarico' && !isEasier(sg.kg, prev.kg, assisted) ? prev : undefined;
    return {
      key: newKey(ctx.counters, 'set'),
      type: sg.type,
      origin: ctx.setOrigin(sg.index),
      repsMin: plan.reps[0],
      repsMax: plan.reps[1],
      rpeTarget: plan.rpe,
      restSec: plan.restSec,
      kg: reuse ? reuse.kg : sg.kg,
      reps: reuse ? reuse.reps : sg.repsTarget,
      done: false,
      previous: prev ? { kg: prev.kg, reps: prev.reps, rpe: prev.rpe } : undefined,
      suggestion: { kg: sg.kg, repsTarget: sg.repsTarget, motivo: sg.motivo },
    };
  });
  const entry: SessionExercise = {
    key,
    exerciseId: ex.id,
    origin: ctx.exerciseOrigin,
    skipped: false,
    progression: pe.progression,
    incrementKg: pe.incrementKg,
    motivo: evaluation.motivo,
    stalled: evaluation.stalled,
    sets,
  };
  if (ctx.replacedExerciseId) entry.replacedExerciseId = ctx.replacedExerciseId;
  if (pe.supersetGroup) entry.supersetGroup = pe.supersetGroup;
  if (pe.note) entry.note = pe.note;
  if (past.length > 0) {
    entry.lastTime = { date: past[0].date, sets: lastWork.map((s) => ({ kg: s.kg, reps: s.reps, rpe: s.rpe })) };
  }
  return entry;
}

export interface StartOptions {
  /** normale, leggero (serie -1/3, niente aumenti di carico) o scarico (serie -50%, carico -10%). */
  mode?: SessionMode;
  /** Scarto del fuso in minuti per la data locale (default: quello del dispositivo). */
  tzOffsetMin?: number;
  /** Libreria esercizi (default: quella inclusa). */
  exercises?: ExerciseSource;
  note?: string;
  /** RPE massimo per poter salire di carico (default 8). */
  maxRpe?: number;
  /** Passo del bilanciere in kg (default 1,25). */
  barbellStepKg?: number;
}

function baseState(ms: number, opts: StartOptions): SessionState {
  const tz = opts.tzOffsetMin ?? deviceOffsetMin(ms);
  const state: SessionState = {
    v: 1,
    mode: opts.mode ?? 'normale',
    startedAt: ms,
    date: localDateOf(ms, tz),
    tzOffsetMin: tz,
    exercises: [],
    baselines: {},
    counters: { exercise: 0, set: 0 },
  };
  if (opts.note) state.note = opts.note;
  return state;
}

/** Avvia la seduta di una scheda: serie, valori dell'ultima volta e suggerimenti per ogni esercizio. */
export function startSession(
  template: WorkoutTemplate,
  history: HistorySource | undefined,
  now: Instant,
  opts: StartOptions = {},
): SessionState {
  const state = baseState(toMs(now), opts);
  state.templateId = template.id;
  state.programId = template.programId;
  state.name = template.name;
  const ctx: EntryCtx = {
    counters: state.counters,
    mode: state.mode,
    reduceSets: true,
    maxRpe: opts.maxRpe,
    barbellStepKg: opts.barbellStepKg,
    exerciseOrigin: 'piano',
    setOrigin: () => 'piano',
  };
  for (const pe of template.exercises) {
    const ex = requireExercise(pe.exerciseId, opts.exercises);
    if (history) state.baselines[ex.id] = baselineFor(history, ex);
    state.exercises.push(buildExerciseEntry(pe, ex, pastFor(history, ex.id), ctx));
  }
  return state;
}

/** Seduta libera, senza scheda: si aggiungono gli esercizi con `addExercise`. */
export function startFreeSession(now: Instant, opts: StartOptions = {}): SessionState {
  return baseState(toMs(now), opts);
}

/* ---------------------------------------------------------------- Utilità */

interface SetLoc {
  exIdx: number;
  setIdx: number;
  exercise: SessionExercise;
  set: SessionSet;
}

function locateSet(state: SessionState, key: string): SetLoc {
  for (let exIdx = 0; exIdx < state.exercises.length; exIdx++) {
    const exercise = state.exercises[exIdx];
    const setIdx = exercise.sets.findIndex((s) => s.key === key);
    if (setIdx >= 0) return { exIdx, setIdx, exercise, set: exercise.sets[setIdx] };
  }
  throw new Error(`Serie inesistente: ${key}`);
}

function exerciseIndex(state: SessionState, key: string): number {
  const i = state.exercises.findIndex((e) => e.key === key);
  if (i < 0) throw new Error(`Esercizio inesistente: ${key}`);
  return i;
}

function replaceSet(state: SessionState, loc: SetLoc, set: SessionSet): SessionState {
  const exercises = state.exercises.map((e, i) =>
    i === loc.exIdx ? { ...e, sets: e.sets.map((s, k) => (k === loc.setIdx ? set : s)) } : e,
  );
  return { ...state, exercises };
}

function replaceExercise(state: SessionState, idx: number, entry: SessionExercise): SessionState {
  return { ...state, exercises: state.exercises.map((e, i) => (i === idx ? entry : e)) };
}

function withRest(state: SessionState, rest: RestTimer | undefined): SessionState {
  const next: SessionState = { ...state };
  if (rest) next.rest = rest;
  else delete next.rest;
  return next;
}

function hasPending(state: SessionState): boolean {
  return state.exercises.some((e) => !e.skipped && e.sets.some((s) => !s.done));
}

/* ----------------------------------------------------------- Valori di serie */

export interface SetValues {
  kg?: number;
  reps?: number;
  /** Da 6 a 10 (anche mezzi punti); `null` lo toglie. */
  rpe?: number | null;
  /** Nota libera; `null` o vuota la toglie. */
  note?: string | null;
}

function checkValues(v: SetValues): void {
  if (v.kg !== undefined && !(Number.isFinite(v.kg) && v.kg >= 0)) throw new Error(`Carico non valido: ${v.kg} kg`);
  if (v.reps !== undefined && !(Number.isInteger(v.reps) && v.reps >= 0)) throw new Error(`Ripetizioni non valide: ${v.reps}`);
  if (typeof v.rpe === 'number' && !(v.rpe >= RPE_MIN && v.rpe <= RPE_MAX && Number.isInteger(v.rpe * 2))) {
    throw new Error(`RPE non valido: ${v.rpe}. Si registra da ${RPE_MIN} a ${RPE_MAX}.`);
  }
}

function applyValues(set: SessionSet, v: SetValues): SessionSet {
  const next: SessionSet = { ...set };
  if (v.kg !== undefined) next.kg = v.kg;
  if (v.reps !== undefined) next.reps = v.reps;
  if (v.rpe !== undefined) {
    if (v.rpe === null) delete next.rpe;
    else next.rpe = v.rpe;
  }
  if (v.note !== undefined) {
    const note = v.note?.trim();
    if (note) next.note = note;
    else delete next.note;
  }
  return next;
}

const hasValues = (v: SetValues) => Object.values(v).some((x) => x !== undefined);

/** Cambia carico, ripetizioni, RPE o nota di una serie, anche già fatta. */
export function editSet(state: SessionState, setKey: string, values: SetValues): SessionState {
  checkValues(values);
  const loc = locateSet(state, setKey);
  return replaceSet(state, loc, applyValues(loc.set, values));
}

/** Prossimo recupero dopo una serie: niente se è l'ultima della seduta o se nella superserie manca il compagno. */
function restAfter(state: SessionState, loc: SetLoc, set: SessionSet, nowMs: number): RestTimer | undefined {
  if (!hasPending(state)) return undefined;
  let restSec = set.restSec;
  const group = loc.exercise.supersetGroup;
  if (group) {
    const partners = state.exercises.filter((e, i) => i !== loc.exIdx && !e.skipped && e.supersetGroup === group);
    const sameRound = partners.map((e) => e.sets[loc.setIdx]).filter((s): s is SessionSet => s !== undefined);
    if (sameRound.some((s) => !s.done)) return undefined; // il giro non è finito: si passa all'altro esercizio
    restSec = Math.max(restSec, ...sameRound.map((s) => s.restSec));
  }
  if (set.type === 'riscaldamento') restSec = Math.min(restSec, WARMUP_REST_MAX_SEC);
  if (!(restSec > 0)) return undefined;
  return {
    startedAt: nowMs,
    endsAt: nowMs + restSec * 1000,
    durationSec: restSec,
    setKey: set.key,
    warned: restSec <= REST_WARNING_SEC,
    finished: false,
  };
}

/**
 * Segna la serie come fatta (un tocco con i valori già compilati; con una correzione, due).
 * Il recupero parte da solo. Senza carico o ripetizioni non si può completare.
 */
export function completeSet(state: SessionState, setKey: string, now: Instant, values: SetValues = {}): SessionState {
  checkValues(values);
  const loc = locateSet(state, setKey);
  if (loc.set.done) return hasValues(values) ? editSet(state, setKey, values) : state;
  const nowMs = toMs(now);
  const filled = applyValues(loc.set, values);
  if (filled.kg === undefined) throw new Error('Manca il carico (kg): inseriscilo per segnare la serie come fatta.');
  if (filled.reps === undefined || filled.reps < 1) throw new Error('Mancano le ripetizioni: inseriscile per segnare la serie come fatta.');
  const done: SessionSet = { ...filled, done: true, doneAt: nowMs };
  const exercises = state.exercises.map((e, i) =>
    i === loc.exIdx ? { ...e, skipped: false, sets: e.sets.map((s, k) => (k === loc.setIdx ? done : s)) } : e,
  );
  const next: SessionState = { ...state, exercises };
  return withRest(next, restAfter(next, loc, done, nowMs));
}

/** Annulla una serie segnata per sbaglio; se era appena partito il suo recupero, si ferma. */
export function uncompleteSet(state: SessionState, setKey: string): SessionState {
  const loc = locateSet(state, setKey);
  if (!loc.set.done) return state;
  const set: SessionSet = { ...loc.set, done: false };
  delete set.doneAt;
  const next = replaceSet(state, loc, set);
  return state.rest?.setKey === setKey ? withRest(next, undefined) : next;
}

/** Copia il suggerimento di progressione nei valori della serie (se non è già fatta). */
export function applySuggestion(state: SessionState, setKey: string): SessionState {
  const loc = locateSet(state, setKey);
  const sg = loc.set.suggestion;
  if (loc.set.done || !sg) return state;
  const set: SessionSet = { ...loc.set, reps: sg.repsTarget };
  if (sg.kg !== undefined) set.kg = sg.kg;
  return replaceSet(state, loc, set);
}

/** Applica i suggerimenti a tutte le serie non ancora fatte di un esercizio. */
export function applySuggestions(state: SessionState, exerciseKey: string): SessionState {
  const idx = exerciseIndex(state, exerciseKey);
  const entry = state.exercises[idx];
  const sets = entry.sets.map((s) => {
    if (s.done || !s.suggestion) return s;
    const next: SessionSet = { ...s, reps: s.suggestion.repsTarget };
    if (s.suggestion.kg !== undefined) next.kg = s.suggestion.kg;
    return next;
  });
  return replaceExercise(state, idx, { ...entry, sets });
}

/* ------------------------------------------------- Modifiche al volo */

export interface AddSetOptions {
  type?: SetType;
  kg?: number;
  reps?: number;
  /** Libreria esercizi, per gli intervalli di default se l'esercizio non ha più serie. */
  exercises?: ExerciseSource;
}

/** Aggiunge una serie in fondo all'esercizio, copiando i valori dell'ultima serie allenante. */
export function addSet(state: SessionState, exerciseKey: string, opts: AddSetOptions = {}): SessionState {
  const idx = exerciseIndex(state, exerciseKey);
  const entry = state.exercises[idx];
  const src = [...entry.sets].reverse().find((s) => s.type !== 'riscaldamento') ?? entry.sets[entry.sets.length - 1];
  const type = opts.type ?? 'normale';
  const lib = getExercise(entry.exerciseId, opts.exercises);
  const [defMin, defMax] = lib ? defaultRepRange(lib) : [8, 12];
  const c = { ...state.counters };
  const restSec = src?.restSec ?? (lib ? defaultRestSec(lib) : 90);
  const set: SessionSet = {
    key: newKey(c, 'set'),
    type,
    origin: 'aggiunta',
    repsMin: src?.repsMin ?? defMin,
    repsMax: src?.repsMax ?? defMax,
    rpeTarget: src?.rpeTarget,
    restSec: type === 'riscaldamento' ? Math.min(restSec, WARMUP_REST_MAX_SEC) : restSec,
    kg: opts.kg ?? src?.kg,
    reps: opts.reps ?? src?.reps ?? defMin,
    done: false,
  };
  if (src && type !== 'riscaldamento') {
    set.previous = src.previous;
    set.suggestion = src.suggestion;
  }
  return { ...replaceExercise(state, idx, { ...entry, sets: [...entry.sets, set] }), counters: c };
}

/** Toglie una serie non ancora fatta. */
export function removeSet(state: SessionState, setKey: string): SessionState {
  const loc = locateSet(state, setKey);
  if (loc.set.done) throw new Error('La serie è già registrata: annullala prima di toglierla.');
  return replaceExercise(state, loc.exIdx, { ...loc.exercise, sets: loc.exercise.sets.filter((s) => s.key !== setKey) });
}

export interface AddExerciseOptions {
  /** Storico per valori dell'ultima volta, suggerimenti e record del nuovo esercizio. */
  history?: HistorySource;
  /** Serie allenanti (default 3, ridotte nelle sedute leggere e di scarico). */
  sets?: number;
  /** Serie di riscaldamento prima di quelle allenanti (default 0). */
  warmups?: number;
  /** Chiave dell'esercizio dopo cui inserirlo (default: in fondo). */
  afterKey?: string;
  exercises?: ExerciseSource;
  maxRpe?: number;
  barbellStepKg?: number;
}

/** Aggiunge un esercizio in più alla seduta; tutte le sue serie contano come aggiunte. */
export function addExercise(state: SessionState, exerciseId: string, opts: AddExerciseOptions = {}): SessionState {
  const ex = requireExercise(exerciseId, opts.exercises);
  const sets = opts.sets ?? setsForMode(3, state.mode);
  const pe = buildPlannedExercise(ex, { sets, warmups: opts.warmups ?? 0 });
  const c = { ...state.counters };
  const entry = buildExerciseEntry(pe, ex, pastFor(opts.history, ex.id), {
    counters: c,
    mode: state.mode,
    reduceSets: false,
    maxRpe: opts.maxRpe,
    barbellStepKg: opts.barbellStepKg,
    exerciseOrigin: 'aggiunto',
    setOrigin: () => 'aggiunta',
  });
  const at = opts.afterKey === undefined ? state.exercises.length : exerciseIndex(state, opts.afterKey) + 1;
  const exercises = [...state.exercises.slice(0, at), entry, ...state.exercises.slice(at)];
  return { ...state, exercises, counters: c, baselines: withBaseline(state.baselines, ex, opts.history) };
}

export interface SubstituteOptions {
  history?: HistorySource;
  exercises?: ExerciseSource;
  maxRpe?: number;
  barbellStepKg?: number;
}

/**
 * Sostituisce un esercizio con un altro dello stesso schema motorio.
 * Le serie già fatte restano all'esercizio vecchio; quelle ancora da fare passano al nuovo,
 * con i suoi valori dell'ultima volta e i suoi suggerimenti. Se non è stata fatta nessuna serie,
 * il nuovo esercizio prende semplicemente il posto del vecchio.
 */
export function substituteExercise(
  state: SessionState,
  exerciseKey: string,
  newExerciseId: string,
  opts: SubstituteOptions = {},
): SessionState {
  const idx = exerciseIndex(state, exerciseKey);
  const old = state.exercises[idx];
  const newEx = requireExercise(newExerciseId, opts.exercises);
  if (newEx.id === old.exerciseId) throw new Error('È lo stesso esercizio: scegline un altro.');
  const oldEx = getExercise(old.exerciseId, opts.exercises);
  if (!oldEx || oldEx.pattern !== newEx.pattern) {
    throw new Error(
      `Si sostituisce solo con un esercizio dello stesso schema motorio${oldEx ? ` (${oldEx.pattern})` : ''}: ${newEx.name} è "${newEx.pattern}".`,
    );
  }
  const pending = old.sets.filter((s) => !s.done);
  const done = old.sets.filter((s) => s.done);
  if (pending.length === 0) throw new Error('Tutte le serie di questo esercizio sono già fatte: aggiungi un altro esercizio.');

  // Stessa misura (ripetizioni o secondi): si tengono gli intervalli e i recuperi della scheda; altrimenti i valori standard.
  const sameKind = isTimed(newEx) === isTimed(oldEx);
  const [defMin, defMax] = defaultRepRange(newEx);
  const defRest = defaultRestSec(newEx);
  const plannedSets: PlannedSet[] = pending.map((s) => {
    const ps: PlannedSet = {
      reps: sameKind ? [s.repsMin, s.repsMax] : [defMin, defMax],
      restSec: sameKind ? s.restSec : s.type === 'riscaldamento' ? Math.min(defRest, WARMUP_REST_MAX_SEC) : defRest,
      type: s.type,
    };
    if (sameKind && s.rpeTarget !== undefined) ps.rpe = s.rpeTarget;
    return ps;
  });
  const pe: PlannedExercise = {
    exerciseId: newEx.id,
    sets: plannedSets,
    progression: old.progression,
    incrementKg: newEx.defaultIncrementKg && newEx.defaultIncrementKg > 0 ? newEx.defaultIncrementKg : old.incrementKg,
  };
  if (old.supersetGroup) pe.supersetGroup = old.supersetGroup;

  const c = { ...state.counters };
  const entry = buildExerciseEntry(pe, newEx, pastFor(opts.history, newEx.id), {
    counters: c,
    mode: state.mode,
    reduceSets: false,
    maxRpe: opts.maxRpe,
    barbellStepKg: opts.barbellStepKg,
    exerciseOrigin: old.origin,
    setOrigin: (i) => pending[i].origin,
    replacedExerciseId: old.replacedExerciseId ?? old.exerciseId,
  });
  const baselines = withBaseline(state.baselines, newEx, opts.history);
  if (done.length === 0) {
    // sostituzione sul posto: il nuovo esercizio tiene la chiave del vecchio
    return { ...replaceExercise(state, idx, { ...entry, key: old.key }), counters: c, baselines };
  }
  const exercises = [
    ...state.exercises.slice(0, idx),
    { ...old, sets: done },
    entry,
    ...state.exercises.slice(idx + 1),
  ];
  return { ...state, exercises, counters: c, baselines };
}

/** Salta un esercizio: le sue serie non fatte non contano più (le fatte restano). */
export function skipExercise(state: SessionState, exerciseKey: string): SessionState {
  const idx = exerciseIndex(state, exerciseKey);
  return replaceExercise(state, idx, { ...state.exercises[idx], skipped: true });
}

/** Rimette in programma un esercizio saltato. */
export function restoreExercise(state: SessionState, exerciseKey: string): SessionState {
  const idx = exerciseIndex(state, exerciseKey);
  return replaceExercise(state, idx, { ...state.exercises[idx], skipped: false });
}

/* ------------------------------------------------------------ Avanzamento */

export interface NextSet {
  exercise: SessionExercise;
  set: SessionSet;
  exerciseIndex: number;
  setIndex: number;
}

/**
 * La prossima serie da fare: nell'ordine della scheda, saltando gli esercizi saltati.
 * Nelle superserie si alterna: prima il primo giro di tutti gli esercizi del gruppo, poi il secondo, e così via.
 */
export function nextSet(state: SessionState): NextSet | undefined {
  const list = state.exercises;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.skipped) continue;
    const j = e.sets.findIndex((s) => !s.done);
    if (j < 0) continue;
    let best = { i, j };
    if (e.supersetGroup) {
      list.forEach((o, oi) => {
        if (o.skipped || o.supersetGroup !== e.supersetGroup) return;
        const oj = o.sets.findIndex((s) => !s.done);
        if (oj < 0) return;
        if (oj < best.j) best = { i: oi, j: oj }; // a parità di giro resta il primo del gruppo nell'ordine della scheda
      });
    }
    return { exercise: list[best.i], set: list[best.i].sets[best.j], exerciseIndex: best.i, setIndex: best.j };
  }
  return undefined;
}

export interface SessionProgress {
  /** Serie allenanti fatte (aggiunte comprese). */
  done: number;
  /** Serie allenanti previste dalla scheda (anche in esercizi saltati). */
  planned: number;
  /** Serie allenanti previste dalla scheda e già fatte. */
  plannedDone: number;
  /** Serie allenanti aggiunte al volo. */
  extra: number;
  /** Serie ancora da fare (riscaldamento compreso) negli esercizi non saltati. */
  pending: number;
  warmupDone: number;
}

export function sessionProgress(state: SessionState): SessionProgress {
  const p: SessionProgress = { done: 0, planned: 0, plannedDone: 0, extra: 0, pending: 0, warmupDone: 0 };
  for (const e of state.exercises) {
    for (const s of e.sets) {
      if (!s.done && !e.skipped) p.pending++;
      if (s.type === 'riscaldamento') {
        if (s.done) p.warmupDone++;
        continue;
      }
      if (s.done) p.done++;
      if (s.origin === 'piano') {
        p.planned++;
        if (s.done) p.plannedDone++;
      } else p.extra++;
    }
  }
  return p;
}

/* -------------------------------------------------- Timer di recupero */

export type RestSignal = 'avviso-10s' | 'fine';

/** Secondi che mancano (arrotondati per eccesso, mai negativi). */
export function remaining(rest: Pick<RestTimer, 'endsAt'>, now: Instant): number {
  return Math.max(0, Math.ceil((rest.endsAt - toMs(now)) / 1000));
}

/** Secondi di recupero rimasti; undefined se non c'è un timer. */
export function restRemainingSec(state: SessionState, now: Instant): number | undefined {
  return state.rest ? remaining(state.rest, now) : undefined;
}

/**
 * Da chiamare a ogni battito dell'interfaccia (o alla riapertura dell'app): dice se è il momento
 * dell'avviso a 10 secondi o della fine, una volta sola. Se l'app torna dopo la fine, dà solo 'fine'.
 */
export function tickRest(state: SessionState, now: Instant): { state: SessionState; signals: RestSignal[] } {
  const rest = state.rest;
  if (!rest) return { state, signals: [] };
  const left = remaining(rest, now);
  const signals: RestSignal[] = [];
  let { warned, finished } = rest;
  if (left === 0 && !finished) {
    signals.push('fine');
    finished = true;
    warned = true;
  } else if (left > 0 && left <= REST_WARNING_SEC && !warned) {
    signals.push('avviso-10s');
    warned = true;
  }
  if (signals.length === 0) return { state, signals };
  return { state: { ...state, rest: { ...rest, warned, finished } }, signals };
}

/** Aggiunge o toglie secondi al recupero in corso (anche se è già finito) e riarma i segnali. */
export function adjustRest(state: SessionState, deltaSec: number, now: Instant): SessionState {
  const rest = state.rest;
  if (!rest) return state;
  const nowMs = toMs(now);
  const base = deltaSec > 0 ? Math.max(rest.endsAt, nowMs) : rest.endsAt;
  const endsAt = base + deltaSec * 1000;
  const left = remaining({ endsAt }, nowMs);
  return {
    ...state,
    rest: {
      ...rest,
      endsAt,
      durationSec: Math.max(0, Math.round((endsAt - rest.startedAt) / 1000)),
      finished: left === 0,
      warned: left === 0 ? true : left > REST_WARNING_SEC ? false : rest.warned,
    },
  };
}

/** Ferma il recupero (per esempio con un tocco su "salta"). */
export function skipRest(state: SessionState): SessionState {
  return state.rest ? withRest(state, undefined) : state;
}

/* ------------------------------------------------------- Chiusura e riepilogo */

export interface ExerciseSummary {
  exerciseId: string;
  nome: string;
  serieFatte: number;
  /** Carico sollevato; 0 per gli esercizi a tempo e con macchine assistite. */
  tonnellaggioKg: number;
  migliorSerie?: { kg: number; reps: number; rpe?: number };
  /** Nome dell'esercizio della scheda che questo ha sostituito. */
  sostituisce?: string;
}

export interface SessionSummary {
  date: ISODate;
  name?: string;
  mode: SessionMode;
  durataSec: number;
  /** Somma di kg x ripetizioni delle serie allenanti, esclusi esercizi a tempo e macchine assistite. */
  tonnellaggioKg: number;
  serieFatte: number;
  seriePianificate: number;
  serieRiscaldamento: number;
  eserciziFatti: number;
  eserciziSaltati: number;
  /** Percentuale di serie previste dalla scheda che sono state fatte (0-100). */
  completamento: number;
  perEsercizio: ExerciseSummary[];
  /** Serie per muscolo (primario 1, secondario 0,5), solo i muscoli lavorati. */
  perMuscolo: Partial<Record<MuscleGroup, number>>;
  record: RecordHit[];
  recordTesti: string[];
}

export interface FinishOptions {
  /** Storico per riconoscere i record degli esercizi di cui all'avvio non c'erano le soglie. */
  history?: HistorySource;
  exercises?: ExerciseSource;
}

/** Tutte le serie fatte, nel formato del contratto dati (`setIndex` progressivo per esercizio). */
export function toLoggedSets(state: SessionState): LoggedSet[] {
  const counts = new Map<string, number>();
  const out: LoggedSet[] = [];
  for (const e of state.exercises) {
    for (const s of e.sets) {
      if (!s.done) continue;
      const setIndex = counts.get(e.exerciseId) ?? 0;
      counts.set(e.exerciseId, setIndex + 1);
      const logged: LoggedSet = {
        exerciseId: e.exerciseId,
        setIndex,
        kg: s.kg ?? 0,
        reps: s.reps ?? 0,
        type: s.type,
        done: true,
        ts: toISOWithOffset(s.doneAt ?? state.startedAt, state.tzOffsetMin),
      };
      if (s.rpe !== undefined) logged.rpe = s.rpe;
      if (s.note) logged.note = s.note;
      out.push(logged);
    }
  }
  return out;
}

/** Tra due serie dello stesso esercizio, la migliore: più e1RM, o più secondi, o meno aiuto. */
function bestSetOf(sets: readonly LoggedSet[], flags: RecordOptions): LoggedSet | undefined {
  const score = (s: LoggedSet): [number, number, number] => {
    if (flags.timed) return [1, s.reps, s.kg];
    if (flags.assisted) return [1, -s.kg, s.reps];
    const e = s.reps <= E1RM_MAX_RELIABLE_REPS ? e1rm(s.kg, s.reps) : undefined;
    if (e !== undefined) return [2, e, s.reps];
    return [s.kg > 0 ? 1 : 0, s.kg > 0 ? s.kg * s.reps : s.reps, s.reps];
  };
  let best: LoggedSet | undefined;
  let bestScore: [number, number, number] | undefined;
  for (const s of sets) {
    const sc = score(s);
    if (!bestScore || sc[0] > bestScore[0] || (sc[0] === bestScore[0] && (sc[1] > bestScore[1] || (sc[1] === bestScore[1] && sc[2] > bestScore[2])))) {
      best = s;
      bestScore = sc;
    }
  }
  return best;
}

/** Riepilogo della seduta (anche a seduta ancora aperta: durata fino a `endedAt` o a `now`). */
export function summarizeSession(state: SessionState, now: Instant, opts: FinishOptions = {}): SessionSummary {
  const endMs = state.endedAt ?? Math.max(toMs(now), state.startedAt);
  const logged = toLoggedSets(state);
  const working = logged.filter(isWorkingSet);
  const exOf = (id: string) => getExercise(id, opts.exercises);

  const grouped = new Map<string, LoggedSet[]>();
  for (const s of working) grouped.set(s.exerciseId, [...(grouped.get(s.exerciseId) ?? []), s]);

  let tonnellaggioKg = 0;
  const perEsercizio: ExerciseSummary[] = [];
  for (const [id, sets] of grouped) {
    const ex = exOf(id);
    const flags = recordFlags(ex);
    const lifted = flags.timed || flags.assisted ? 0 : sets.reduce((a, s) => a + s.kg * s.reps, 0);
    tonnellaggioKg += lifted;
    const best = bestSetOf(sets, flags);
    const replaced = state.exercises.find((e) => e.exerciseId === id && e.replacedExerciseId)?.replacedExerciseId;
    const item: ExerciseSummary = { exerciseId: id, nome: ex?.name ?? id, serieFatte: sets.length, tonnellaggioKg: lifted };
    if (best) item.migliorSerie = { kg: best.kg, reps: best.reps, ...(best.rpe !== undefined ? { rpe: best.rpe } : {}) };
    if (replaced) item.sostituisce = exOf(replaced)?.name ?? replaced;
    perEsercizio.push(item);
  }

  const progress = sessionProgress(state);
  const doneIds = new Set(grouped.keys());
  const eserciziSaltati = state.exercises.filter((e) => {
    if (e.origin !== 'piano' || doneIds.has(e.exerciseId)) return false;
    return !(e.replacedExerciseId && doneIds.has(e.replacedExerciseId));
  }).length;
  const completamento =
    progress.planned > 0 ? Math.min(100, Math.round((progress.plannedDone / progress.planned) * 100)) : progress.done > 0 ? 100 : 0;

  const perMuscolo: Partial<Record<MuscleGroup, number>> = {};
  const byMuscle = countSets(working, opts.exercises).byMuscle;
  for (const [muscle, n] of Object.entries(byMuscle) as [MuscleGroup, number][]) if (n > 0) perMuscolo[muscle] = n;

  const record: RecordHit[] = [];
  const recordTesti: string[] = [];
  if (state.mode !== 'scarico') {
    for (const id of grouped.keys()) {
      const ex = exOf(id);
      const base = state.baselines[id] ?? (opts.history && ex ? baselineFor(opts.history, ex) : undefined);
      if (!base) continue;
      for (const hit of detectRecords(id, logged, base, recordFlags(ex))) {
        record.push(hit);
        recordTesti.push(describeRecord(hit, ex?.name ?? id, recordFlags(ex)));
      }
    }
  }

  const summary: SessionSummary = {
    date: state.date,
    mode: state.mode,
    durataSec: Math.round((endMs - state.startedAt) / 1000),
    tonnellaggioKg,
    serieFatte: working.length,
    seriePianificate: progress.planned,
    serieRiscaldamento: logged.length - working.length,
    eserciziFatti: perEsercizio.length,
    eserciziSaltati,
    completamento,
    perEsercizio,
    perMuscolo,
    record,
    recordTesti,
  };
  if (state.name) summary.name = state.name;
  return summary;
}

/** Chiude la seduta: stato chiuso (senza timer), riepilogo e la `GymSession` da salvare in Dexie. */
export function finishSession(
  state: SessionState,
  now: Instant,
  opts: FinishOptions = {},
): { state: SessionState; summary: SessionSummary; session: PersistedGymSession } {
  const endedAt = state.endedAt ?? Math.max(toMs(now), state.startedAt);
  const ended = withRest({ ...state, endedAt }, undefined);
  return { state: ended, summary: summarizeSession(ended, endedAt, opts), session: toGymSession(ended) };
}

/* --------------------------------------------------- Salvataggio e ripresa */

/** Ricorda l'id Dexie della seduta dopo il primo salvataggio. */
export function withSessionId(state: SessionState, id: number): SessionState {
  return { ...state, sessionId: id };
}

/**
 * La seduta come la vuole Dexie: solo le serie fatte, `endedAt` vuoto finché è aperta.
 * In `foro` porta il modo (anche a seduta chiusa, per non falsare la progressione con gli scarichi)
 * e, finché è aperta, lo stato completo per la ripresa.
 */
export function toGymSession(state: SessionState): PersistedGymSession {
  const foro: ForoSessionMeta = { v: 1, modo: state.mode };
  const session: PersistedGymSession = {
    date: state.date,
    startedAt: toISOWithOffset(state.startedAt, state.tzOffsetMin),
    sets: toLoggedSets(state),
    foro,
  };
  if (state.sessionId !== undefined) session.id = state.sessionId;
  if (state.templateId) session.templateId = state.templateId;
  if (state.programId) session.programId = state.programId;
  if (state.note) session.note = state.note;
  if (state.endedAt !== undefined) session.endedAt = toISOWithOffset(state.endedAt, state.tzOffsetMin);
  else foro.live = state;
  return session;
}

export interface ResumeOptions {
  /** Scheda della seduta: serve solo se lo stato salvato manca e si ricostruisce dalle serie registrate. */
  template?: WorkoutTemplate;
  history?: HistorySource;
  tzOffsetMin?: number;
  mode?: SessionMode;
  exercises?: ExerciseSource;
}

const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Scarto del fuso scritto in una stringa ISO ('+01:00' -> 60). */
function offsetOfIso(iso: string): number | undefined {
  if (/Z$/i.test(iso)) return 0;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : undefined;
}

/**
 * Riprende una seduta rimasta aperta (senza `endedAt`). Con lo stato salvato in `foro.live` la ripresa è identica,
 * timer di recupero compreso. Senza, ricostruisce la seduta dalla scheda (se data) e dalle serie registrate.
 * Restituisce undefined se la seduta è già chiusa.
 */
export function resumeSession(saved: GymSession, opts: ResumeOptions = {}): SessionState | undefined {
  if (saved.endedAt) return undefined;
  const foro = (saved as PersistedGymSession).foro;
  const live = foro?.live;
  if (live && live.v === 1) {
    const state: SessionState = { ...live };
    if (saved.id !== undefined) state.sessionId = saved.id;
    return state;
  }

  const startedAt = toMs(saved.startedAt);
  const tz = opts.tzOffsetMin ?? offsetOfIso(saved.startedAt) ?? deviceOffsetMin(startedAt);
  const startOpts: StartOptions = { tzOffsetMin: tz, mode: foro?.modo ?? opts.mode, exercises: opts.exercises };
  const base = opts.template ? startSession(opts.template, opts.history, startedAt, startOpts) : startFreeSession(startedAt, startOpts);
  const draft = deepClone(base);
  draft.date = saved.date;
  if (saved.id !== undefined) draft.sessionId = saved.id;
  if (saved.templateId) draft.templateId = saved.templateId;
  if (saved.programId) draft.programId = saved.programId;
  if (saved.note) draft.note = saved.note;

  const done = saved.sets.filter((l) => l.done).sort(byIndex);
  for (const l of done) {
    const warm = l.type === 'riscaldamento';
    const entries = draft.exercises.filter((e) => e.exerciseId === l.exerciseId);
    let slot: SessionSet | undefined;
    for (const e of entries) {
      slot = e.sets.find((s) => !s.done && (s.type === 'riscaldamento') === warm);
      if (slot) break;
    }
    if (!slot) {
      const lib = getExercise(l.exerciseId, opts.exercises);
      let entry = entries[entries.length - 1];
      if (!entry) {
        entry = {
          key: newKey(draft.counters, 'exercise'),
          exerciseId: l.exerciseId,
          origin: 'aggiunto',
          skipped: false,
          progression: 'doppia',
          incrementKg: lib?.defaultIncrementKg && lib.defaultIncrementKg > 0 ? lib.defaultIncrementKg : 2.5,
          sets: [],
        };
        draft.exercises.push(entry);
      }
      const [min, max] = lib ? defaultRepRange(lib) : [l.reps, l.reps];
      slot = {
        key: newKey(draft.counters, 'set'),
        type: l.type ?? 'normale',
        origin: 'aggiunta',
        repsMin: min,
        repsMax: max,
        restSec: lib ? defaultRestSec(lib) : 90,
        done: false,
      };
      entry.sets.push(slot);
    }
    slot.done = true;
    slot.kg = l.kg;
    slot.reps = l.reps;
    if (l.type) slot.type = l.type;
    if (l.rpe !== undefined) slot.rpe = l.rpe;
    if (l.note) slot.note = l.note;
    slot.doneAt = l.ts ? toMs(l.ts) : startedAt;
  }
  return draft;
}
