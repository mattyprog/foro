import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AppDB } from '../../db/db';
import type { GymSession, LoggedSet, WorkoutTemplate } from '../../db/types';
import { buildPlannedExercise, requireExercise } from './library';
import { historyForExercise } from './records';
import {
  addExercise,
  addSet,
  adjustRest,
  applySuggestion,
  applySuggestions,
  completeSet,
  editSet,
  finishSession,
  nextSet,
  remaining,
  removeSet,
  restRemainingSec,
  restoreExercise,
  resumeSession,
  sessionProgress,
  skipExercise,
  skipRest,
  startFreeSession,
  startSession,
  substituteExercise,
  tickRest,
  toGymSession,
  uncompleteSet,
  withSessionId,
} from './session';
import type { PersistedGymSession, SessionState } from './types';

const TZ = 60;
const T0 = Date.UTC(2026, 10, 23, 17, 0, 0); // lunedì 23 novembre 2026, 18:00 a Roma
const sec = (n: number) => n * 1000;
const opts = { tzOffsetMin: TZ };

function template(): WorkoutTemplate {
  return {
    id: 'tpl-A',
    programId: 'prg-1',
    name: 'A · Full body',
    kind: 'forza',
    order: 1,
    exercises: [
      buildPlannedExercise(requireExercise('squat-bilanciere'), { sets: 3, warmups: 1 }),
      buildPlannedExercise(requireExercise('panca-piana-manubri'), { sets: 3 }),
      buildPlannedExercise(requireExercise('curl-manubri'), { sets: 2 }),
    ],
  };
}

type Row = [kg: number, reps: number, rpe?: number];
const rows = (exerciseId: string, list: Row[], type: LoggedSet['type'] = 'normale', from = 0): LoggedSet[] =>
  list.map(([kg, reps, rpe], i) => ({ exerciseId, setIndex: from + i, kg, reps, rpe, type, done: true }));

function pastSession(date: string, sets: LoggedSet[], extra: Partial<GymSession> & { modo?: string } = {}): GymSession {
  const { modo, ...rest } = extra;
  const s: GymSession = { date, startedAt: `${date}T18:00:00+01:00`, endedAt: `${date}T19:00:00+01:00`, sets, ...rest };
  if (modo) (s as PersistedGymSession).foro = { v: 1, modo: modo as 'scarico' };
  return s;
}

/** Due sedute passate: 16 novembre e 19 novembre (la più recente). */
function history(): GymSession[] {
  return [
    pastSession('2026-11-16', [
      ...rows('squat-bilanciere', [[30, 8]], 'riscaldamento'),
      ...rows('squat-bilanciere', [[60, 8, 8], [60, 8, 8], [60, 7, 9]], 'normale', 1),
      ...rows('panca-piana-manubri', [[24, 8, 8], [24, 8, 8], [24, 8, 8]]),
      ...rows('curl-manubri', [[10, 12, 8], [10, 12, 8]]),
    ]),
    pastSession('2026-11-19', [
      ...rows('squat-bilanciere', [[60, 10, 8], [60, 10, 7], [60, 10, 8]]),
      ...rows('panca-piana-manubri', [[24, 9, 8], [24, 8, 8], [24, 8, 8]]),
      ...rows('curl-manubri', [[10, 13, 8], [10, 12, 8]]),
    ]),
  ];
}

const setOf = (s: SessionState, e: number, i: number) => s.exercises[e].sets[i];
const allSets = (s: SessionState) => s.exercises.flatMap((e) => e.sets);

