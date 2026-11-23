/**
 * Schede di partenza (dati) e piano del giorno.
 *
 * Schede incluse:
 * - 'full-body-ab-3': full body 3 volte a settimana, sedute A e B che si alternano (A B A, poi B A B),
 *   esercizi semplici da imparare; più due corse facili (martedì e sabato).
 * - 'superiore-inferiore-4': superiore/inferiore 4 volte a settimana su giorni fissi
 *   (lunedì, martedì, giovedì, venerdì), per dopo 8-12 settimane di full body; più due corse facili.
 *
 * Settimana tipo del full body: lun A, mar corsa facile, mer B, gio riposo, ven A, sab corsa lunga facile, dom riposo.
 *
 * `todaysPlan` dice cosa tocca oggi:
 * - le sedute con un giorno della settimana (`dayOfWeek`) escono quel giorno;
 * - le sedute di pesi senza giorno ruotano (A, B, A ...) rispetto all'ultima fatta: tocca di nuovo ai pesi
 *   dopo almeno un giorno di riposo e finché non si raggiunge il numero di sedute a settimana (default 3);
 * - un giorno di corsa fissa non riceve anche i pesi: i pesi slittano al giorno dopo;
 * - pesi e corsa nello stesso giorno (se la scheda lo prevede): pesi prima, corsa almeno 6 ore dopo;
 * - mai una corsa dura il giorno prima di una seduta con le gambe (segnalato negli avvisi).
 */
import type {
  Activity,
  GymSession,
  ISODate,
  ISODateTime,
  MuscleGroup,
  Program,
  RunPlan,
  WorkoutTemplate,
} from '../../db/types';
import { addDays, daysBetween, localDateOf, startOfWeek, toISOWithOffset, weekdayMon0, type Instant } from './dates';
import { buildPlannedExercise, requireExercise, toLookup, type ExerciseSource } from './library';

/* -------------------------------------------------------------------- Dati */

interface StarterExerciseSpec {
  id: string;
  /** Serie allenanti. */
  sets: number;
  /** Serie di riscaldamento. */
  warmups?: number;
  note?: string;
}

interface StarterWorkoutSpec {
  name: string;
  kind: 'forza' | 'corsa';
  /** 0 = lunedì … 6 = domenica; senza, la seduta ruota. */
  dayOfWeek?: number;
  exercises?: StarterExerciseSpec[];
  run?: RunPlan;
}

export interface StarterDef {
  id: string;
  name: string;
  description: string;
  gymDaysPerWeek: number;
  runDaysPerWeek: number;
  /** Ogni quante settimane uno scarico. */
  deloadEvery: number;
  notes: string;
  workouts: StarterWorkoutSpec[];
}

const RUN_EASY: RunPlan = {
  type: 'facile',
  targetMinutes: 20,
  zone: 2,
  note: 'Ritmo da conversazione: se non riesci a parlare, rallenta o cammina un minuto.',
};

const RUN_LONG: RunPlan = {
  type: 'lungo',
  targetMinutes: 25,
  zone: 2,
  note: 'Corsa lunga ma facile, sempre in zona 2: conta il tempo, non il passo.',
};