describe('startSession', () => {
  it('crea esercizi e serie dalla scheda con data, fuso e chiavi uniche', () => {
    const s = startSession(template(), [], T0, opts);
    expect(s).toMatchObject({ v: 1, templateId: 'tpl-A', programId: 'prg-1', name: 'A · Full body', mode: 'normale', date: '2026-11-23' });
    expect(s.startedAt).toBe(T0);
    expect(s.endedAt).toBeUndefined();
    expect(s.exercises.map((e) => [e.exerciseId, e.sets.length])).toEqual([
      ['squat-bilanciere', 4],
      ['panca-piana-manubri', 3],
      ['curl-manubri', 2],
    ]);
    expect(s.exercises[0].sets.map((x) => x.type)).toEqual(['riscaldamento', 'normale', 'normale', 'normale']);
    expect(s.exercises[0].progression).toBe('doppia');
    expect(s.exercises[0].incrementKg).toBe(2.5);
    expect(s.exercises.every((e) => e.origin === 'piano' && !e.skipped)).toBe(true);
    const keys = [...s.exercises.map((e) => e.key), ...allSets(s).map((x) => x.key)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(allSets(s).every((x) => !x.done && x.origin === 'piano')).toBe(true);
  });

  it('la data è quella locale: mezzanotte passata a Roma è già il giorno dopo', () => {
    const s = startSession(template(), [], Date.UTC(2026, 10, 23, 23, 30, 0), opts);
    expect(s.date).toBe('2026-11-24');
  });

  it('precompila i valori dell\'ultima volta e mostra il suggerimento di progressione', () => {
    const s = startSession(template(), history(), T0, opts);
    const squat = s.exercises[0];
    // tutte le serie a 10 con RPE 8 o meno: il suggerimento sale a 62,5 kg, il precompilato resta l'ultima volta
    expect(squat.sets[1]).toMatchObject({ kg: 60, reps: 10, previous: { kg: 60, reps: 10, rpe: 8 } });
    expect(squat.sets[1].suggestion).toMatchObject({ kg: 62.5, repsTarget: 6 });
    expect(squat.sets[1].suggestion!.motivo).toMatch(/62,5 kg/);
    expect(squat.motivo).toMatch(/62,5 kg/);
    expect(squat.lastTime).toEqual({
      date: '2026-11-19',
      sets: [{ kg: 60, reps: 10, rpe: 8 }, { kg: 60, reps: 10, rpe: 7 }, { kg: 60, reps: 10, rpe: 8 }],
    });
    const panca = s.exercises[1];
    expect(panca.sets.map((x) => [x.kg, x.reps])).toEqual([[24, 9], [24, 8], [24, 8]]);
    expect(panca.sets.map((x) => x.suggestion!.repsTarget)).toEqual([10, 9, 9]);
  });

  it('il riscaldamento parte dal carico di lavoro suggerito', () => {
    const s = startSession(template(), history(), T0, opts);
    expect(setOf(s, 0, 0)).toMatchObject({ type: 'riscaldamento', kg: 31.25, reps: 8 });
  });

  it('se il suggerimento è più leggero (due sedute sotto il minimo) precompila il carico ridotto, non quello che non è riuscito', () => {
    const fallito = [[60, 5, 9], [60, 5, 9], [60, 4, 10]] as Row[];
    const storia = [pastSession('2026-11-16', rows('squat-bilanciere', fallito)), pastSession('2026-11-19', rows('squat-bilanciere', fallito))];
    const s = startSession(template(), storia, T0, opts);
    const first = setOf(s, 0, 1);
    expect(first.previous).toEqual({ kg: 60, reps: 5, rpe: 9 });
    expect(first.suggestion).toMatchObject({ kg: 53.75, repsTarget: 6 });
    expect(first).toMatchObject({ kg: 53.75, reps: 6 });
    // con una sola seduta sotto il minimo il carico non scende: si ripete quello dell'ultima volta
    const una = startSession(template(), [storia[1]], T0, opts);
    expect(setOf(una, 0, 1)).toMatchObject({ kg: 60, reps: 5 });
    expect(setOf(una, 0, 1).suggestion).toMatchObject({ kg: 60, repsTarget: 6 });
  });

  it('con una macchina assistita più aiuto è più facile: si precompila l\'aiuto suggerito; meno aiuto resta un suggerimento', () => {
    const t: WorkoutTemplate = { ...template(), exercises: [buildPlannedExercise(requireExercise('trazioni-assistite'), { sets: 2 })] };
    // due sedute sotto le 6 ripetizioni: il suggerimento aumenta l'aiuto (più facile) e si precompila
    const giu = [
      pastSession('2026-11-16', rows('trazioni-assistite', [[30, 4], [30, 4]])),
      pastSession('2026-11-19', rows('trazioni-assistite', [[30, 4], [30, 4]])),
    ];
    const a = startSession(t, giu, T0, opts);
    expect(setOf(a, 0, 0).suggestion!.kg).toBeGreaterThan(30);
    expect(setOf(a, 0, 0).kg).toBe(setOf(a, 0, 0).suggestion!.kg);
    // tutte le serie al massimo con RPE 8: il suggerimento riduce l'aiuto (più difficile) e il precompilato resta l'ultima volta
    const su = [pastSession('2026-11-19', rows('trazioni-assistite', [[30, 10, 8], [30, 10, 8]]))];
    const b = startSession(t, su, T0, opts);
    expect(setOf(b, 0, 0).suggestion!.kg).toBeLessThan(30);
    expect(setOf(b, 0, 0)).toMatchObject({ kg: 30, reps: 10 });
  });

  it('alla prima volta non inventa il carico: kg vuoti e ripetizioni al minimo', () => {
    const s = startSession(template(), [], T0, opts);
    expect(setOf(s, 0, 1).kg).toBeUndefined();
    expect(setOf(s, 0, 1).reps).toBe(6);
    expect(setOf(s, 0, 1).suggestion!.motivo).toMatch(/^Prima volta/);
    expect(setOf(s, 0, 1).previous).toBeUndefined();
  });

  it('non usa nello storico le sedute di scarico né quelle non chiuse', () => {
    const sporco = [
      ...history(),
      pastSession('2026-11-21', rows('squat-bilanciere', [[50, 8], [50, 8]]), { modo: 'scarico' }),
      pastSession('2026-11-22', rows('squat-bilanciere', [[100, 3]]), { endedAt: undefined }),
    ];
    const s = startSession(template(), sporco, T0, opts);
    expect(setOf(s, 0, 1).previous).toEqual({ kg: 60, reps: 10, rpe: 8 });
    expect(s.exercises[0].lastTime!.date).toBe('2026-11-19');
  });

  it('accetta anche lo storico già raggruppato per esercizio', () => {
    const dict = { 'squat-bilanciere': [rows('squat-bilanciere', [[70, 6], [70, 6], [70, 6]])] };
    const s = startSession(template(), dict, T0, opts);
    expect(setOf(s, 0, 1).previous).toEqual({ kg: 70, reps: 6, rpe: undefined });
    expect(setOf(s, 0, 1).kg).toBe(70);
    expect(s.exercises[0].lastTime!.date).toBeUndefined();
  });

  it('scarico: metà delle serie e si precompila il carico ridotto, non quello dell\'ultima volta', () => {
    const s = startSession(template(), history(), T0, { ...opts, mode: 'scarico' });
    expect(s.mode).toBe('scarico');
    const squat = s.exercises[0];
    expect(squat.sets.filter((x) => x.type !== 'riscaldamento')).toHaveLength(2);
    expect(squat.sets[1].kg).toBe(53.75);
    expect(s.exercises[1].sets).toHaveLength(2);
    expect(s.exercises[1].sets[0].kg).toBeLessThan(24);
  });

  it('leggero: un terzo di serie in meno e nessun aumento di carico', () => {
    const s = startSession(template(), history(), T0, { ...opts, mode: 'leggero' });
    expect(s.exercises[0].sets.filter((x) => x.type !== 'riscaldamento')).toHaveLength(2);
    expect(setOf(s, 0, 1).suggestion!.kg).toBe(60);
    expect(s.exercises[2].sets).toHaveLength(1);
  });

  it('una seduta libera parte senza esercizi', () => {
    const s = startFreeSession(T0, opts);
    expect(s.exercises).toEqual([]);
    expect(s.templateId).toBeUndefined();
    expect(nextSet(s)).toBeUndefined();
  });

  it('un esercizio sconosciuto è un errore chiaro', () => {
    const t = template();
    t.exercises[0].exerciseId = 'esercizio-inventato';
    expect(() => startSession(t, [], T0, opts)).toThrow(/esercizio-inventato/);
  });
});

describe('registrare una serie', () => {
  it('con i valori già compilati basta un tocco: la serie è fatta e il recupero parte da solo', () => {
    let s = startSession(template(), history(), T0, opts);
    const key = setOf(s, 0, 1).key;
    s = completeSet(s, key, T0 + sec(60));
    const done = setOf(s, 0, 1);
    expect(done).toMatchObject({ done: true, kg: 60, reps: 10, doneAt: T0 + sec(60) });
    expect(s.rest).toMatchObject({ startedAt: T0 + sec(60), endsAt: T0 + sec(60) + sec(150), durationSec: 150, setKey: key });
  });

  it('con una correzione bastano due tocchi: valori nuovi e serie completata', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(60), { kg: 62.5, reps: 6, rpe: 8, note: 'bilanciere pesante' });
    expect(setOf(s, 0, 1)).toMatchObject({ kg: 62.5, reps: 6, rpe: 8, note: 'bilanciere pesante', done: true });
  });

  it('il riscaldamento non ha mai un recupero più lungo di 60 secondi', () => {
    const t = template();
    t.exercises[0].sets[0].restSec = 120;
    let s = startSession(t, history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 0).key, T0);
    expect(s.rest!.durationSec).toBe(60);
  });

  it('senza kg non si può completare, con kg sì', () => {
    let s = startSession(template(), [], T0, opts);
    const key = setOf(s, 0, 1).key;
    expect(() => completeSet(s, key, T0)).toThrow(/kg/);
    s = completeSet(s, key, T0, { kg: 40 });
    expect(setOf(s, 0, 1)).toMatchObject({ kg: 40, reps: 6, done: true });
  });

  it('completare due volte la stessa serie non cambia nulla', () => {
    let s = startSession(template(), history(), T0, opts);
    const key = setOf(s, 0, 1).key;
    s = completeSet(s, key, T0 + sec(10));
    const again = completeSet(s, key, T0 + sec(99));
    expect(again).toBe(s);
  });

  it('lo stato originale non viene modificato', () => {
    const s0 = startSession(template(), history(), T0, opts);
    const snapshot = JSON.stringify(s0);
    completeSet(s0, setOf(s0, 0, 1).key, T0, { kg: 61 });
    editSet(s0, setOf(s0, 0, 1).key, { reps: 3 });
    addSet(s0, s0.exercises[0].key);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it('dopo l\'ultima serie non parte nessun recupero', () => {
    const t: WorkoutTemplate = { ...template(), exercises: [buildPlannedExercise(requireExercise('curl-manubri'), { sets: 1 })] };
    let s = startSession(t, history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 0).key, T0);
    expect(s.rest).toBeUndefined();
  });

  it('uncompleteSet annulla una serie segnata per sbaglio e ferma il recupero collegato', () => {
    let s = startSession(template(), history(), T0, opts);
    const key = setOf(s, 0, 1).key;
    s = completeSet(s, key, T0);
    s = uncompleteSet(s, key);
    expect(setOf(s, 0, 1).done).toBe(false);
    expect(setOf(s, 0, 1).doneAt).toBeUndefined();
    expect(s.rest).toBeUndefined();
  });

  it('applySuggestion copia il suggerimento nei valori della serie, applySuggestions in tutte quelle dell\'esercizio', () => {
    let s = startSession(template(), history(), T0, opts);
    s = applySuggestion(s, setOf(s, 0, 1).key);
    expect(setOf(s, 0, 1)).toMatchObject({ kg: 62.5, reps: 6 });
    expect(setOf(s, 0, 2).kg).toBe(60);
    s = applySuggestions(s, s.exercises[0].key);
    expect(s.exercises[0].sets.filter((x) => x.type !== 'riscaldamento').map((x) => [x.kg, x.reps])).toEqual([[62.5, 6], [62.5, 6], [62.5, 6]]);
  });
});

describe('modificare la seduta al volo', () => {
  it('editSet cambia carico, ripetizioni, RPE e nota, anche su una serie già fatta', () => {
    let s = startSession(template(), history(), T0, opts);
    const key = setOf(s, 1, 0).key;
    s = completeSet(s, key, T0);
    s = editSet(s, key, { kg: 26, reps: 7, rpe: 9, note: 'spalla un po\' tesa' });
    expect(setOf(s, 1, 0)).toMatchObject({ kg: 26, reps: 7, rpe: 9, note: 'spalla un po\' tesa', done: true });
    expect(() => editSet(s, 'inesistente', { kg: 1 })).toThrow(/inesistente/);
  });

  it('l\'RPE si può registrare solo da 6 a 10', () => {
    const s = startSession(template(), history(), T0, opts);
    const key = setOf(s, 1, 0).key;
    expect(editSet(s, key, { rpe: 6 }).exercises[1].sets[0].rpe).toBe(6);
    expect(editSet(s, key, { rpe: 10 }).exercises[1].sets[0].rpe).toBe(10);
    expect(() => editSet(s, key, { rpe: 5 })).toThrow(/RPE/);
    expect(() => editSet(s, key, { rpe: 11 })).toThrow(/RPE/);
    // un RPE con la mezza unità (8,5) è valido
    expect(editSet(s, key, { rpe: 8.5 }).exercises[1].sets[0].rpe).toBe(8.5);
  });

  it('addSet aggiunge una serie copiando l\'ultima dell\'esercizio', () => {
    let s = startSession(template(), history(), T0, opts);
    s = editSet(s, setOf(s, 1, 2).key, { kg: 26, reps: 7 });
    s = addSet(s, s.exercises[1].key);
    expect(s.exercises[1].sets).toHaveLength(4);
    expect(setOf(s, 1, 3)).toMatchObject({ kg: 26, reps: 7, origin: 'aggiunta', done: false, type: 'normale' });
    const keys = allSets(s).map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    // si può indicare il tipo
    const w = addSet(s, s.exercises[1].key, { type: 'riscaldamento', kg: 10, reps: 10 });
    expect(w.exercises[1].sets[4]).toMatchObject({ type: 'riscaldamento', kg: 10, reps: 10 });
  });

  it('removeSet toglie una serie non fatta, non una già registrata', () => {
    let s = startSession(template(), history(), T0, opts);
    const key = setOf(s, 1, 2).key;
    s = removeSet(s, key);
    expect(s.exercises[1].sets).toHaveLength(2);
    const done = completeSet(s, setOf(s, 1, 0).key, T0);
    expect(() => removeSet(done, setOf(done, 1, 0).key)).toThrow(/già/);
  });

  it('addExercise aggiunge un esercizio in fondo con valori dall\'ultima volta', () => {
    const storia = [...history(), pastSession('2026-11-20', rows('curl-martello', [[12, 11, 8], [12, 10, 8], [12, 10, 9]]))];
    let s = startSession(template(), storia, T0, opts);
    s = addExercise(s, 'curl-martello', { history: storia, sets: 3 });
    const e = s.exercises[3];
    expect(e).toMatchObject({ exerciseId: 'curl-martello', origin: 'aggiunto', skipped: false });
    expect(e.sets).toHaveLength(3);
    expect(e.sets.map((x) => [x.kg, x.reps, x.origin])).toEqual([[12, 11, 'aggiunta'], [12, 10, 'aggiunta'], [12, 10, 'aggiunta']]);
    expect(e.lastTime!.date).toBe('2026-11-20');
    expect(s.baselines['curl-martello']).toBeDefined();
  });

  it('addExercise senza storico parte da una scheda di default e dopo un esercizio indicato', () => {
    let s = startSession(template(), [], T0, opts);
    s = addExercise(s, 'face-pull', { afterKey: s.exercises[0].key });
    expect(s.exercises.map((e) => e.exerciseId)).toEqual(['squat-bilanciere', 'face-pull', 'panca-piana-manubri', 'curl-manubri']);
    expect(s.exercises[1].sets).toHaveLength(3);
    expect(s.exercises[1].sets[0]).toMatchObject({ repsMin: 10, repsMax: 15, kg: undefined, reps: 10 });
    expect(() => addExercise(s, 'non-esiste')).toThrow(/non-esiste/);
  });
});