export const STARTERS: readonly StarterDef[] = [
  {
    id: 'full-body-ab-3',
    name: 'Full body A/B 3 volte',
    description:
      'Tre allenamenti a settimana per tutto il corpo, con due sedute A e B che si alternano. Esercizi semplici da imparare, adatta a chi inizia.',
    gymDaysPerWeek: 3,
    runDaysPerWeek: 2,
    deloadEvery: 8,
    notes:
      'Settimana tipo: lunedì pesi, martedì corsa facile, mercoledì pesi, giovedì riposo, venerdì pesi, sabato corsa lunga facile, domenica riposo. ' +
      'Le sedute A e B si alternano (A, B, A la prima settimana, poi B, A, B). ' +
      'Nelle prime due settimane puoi fare una serie in meno per esercizio con la seduta leggera, per imparare i movimenti. ' +
      'Ogni 8 settimane una settimana di scarico: metà delle serie e carichi più leggeri.',
    workouts: [
      {
        name: 'A · Full body',
        kind: 'forza',
        exercises: [
          { id: 'goblet-squat', sets: 3, warmups: 1 },
          { id: 'panca-piana-manubri', sets: 3 },
          { id: 'rematore-manubrio', sets: 3 },
          { id: 'stacco-rumeno-manubri', sets: 3 },
          { id: 'face-pull', sets: 2 },
          { id: 'curl-martello', sets: 3 },
          { id: 'plank', sets: 2 },
          { id: 'calf-in-piedi', sets: 2 },
        ],
      },
      {
        name: 'B · Full body',
        kind: 'forza',
        exercises: [
          { id: 'leg-press', sets: 3, warmups: 1 },
          { id: 'lat-machine-presa-larga', sets: 3 },
          { id: 'panca-inclinata-manubri', sets: 2 },
          { id: 'hip-thrust-bilanciere', sets: 3 },
          { id: 'lento-avanti-manubri', sets: 2 },
          { id: 'croci-cavi', sets: 2 },
          { id: 'leg-curl-sdraiato', sets: 3 },
          { id: 'push-down-corda', sets: 2 },
        ],
      },
      { name: 'Corsa facile', kind: 'corsa', dayOfWeek: 1, run: RUN_EASY },
      { name: 'Corsa lunga facile', kind: 'corsa', dayOfWeek: 5, run: RUN_LONG },
    ],
  },
  {
    id: 'superiore-inferiore-4',
    name: 'Superiore/Inferiore 4 volte',
    description:
      'Quattro allenamenti a settimana: due per la parte alta del corpo e due per le gambe. Per chi ha già fatto 8-12 settimane di full body.',
    gymDaysPerWeek: 4,
    runDaysPerWeek: 2,
    deloadEvery: 6,
    notes:
      'Settimana tipo: lunedì superiore A, martedì inferiore A, mercoledì corsa facile, giovedì superiore B, venerdì inferiore B, sabato corsa lunga facile, domenica riposo. ' +
      'Usa i bilancieri solo quando la tecnica è sicura: in ogni esercizio puoi sostituire con un movimento simile. ' +
      'Ogni 6 settimane una settimana di scarico: metà delle serie e carichi più leggeri.',
    workouts: [
      {
        name: 'A · Superiore',
        kind: 'forza',
        dayOfWeek: 0,
        exercises: [
          { id: 'panca-piana-bilanciere', sets: 3, warmups: 1 },
          { id: 'rematore-bilanciere', sets: 3 },
          { id: 'lento-avanti-manubri', sets: 2 },
          { id: 'lat-machine-presa-stretta', sets: 2 },
          { id: 'chest-press-macchina', sets: 2 },
          { id: 'curl-bilanciere', sets: 2 },
          { id: 'push-down-corda', sets: 3 },
        ],
      },
      {
        name: 'A · Inferiore',
        kind: 'forza',
        dayOfWeek: 1,
        exercises: [
          { id: 'squat-bilanciere', sets: 3, warmups: 1 },
          { id: 'stacco-rumeno-bilanciere', sets: 3 },
          { id: 'hip-thrust-bilanciere', sets: 2 },
          { id: 'leg-curl-sdraiato', sets: 2 },
          { id: 'calf-in-piedi', sets: 3 },
          { id: 'plank', sets: 3 },
        ],
      },
      {
        name: 'B · Superiore',
        kind: 'forza',
        dayOfWeek: 3,
        exercises: [
          { id: 'panca-inclinata-manubri', sets: 3 },
          { id: 'lat-machine-presa-larga', sets: 3 },
          { id: 'pulley-basso', sets: 2 },
          { id: 'alzate-laterali-manubri', sets: 3 },
          { id: 'croci-cavi', sets: 2 },
          { id: 'curl-martello', sets: 3 },
          { id: 'french-press-ez', sets: 2 },
        ],
      },
      {
        name: 'B · Inferiore',
        kind: 'forza',
        dayOfWeek: 4,
        exercises: [
          { id: 'leg-press', sets: 3, warmups: 1 },
          { id: 'hip-thrust-bilanciere', sets: 3 },
          { id: 'bulgarian-split-squat', sets: 2 },
          { id: 'leg-curl-seduto', sets: 3 },
          { id: 'calf-seduto', sets: 3 },
          { id: 'crunch-cavi', sets: 3 },
        ],
      },
      { name: 'Corsa facile', kind: 'corsa', dayOfWeek: 2, run: RUN_EASY },
      { name: 'Corsa lunga facile', kind: 'corsa', dayOfWeek: 5, run: RUN_LONG },
    ],
  },
];