describe('sostituzione con uno stesso schema motorio', () => {
  it('rifiuta un esercizio di un altro schema', () => {
    const s = startSession(template(), history(), T0, opts);
    expect(() => substituteExercise(s, s.exercises[0].key, 'curl-manubri')).toThrow(/schema motorio/);
    expect(() => substituteExercise(s, s.exercises[0].key, 'squat-bilanciere')).toThrow();
  });

  it('prima di fare serie sostituisce sul posto e ricarica i valori dell\'esercizio nuovo', () => {
    const storia = [...history(), pastSession('2026-11-20', rows('leg-press', [[120, 10, 8], [120, 9, 8], [120, 9, 8]]))];
    let s = startSession(template(), storia, T0, opts);
    s = substituteExercise(s, s.exercises[0].key, 'leg-press', { history: storia });
    const e = s.exercises[0];
    expect(e.exerciseId).toBe('leg-press');
    expect(e.replacedExerciseId).toBe('squat-bilanciere');
    expect(e.sets).toHaveLength(4);
    expect(e.sets.filter((x) => x.type !== 'riscaldamento').map((x) => [x.kg, x.reps])).toEqual([[120, 10], [120, 9], [120, 9]]);
    expect(e.sets.every((x) => x.origin === 'piano' && !x.done)).toBe(true);
    expect(s.exercises).toHaveLength(3);
    expect(s.baselines['leg-press']).toBeDefined();
  });

  it('dopo aver fatto delle serie, quelle restano all\'esercizio vecchio e le altre passano al nuovo', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 0).key, T0);
    s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(80), { kg: 60, reps: 8 });
    s = substituteExercise(s, s.exercises[0].key, 'goblet-squat', { history: history() });
    expect(s.exercises.map((e) => e.exerciseId)).toEqual(['squat-bilanciere', 'goblet-squat', 'panca-piana-manubri', 'curl-manubri']);
    expect(s.exercises[0].sets.map((x) => x.done)).toEqual([true, true]);
    const nuovo = s.exercises[1];
    expect(nuovo.replacedExerciseId).toBe('squat-bilanciere');
    expect(nuovo.sets).toHaveLength(2);
    expect(nuovo.sets.every((x) => !x.done)).toBe(true);
    // niente serie perse né doppie rispetto alla scheda
    const p = sessionProgress(s);
    expect(p.planned).toBe(8);
  });

  it('da un esercizio a tempo a uno a ripetizioni usa gli intervalli dell\'esercizio nuovo', () => {
    const t: WorkoutTemplate = { ...template(), exercises: [buildPlannedExercise(requireExercise('plank'), { sets: 2 })] };
    let s = startSession(t, [], T0, opts);
    expect(setOf(s, 0, 0)).toMatchObject({ repsMin: 30, repsMax: 60 });
    s = substituteExercise(s, s.exercises[0].key, 'dead-bug');
    expect(setOf(s, 0, 0)).toMatchObject({ repsMin: 10, repsMax: 15, reps: 10 });
  });
});