export interface StarterInfo {
  id: string;
  name: string;
  description: string;
  gymDaysPerWeek: number;
  runDaysPerWeek: number;
  deloadEvery: number;
}

export function listStarters(): StarterInfo[] {
  return STARTERS.map(({ id, name, description, gymDaysPerWeek, runDaysPerWeek, deloadEvery }) => ({
    id,
    name,
    description,
    gymDaysPerWeek,
    runDaysPerWeek,
    deloadEvery,
  }));
}

export interface CreateProgramOptions {
  /** Generatore di id: riceve 'programma' o 'seduta'. Di default UUID. */
  idGen?: (prefix: string) => string;
  /** Istante di creazione (default adesso). */
  now?: Instant;
  startDate?: ISODate;
  /** La scheda nasce attiva? Di default no: chi la usa disattiva le altre e poi la attiva. */
  active?: boolean;
  exercises?: ExerciseSource;
}

let idCounter = 0;
function defaultIdGen(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  idCounter++;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Copia nuova della scheda di partenza, con id univoci e sedute collegate al programma. */
export function createProgramFromStarter(
  starterId: string,
  opts: CreateProgramOptions = {},
): { program: Program; templates: WorkoutTemplate[] } {
  const def = STARTERS.find((s) => s.id === starterId);
  if (!def) throw new Error(`Scheda di partenza sconosciuta: ${starterId}`);
  const idGen = opts.idGen ?? defaultIdGen;
  const now: ISODateTime = toISOWithOffset(opts.now ?? new Date());
  const program: Program = {
    id: idGen('programma'),
    name: def.name,
    active: opts.active ?? false,
    deloadEvery: def.deloadEvery,
    notes: def.notes,
    createdAt: now,
    updatedAt: now,
  };
  if (opts.startDate) program.startDate = opts.startDate;

  const templates: WorkoutTemplate[] = [...def.workouts]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'forza' ? -1 : 1))
    .map((w, i) => {
      const t: WorkoutTemplate = {
        id: idGen('seduta'),
        programId: program.id,
        name: w.name,
        kind: w.kind,
        order: i + 1,
        exercises: (w.exercises ?? []).map((e) =>
          buildPlannedExercise(requireExercise(e.id, opts.exercises), { sets: e.sets, warmups: e.warmups, note: e.note }),
        ),
      };
      if (w.dayOfWeek !== undefined) t.dayOfWeek = w.dayOfWeek;
      if (w.run) t.run = { ...w.run };
      return t;
    });
  return { program, templates };
}

/* ------------------------------------------------------------------ Analisi */

const HARD_RUN_TYPES: readonly string[] = ['ripetute', 'tempo', 'progressivo'];

/** Corsa dura: ripetute, tempo o progressivo, oppure zona 3 o più. Gli allunghi brevi non la rendono dura. */
export function isHardRun(run: RunPlan): boolean {
  return HARD_RUN_TYPES.includes(run.type) || (run.zone ?? 2) >= 3;
}

const LEG_MUSCLES: readonly MuscleGroup[] = ['quadricipiti', 'femorali', 'glutei'];

/** Seduta con le gambe: almeno 4 serie allenanti su quadricipiti, femorali o glutei come muscolo primario. */
export function isLegDay(template: WorkoutTemplate, source?: ExerciseSource): boolean {
  if (template.kind !== 'forza') return false;
  const lookup = toLookup(source);
  let sets = 0;
  for (const pe of template.exercises) {
    const ex = lookup.get(pe.exerciseId);
    if (!ex?.primary.some((m) => LEG_MUSCLES.includes(m))) continue;
    sets += pe.sets.filter((s) => (s.type ?? 'normale') !== 'riscaldamento').length;
  }
  return sets >= 4;
}

/** Settimana di scarico prevista dalla scheda: ogni `deloadEvery` settimane dalla data di inizio. */
export function isDeloadWeek(program: Pick<Program, 'startDate' | 'deloadEvery'>, date: ISODate): boolean {
  if (!program.startDate || !program.deloadEvery || program.deloadEvery < 1) return false;
  const weeks = Math.floor(daysBetween(startOfWeek(program.startDate), startOfWeek(date)) / 7);
  return weeks >= 0 && (weeks + 1) % program.deloadEvery === 0;
}

/* ---------------------------------------------------------------- Piano di oggi */

export type TodayStatus = 'da-fare' | 'in-corso' | 'fatta';

export interface TodayItem {
  template: WorkoutTemplate;
  kind: 'forza' | 'corsa';
  status: TodayStatus;
  /** 'giorno-fisso' se la scheda dice il giorno, 'rotazione' se tocca a rotazione. */
  reason: 'giorno-fisso' | 'rotazione';
}

export interface TodayPlan {
  date: ISODate;
  /** 0 = lunedì … 6 = domenica. */
  dayOfWeek: number;
  tipo: 'forza' | 'corsa' | 'doppio' | 'riposo';
  /** Sedute di oggi: i pesi prima, la corsa dopo. Vuoto se è riposo. */
  items: TodayItem[];
  riposo: boolean;
  /** Tutto quello che era previsto oggi è già fatto. */
  completata: boolean;
  /** Una riga: cosa si fa oggi, o perché si riposa. */
  motivo: string;
  avvisi: string[];
  /** Settimana di scarico prevista dalla scheda. */
  deload: boolean;
}

export interface TodayOptions {
  /** Sedute di pesi a settimana per la rotazione (default 3). */
  gymDaysPerWeek?: number;
  /** Corse a settimana per la rotazione delle corse senza giorno (default 2). */
  runDaysPerWeek?: number;
  /** Giorni di riposo minimi tra due sedute di pesi in rotazione (default 1). */
  restDaysBetweenStrength?: number;
  exercises?: ExerciseSource;
}

const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