describe('saltare un esercizio e ordine delle serie', () => {
  it('nextSet segue l\'ordine della scheda e salta gli esercizi saltati', () => {
    let s = startSession(template(), history(), T0, opts);
    expect(nextSet(s)!.set.key).toBe(setOf(s, 0, 0).key);
    s = completeSet(s, setOf(s, 0, 0).key, T0);
    expect(nextSet(s)!.set.key).toBe(setOf(s, 0, 1).key);
    s = skipExercise(s, s.exercises[0].key);
    expect(s.exercises[0].skipped).toBe(true);
    expect(nextSet(s)!.exercise.exerciseId).toBe('panca-piana-manubri');
    s = restoreExercise(s, s.exercises[0].key);
    expect(nextSet(s)!.exercise.exerciseId).toBe('squat-bilanciere');
  });

  it('se tutto è fatto o saltato non c\'è una serie successiva', () => {
    let s = startSession(template(), history(), T0, opts);
    for (const e of s.exercises) s = skipExercise(s, e.key);
    expect(nextSet(s)).toBeUndefined();
  });

  it('nelle superserie si alternano gli esercizi e il recupero parte solo a fine giro', () => {
    const t = template();
    t.exercises = [
      { ...buildPlannedExercise(requireExercise('curl-manubri'), { sets: 2 }), supersetGroup: 'ss1' },
      { ...buildPlannedExercise(requireExercise('push-down-corda'), { sets: 2 }), supersetGroup: 'ss1' },
    ];
    let s = startSession(t, history(), T0, opts);
    const a1 = setOf(s, 0, 0);
    expect(nextSet(s)!.set.key).toBe(a1.key);
    s = completeSet(s, a1.key, T0, { kg: 10, reps: 12 });
    expect(s.rest).toBeUndefined();
    expect(nextSet(s)!.exercise.exerciseId).toBe('push-down-corda');
    s = completeSet(s, setOf(s, 1, 0).key, T0 + sec(30), { kg: 20, reps: 12 });
    expect(s.rest).toBeDefined();
    expect(nextSet(s)!.exercise.exerciseId).toBe('curl-manubri');
  });

  it('sessionProgress conta serie fatte, previste e aggiunte', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 0).key, T0); // riscaldamento
    s = completeSet(s, setOf(s, 0, 1).key, T0);
    s = addSet(s, s.exercises[2].key);
    expect(sessionProgress(s)).toMatchObject({ done: 1, planned: 8, extra: 1, pending: 8, warmupDone: 1 });
  });
});

describe('timer di recupero', () => {
  it('remaining arrotonda per eccesso e non scende sotto zero', () => {
    expect(remaining({ endsAt: 10_500 }, 0)).toBe(11);
    expect(remaining({ endsAt: 10_000 }, 0)).toBe(10);
    expect(remaining({ endsAt: 10_000 }, 9_001)).toBe(1);
    expect(remaining({ endsAt: 1_000 }, 5_000)).toBe(0);
    expect(remaining({ endsAt: 1_000 }, new Date(500))).toBe(1);
  });

  it('restRemainingSec parte dalla fine del recupero e non c\'è senza timer', () => {
    let s = startSession(template(), history(), T0, opts);
    expect(restRemainingSec(s, T0)).toBeUndefined();
    s = completeSet(s, setOf(s, 0, 1).key, T0);
    expect(restRemainingSec(s, T0)).toBe(150);
    expect(restRemainingSec(s, T0 + sec(100))).toBe(50);
    expect(restRemainingSec(s, T0 + sec(400))).toBe(0);
  });

  it('segnala una volta sola i 10 secondi e una volta sola la fine', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0); // fine a +150 s
    const at = (secs: number) => {
      const r = tickRest(s, T0 + sec(secs));
      s = r.state;
      return r.signals;
    };
    expect(at(100)).toEqual([]);
    expect(at(139)).toEqual([]);
    expect(at(140)).toEqual(['avviso-10s']);
    expect(at(141)).toEqual([]);
    expect(at(149)).toEqual([]);
    expect(at(150)).toEqual(['fine']);
    expect(at(151)).toEqual([]);
    expect(at(200)).toEqual([]);
  });

  it('se l\'app torna dopo la fine dà solo il segnale di fine, non l\'avviso scaduto', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0);
    const r = tickRest(s, T0 + sec(900));
    expect(r.signals).toEqual(['fine']);
  });

  it('un recupero di 10 secondi o meno ha solo il segnale di fine', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0);
    s = skipRest(s);
    expect(s.rest).toBeUndefined();
    const t: WorkoutTemplate = { ...template() };
    t.exercises = [buildPlannedExercise(requireExercise('curl-manubri'), { sets: 2, restSec: 8 })];
    let q = startSession(t, history(), T0, opts);
    q = completeSet(q, setOf(q, 0, 0).key, T0);
    expect(tickRest(q, T0 + sec(1)).signals).toEqual([]);
    expect(tickRest(q, T0 + sec(8)).signals).toEqual(['fine']);
  });

  it('adjustRest aggiunge o toglie secondi e riarma i segnali', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0);
    s = tickRest(s, T0 + sec(150)).state; // finito
    s = adjustRest(s, 30, T0 + sec(150));
    expect(restRemainingSec(s, T0 + sec(150))).toBe(30);
    expect(tickRest(s, T0 + sec(175)).signals).toEqual(['avviso-10s']);
    const meno = adjustRest(s, -20, T0 + sec(150));
    expect(restRemainingSec(meno, T0 + sec(150))).toBe(10);
    const azzera = adjustRest(s, -999, T0 + sec(150));
    expect(restRemainingSec(azzera, T0 + sec(150))).toBe(0);
  });

  it('il timer sopravvive alla chiusura dell\'app: si ricostruisce dall\'istante di fine', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(60));
    const salvata = JSON.parse(JSON.stringify(toGymSession(s)));
    const ripresa = resumeSession(salvata)!;
    expect(ripresa.rest!.endsAt).toBe(T0 + sec(60) + sec(150));
    // l'app riapre 100 secondi dopo la serie: restano 50 secondi
    expect(restRemainingSec(ripresa, T0 + sec(160))).toBe(50);
    // e se riapre dopo la fine il timer è già a zero
    expect(restRemainingSec(ripresa, T0 + sec(2000))).toBe(0);
  });
});