/** '2026-12-01' -> '1 dicembre'. */
export function formatDateIt(date: ISODate): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS_IT[m - 1]}`;
}

const sessionHappened = (s: GymSession) => s.sets.some((x) => x.done);

interface Virtual {
  strengthDate: ISODate;
  templateId?: string;
  runDate?: ISODate;
}

function planFor(
  program: Program,
  templates: readonly WorkoutTemplate[],
  sessions: readonly GymSession[],
  activities: readonly Activity[],
  date: ISODate,
  opts: TodayOptions,
  virtual?: Virtual,
): TodayPlan {
  const dow = weekdayMon0(date);
  const deload = isDeloadWeek(program, date);
  const base = { date, dayOfWeek: dow, deload };
  const ordered = [...templates].sort((a, b) => a.order - b.order);
  const items: TodayItem[] = [];
  const avvisi: string[] = [];

  if (program.startDate && date < program.startDate) {
    return {
      ...base, tipo: 'riposo', items: [], riposo: true, completata: false, avvisi,
      motivo: `La scheda parte il ${formatDateIt(program.startDate)}.`,
    };
  }
  if (ordered.length === 0) {
    return { ...base, tipo: 'riposo', items: [], riposo: true, completata: false, avvisi, motivo: 'Nessuna seduta in scheda.' };
  }

  // Giorni di pesi già fatti (app e orologio) e corse fatte.
  const strengthSessions = sessions.filter(sessionHappened);
  const strengthDates = new Set<ISODate>(strengthSessions.map((s) => s.date));
  for (const a of activities) if (a.kind === 'forza') strengthDates.add(localDateOf(a.start));
  if (virtual) strengthDates.add(virtual.strengthDate);
  const runDates = new Set<ISODate>(activities.filter((a) => a.kind === 'corsa').map((a) => localDateOf(a.start)));
  if (virtual?.runDate) runDates.add(virtual.runDate);

  const strengthStatus = (t: WorkoutTemplate): TodayStatus => {
    const today = sessions.filter((s) => s.date === date && s.templateId === t.id && sessionHappened(s));
    if (today.length === 0) return 'da-fare';
    return today.some((s) => s.endedAt) ? 'fatta' : 'in-corso';
  };
  const runStatus = (): TodayStatus => (runDates.has(date) ? 'fatta' : 'da-fare');

  const fixedToday = ordered.filter((t) => t.dayOfWeek === dow);
  for (const t of fixedToday.filter((x) => x.kind === 'forza')) {
    items.push({ template: t, kind: 'forza', status: strengthStatus(t), reason: 'giorno-fisso' });
  }
  const fixedRuns = fixedToday.filter((x) => x.kind === 'corsa');
  for (const t of fixedRuns) items.push({ template: t, kind: 'corsa', status: runStatus(), reason: 'giorno-fisso' });

  // Rotazione dei pesi.
  const rotating = ordered.filter((t) => t.kind === 'forza' && t.dayOfWeek === undefined);
  let restReason: string | undefined;
  if (rotating.length > 0 && !items.some((i) => i.kind === 'forza') && fixedRuns.length === 0) {
    const doneToday = rotating.find((t) => sessions.some((s) => s.date === date && s.templateId === t.id && sessionHappened(s)));
    if (doneToday) {
      items.unshift({ template: doneToday, kind: 'forza', status: strengthStatus(doneToday), reason: 'rotazione' });
    } else {
      const prior = [...strengthDates].filter((d) => d < date).sort();
      const last = prior[prior.length - 1];
      const gap = last ? daysBetween(last, date) : Infinity;
      const weekStart = startOfWeek(date);
      const weekCount = [...strengthDates].filter((d) => d >= weekStart && d < date).length;
      const cap = opts.gymDaysPerWeek ?? 3;
      const minGap = (opts.restDaysBetweenStrength ?? 1) + 1;
      if (gap >= minGap && weekCount < cap) {
        const done = strengthSessions
          .filter((s) => s.templateId && rotating.some((t) => t.id === s.templateId) && s.date < date)
          .sort((a, b) => (a.date === b.date ? (a.startedAt < b.startedAt ? 1 : -1) : a.date < b.date ? 1 : -1));
        const lastTemplateId = virtual?.templateId ?? done[0]?.templateId;
        const idx = rotating.findIndex((t) => t.id === lastTemplateId);
        const next = rotating[(idx + 1) % rotating.length];
        items.unshift({ template: next, kind: 'forza', status: 'da-fare', reason: 'rotazione' });
      } else if (weekCount >= cap) {
        restReason = `Hai già fatto ${cap} sedute questa settimana: oggi si recupera.`;
      } else if (gap === 1) {
        const prevSession = strengthSessions.find((s) => s.date === last);
        const prevName = templates.find((t) => t.id === prevSession?.templateId)?.name;
        restReason = prevName ? `Ieri hai fatto ${prevName}: oggi si recupera.` : 'Ieri ti sei allenato: oggi si recupera.';
      } else {
        restReason = 'Oggi si recupera, la prossima seduta di pesi è domani.';
      }
    }
  }

  // Corse in rotazione (senza giorno): solo nei giorni senza altro in programma.
  const rotatingRuns = ordered.filter((t) => t.kind === 'corsa' && t.dayOfWeek === undefined);
  if (rotatingRuns.length > 0 && items.length === 0) {
    const prior = [...runDates].filter((d) => d < date).sort();
    const last = prior[prior.length - 1];
    const gap = last ? daysBetween(last, date) : Infinity;
    const weekStart = startOfWeek(date);
    const weekCount = [...runDates].filter((d) => d >= weekStart && d < date).length;
    if (runDates.has(date)) {
      items.push({ template: rotatingRuns[0], kind: 'corsa', status: 'fatta', reason: 'rotazione' });
    } else if (gap >= 2 && weekCount < (opts.runDaysPerWeek ?? 2)) {
      const runsDone = weekCount;
      items.push({ template: rotatingRuns[runsDone % rotatingRuns.length], kind: 'corsa', status: 'da-fare', reason: 'rotazione' });
    }
  }

  if (items.length === 0) {
    return {
      ...base, tipo: 'riposo', items: [], riposo: true, completata: false, avvisi,
      motivo: restReason ?? 'Giorno di riposo previsto dalla scheda.',
    };
  }

  const hasStrength = items.some((i) => i.kind === 'forza');
  const hasRun = items.some((i) => i.kind === 'corsa');
  const tipo: TodayPlan['tipo'] = hasStrength && hasRun ? 'doppio' : hasStrength ? 'forza' : 'corsa';
  const completata = items.every((i) => i.status === 'fatta');

  if (tipo === 'doppio') avvisi.push('Pesi e corsa nello stesso giorno: prima i pesi, la corsa almeno 6 ore dopo.');

  // Mai una corsa dura il giorno prima delle gambe (solo al primo livello, per non andare in ricorsione).
  if (!virtual) {
    const hardRun = items.find((i) => i.kind === 'corsa' && i.status !== 'fatta' && i.template.run && isHardRun(i.template.run));
    if (hardRun) {
      const tomorrow = planFor(program, templates, sessions, activities, addDays(date, 1), opts, {
        strengthDate: hasStrength ? date : '0000-01-01',
        templateId: items.find((i) => i.kind === 'forza' && i.reason === 'rotazione')?.template.id,
        runDate: date,
      });
      if (tomorrow.items.some((i) => i.kind === 'forza' && isLegDay(i.template, opts.exercises))) {
        avvisi.push('Corsa dura oggi e gambe domani: meglio una corsa facile oggi, oppure sposta la seduta di gambe.');
      }
    }
  }

  const names = items.map((i) => i.template.name);
  let motivo: string;
  if (completata) motivo = `Oggi hai già fatto: ${names.join(' e ')}.`;
  else if (tipo === 'doppio') motivo = `Oggi: ${items[0].template.name} e poi ${items[1].template.name}.`;
  else if (tipo === 'corsa') {
    const run = items[0].template.run;
    motivo = run?.targetMinutes
      ? `Oggi: ${items[0].template.name}, circa ${run.targetMinutes} minuti${run.zone ? ` in zona ${run.zone}` : ''}.`
      : `Oggi: ${items[0].template.name}.`;
  } else motivo = `Oggi: ${items[0].template.name}.`;

  return { ...base, tipo, items, riposo: false, completata, motivo, avvisi };
}

/**
 * Cosa tocca oggi. `sessions` sono le sedute di pesi registrate (anche di altre schede, contano per il recupero),
 * `activities` le attività dell'orologio o importate (corse fatte, forza registrata solo dall'orologio).
 */
export function todaysPlan(
  program: Program,
  templates: readonly WorkoutTemplate[],
  sessions: readonly GymSession[],
  activities: readonly Activity[],
  date: ISODate,
  opts: TodayOptions = {},
): TodayPlan {
  return planFor(program, templates, sessions, activities, date, opts);
}