describe('chiudere la seduta', () => {
  function seduta(skipCurl = false) {
    let s = startSession(template(), history(), T0, opts);
    let t = T0;
    const fai = (e: number, i: number, kg: number, reps: number, rpe?: number) => {
      t += sec(150);
      s = completeSet(s, setOf(s, e, i).key, t, { kg, reps, rpe });
    };
    fai(0, 0, 30, 8); // riscaldamento
    fai(0, 1, 62.5, 6, 8);
    fai(0, 2, 62.5, 6, 8);
    fai(0, 3, 62.5, 5, 9);
    fai(1, 0, 24, 10, 8);
    fai(1, 1, 24, 9, 8);
    fai(1, 2, 24, 9, 8);
    if (skipCurl) s = skipExercise(s, s.exercises[2].key);
    else {
      fai(2, 0, 10, 14, 8);
      fai(2, 1, 10, 12, 8);
    }
    return s;
  }

  it('riepilogo: durata, tonnellaggio, serie fatte e pianificate', () => {
    const s = seduta();
    const fine = T0 + sec(55 * 60);
    const { summary, state } = finishSession(s, fine, { history: history() });
    expect(state.endedAt).toBe(fine);
    expect(summary.durataSec).toBe(55 * 60);
    // riscaldamento escluso
    const tonn = 62.5 * 6 + 62.5 * 6 + 62.5 * 5 + 24 * 10 + 24 * 9 + 24 * 9 + 10 * 14 + 10 * 12;
    expect(summary.tonnellaggioKg).toBe(tonn);
    expect(summary).toMatchObject({ serieFatte: 8, seriePianificate: 8, serieRiscaldamento: 1, eserciziFatti: 3, eserciziSaltati: 0, completamento: 100 });
    expect(summary.perEsercizio.map((e) => [e.exerciseId, e.serieFatte])).toEqual([
      ['squat-bilanciere', 3],
      ['panca-piana-manubri', 3],
      ['curl-manubri', 2],
    ]);
    expect(summary.perEsercizio[0]).toMatchObject({ nome: 'Squat con bilanciere', tonnellaggioKg: 62.5 * 17, migliorSerie: { kg: 62.5, reps: 6 } });
    expect(summary.perMuscolo.quadricipiti).toBe(3);
    expect(summary.perMuscolo.petto).toBe(3);
    expect(summary.perMuscolo.glutei).toBe(1.5);
  });

  it('riconosce i record rispetto allo storico e li scrive in italiano', () => {
    const { summary } = finishSession(seduta(), T0 + sec(3000), { history: history() });
    const tipi = summary.record.filter((r) => r.exerciseId === 'squat-bilanciere').map((r) => r.tipo);
    expect(tipi).toContain('carico');
    expect(summary.recordTesti.some((t) => /Squat con bilanciere: nuovo massimo di carico, 62,5 kg \(prima 60 kg\)/.test(t))).toBe(true);
    // panca 24 x 10 supera 24 x 9 a parità di carico
    expect(summary.record.some((r) => r.exerciseId === 'panca-piana-manubri' && r.tipo === 'ripetizioni' && r.reps === 10)).toBe(true);
    // il curl 10 x 14 (14 ripetizioni) non fa e1RM, ma supera le ripetizioni a 10 kg
    expect(summary.record.some((r) => r.exerciseId === 'curl-manubri' && r.tipo === 'e1rm')).toBe(false);
    expect(summary.record.some((r) => r.exerciseId === 'curl-manubri' && r.tipo === 'ripetizioni')).toBe(true);
  });

  it('non segnala record alla prima volta che si fa un esercizio', () => {
    let s = startSession(template(), [], T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0, { kg: 50, reps: 8 });
    const { summary } = finishSession(s, T0 + sec(600));
    expect(summary.record).toEqual([]);
    expect(summary.recordTesti).toEqual([]);
  });

  it('un esercizio saltato abbassa il completamento ma non conta come fatto', () => {
    const { summary } = finishSession(seduta(true), T0 + sec(3000), { history: history() });
    expect(summary).toMatchObject({ serieFatte: 6, seriePianificate: 8, eserciziFatti: 2, eserciziSaltati: 1, completamento: 75 });
  });

  it('le serie aggiunte al volo contano come fatte ma non come pianificate', () => {
    let s = seduta();
    s = addSet(s, s.exercises[2].key, { kg: 10, reps: 10 });
    s = completeSet(s, s.exercises[2].sets[2].key, T0 + sec(2900));
    const { summary } = finishSession(s, T0 + sec(3000), { history: history() });
    expect(summary).toMatchObject({ serieFatte: 9, seriePianificate: 8, completamento: 100 });
  });

  it('la seduta salvata contiene solo le serie fatte, con indice per esercizio, ora e nota', () => {
    let s = seduta();
    s = editSet(s, setOf(s, 0, 1).key, { note: 'ottima profondità' });
    const { session } = finishSession(s, T0 + sec(3300), { history: history() });
    expect(session.date).toBe('2026-11-23');
    expect(session.templateId).toBe('tpl-A');
    expect(session.programId).toBe('prg-1');
    expect(session.startedAt).toBe('2026-11-23T18:00:00+01:00');
    expect(session.endedAt).toBe('2026-11-23T18:55:00+01:00');
    expect(session.sets).toHaveLength(9);
    const sq = session.sets.filter((x) => x.exerciseId === 'squat-bilanciere');
    expect(sq.map((x) => x.setIndex)).toEqual([0, 1, 2, 3]);
    expect(sq.map((x) => x.type)).toEqual(['riscaldamento', 'normale', 'normale', 'normale']);
    expect(sq[1]).toMatchObject({ kg: 62.5, reps: 6, rpe: 8, done: true, note: 'ottima profondità' });
    expect(sq[1].ts).toMatch(/^2026-11-23T\d{2}:\d{2}:\d{2}\+01:00$/);
    expect((session as PersistedGymSession).foro).toEqual({ v: 1, modo: 'normale' });
  });

  it('una seduta di scarico chiusa non entra più nello storico per la progressione', () => {
    let s = startSession(template(), history(), T0, { ...opts, mode: 'scarico' });
    s = completeSet(s, setOf(s, 0, 1).key, T0, { kg: 53.75, reps: 8 });
    const { session } = finishSession(s, T0 + sec(1800), { history: history() });
    expect((session as PersistedGymSession).foro!.modo).toBe('scarico');
    const h = historyForExercise([...history(), session], 'squat-bilanciere');
    expect(h[0][0].kg).toBe(60);
  });

  it('dopo la chiusura lo stato non si può più modificare in modo utile e la seduta non è riprendibile', () => {
    const s = seduta();
    const { state, session } = finishSession(s, T0 + sec(3000), { history: history() });
    expect(state.rest).toBeUndefined();
    expect(resumeSession(session)).toBeUndefined();
  });
});

describe('salvataggio e ripresa (Dexie)', () => {
  it('toGymSession in corso: senza endedAt, solo serie fatte, con lo stato per la ripresa', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(70));
    const g = toGymSession(s) as PersistedGymSession;
    expect(g.endedAt).toBeUndefined();
    expect(g.id).toBeUndefined();
    expect(g.sets).toHaveLength(1);
    expect(g.foro!.modo).toBe('normale');
    expect(g.foro!.live).toBeDefined();
    expect(withSessionId(s, 12).sessionId).toBe(12);
    expect(toGymSession(withSessionId(s, 12)).id).toBe(12);
  });

  it('sopravvive al salvataggio in IndexedDB e si riprende identica', async () => {
    const db = new AppDB(`test-gym-${Math.random().toString(36).slice(2)}`);
    try {
      let s = startSession(template(), history(), T0, opts);
      s = completeSet(s, setOf(s, 0, 0).key, T0 + sec(30));
      s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(100), { kg: 62.5, reps: 6, rpe: 8, note: 'ok' });
      s = addSet(s, s.exercises[1].key);
      s = skipExercise(s, s.exercises[2].key);
      const id = (await db.sessions.add(toGymSession(s))) as number;
      s = withSessionId(s, id);

      const riga = (await db.sessions.get(id))!;
      expect(riga.endedAt).toBeUndefined();
      const ripresa = resumeSession(riga)!;
      expect(ripresa).toEqual(s);
      expect(ripresa.sessionId).toBe(id);
      expect(nextSet(ripresa)!.set.key).toBe(nextSet(s)!.set.key);

      // si continua e si chiude: la seduta si aggiorna con lo stesso id
      const r = completeSet(ripresa, setOf(ripresa, 0, 2).key, T0 + sec(300));
      const { session, summary } = finishSession(r, T0 + sec(1800), { history: history() });
      await db.sessions.put(session);
      const chiusa = (await db.sessions.get(id))!;
      expect(chiusa.endedAt).toBeDefined();
      expect(chiusa.sets).toHaveLength(3);
      expect((chiusa as PersistedGymSession).foro!.live).toBeUndefined();
      expect(summary.serieFatte).toBe(2);
      expect(resumeSession(chiusa)).toBeUndefined();
      // l'elenco delle sedute aperte si trova con endedAt vuoto
      expect((await db.sessions.toArray()).filter((x) => !x.endedAt)).toHaveLength(0);
      expect(ripresa.rest).toBeDefined();
    } finally {
      await db.delete();
    }
  });

  it('senza lo stato salvato ricostruisce la seduta dalla scheda e dalle serie registrate', () => {
    const g: GymSession = {
      id: 5,
      date: '2026-11-23',
      templateId: 'tpl-A',
      programId: 'prg-1',
      startedAt: '2026-11-23T18:00:00+01:00',
      sets: [
        ...rows('squat-bilanciere', [[31.25, 8]], 'riscaldamento'),
        ...rows('squat-bilanciere', [[62.5, 6, 8]], 'normale', 1),
        ...rows('face-pull', [[20, 12, 8]]),
      ],
    };
    const s = resumeSession(g, { template: template(), history: history(), ...opts })!;
    expect(s.sessionId).toBe(5);
    expect(s.startedAt).toBe(T0);
    expect(setOf(s, 0, 0)).toMatchObject({ done: true, kg: 31.25 });
    expect(setOf(s, 0, 1)).toMatchObject({ done: true, kg: 62.5, reps: 6, rpe: 8 });
    expect(setOf(s, 0, 2).done).toBe(false);
    // un esercizio fatto ma non in scheda diventa un esercizio aggiunto
    const extra = s.exercises.find((e) => e.exerciseId === 'face-pull')!;
    expect(extra.origin).toBe('aggiunto');
    expect(extra.sets[0]).toMatchObject({ done: true, kg: 20, reps: 12 });
  });

  it('senza stato né scheda ricostruisce almeno gli esercizi fatti', () => {
    const g: GymSession = {
      date: '2026-11-23',
      startedAt: '2026-11-23T18:00:00+01:00',
      sets: [...rows('curl-manubri', [[10, 12], [10, 11]])],
    };
    const s = resumeSession(g, opts)!;
    expect(s.exercises).toHaveLength(1);
    expect(s.exercises[0].sets.every((x) => x.done)).toBe(true);
  });
});

describe('casi limite', () => {
  it('le serie aggiunte non compensano quelle previste e saltate nel completamento', () => {
    let s = startSession(template(), history(), T0, opts);
    let t = T0;
    const fai = (e: number, i: number) => {
      t += sec(120);
      s = completeSet(s, setOf(s, e, i).key, t);
    };
    for (const i of [1, 2, 3]) fai(0, i); // squat: 3 serie allenanti
    for (const i of [0, 1, 2]) fai(1, i); // panca: 3 serie
    s = skipExercise(s, s.exercises[2].key); // curl saltato: 2 serie previste non fatte
    s = addSet(addSet(s, s.exercises[1].key), s.exercises[1].key);
    fai(1, 3);
    fai(1, 4);
    const { summary } = finishSession(s, t + sec(60), { history: history() });
    expect(summary).toMatchObject({ serieFatte: 8, seriePianificate: 8, completamento: 75, eserciziSaltati: 1 });
  });

  it('in una seduta di scarico non si segnalano record, nemmeno se una serie supera lo storico', () => {
    const chiudi = (mode: 'normale' | 'scarico') => {
      let s = startSession(template(), history(), T0, { ...opts, mode });
      s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(60), { kg: 70, reps: 5 }); // oltre lo storico (60 kg)
      return finishSession(s, T0 + sec(600), { history: history() }).summary;
    };
    expect(chiudi('normale').record.some((r) => r.tipo === 'carico')).toBe(true);
    expect(chiudi('scarico').record).toEqual([]);
  });

  it('aggiungere secondi a un recupero finito da un pezzo riparte da adesso', () => {
    let s = startSession(template(), history(), T0, opts);
    s = completeSet(s, setOf(s, 0, 1).key, T0); // il recupero finisce a +150 s
    const later = T0 + sec(400); // l'app torna 250 secondi dopo la fine
    s = adjustRest(s, 30, later);
    expect(restRemainingSec(s, later)).toBe(30);
    expect(s.rest).toMatchObject({ finished: false, warned: false });
  });

  it('senza storico passato a finishSession usa le soglie calcolate all\'avvio e ignora quelle che mancano', () => {
    let s = startSession(template(), history(), T0, opts);
    s = addExercise(s, 'leg-press'); // aggiunto senza storico: nessuna soglia, quindi nessun record
    s = completeSet(s, setOf(s, 3, 0).key, T0 + sec(30), { kg: 100, reps: 10 });
    s = completeSet(s, setOf(s, 0, 1).key, T0 + sec(90), { kg: 65, reps: 6 });
    const { summary } = finishSession(s, T0 + sec(900));
    expect(summary.record.map((r) => r.exerciseId)).not.toContain('leg-press');
    expect(summary.record.some((r) => r.exerciseId === 'squat-bilanciere' && r.tipo === 'carico')).toBe(true);
    // con lo storico dato alla chiusura, anche l'esercizio aggiunto ha le sue soglie
    const storia = [...history(), pastSession('2026-11-20', rows('leg-press', [[80, 10, 8]]))];
    const again = finishSession(s, T0 + sec(900), { history: storia }).summary;
    expect(again.record.some((r) => r.exerciseId === 'leg-press' && r.tipo === 'carico')).toBe(true);
  });
});
