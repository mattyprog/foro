import { describe, expect, it } from 'vitest';
import type { Exercise, GymSession, LoggedSet, WorkoutTemplate } from '../../db/types';
import {
  classifyVolume,
  countSets,
  muscleFrequency,
  plannedWeeklyVolume,
  setsByMuscle,
  weeklyVolumeFromSessions,
  weeklyVolumeSeries,
} from './volume';

const lib: Exercise[] = [
  { id: 'panca', name: 'Panca', primary: ['petto'], secondary: ['tricipiti', 'spalle'], equipment: 'bilanciere', pattern: 'spinta-orizzontale' },
  { id: 'curl', name: 'Curl', primary: ['bicipiti'], secondary: [], equipment: 'manubri', pattern: 'isolamento-bicipiti' },
  { id: 'squat', name: 'Squat', primary: ['quadricipiti'], secondary: ['glutei', 'adduttori'], equipment: 'bilanciere', pattern: 'squat' },
  { id: 'dip', name: 'Dip', primary: ['petto', 'tricipiti'], secondary: ['spalle'], equipment: 'corpo-libero', pattern: 'spinta-orizzontale' },
];

const logged = (exerciseId: string, n: number, extra: Partial<LoggedSet> = {}): LoggedSet[] =>
  Array.from({ length: n }, (_, i) => ({ exerciseId, setIndex: i, kg: 50, reps: 8, done: true, type: 'normale' as const, ...extra }));

const seduta = (date: string, sets: LoggedSet[]): GymSession => ({
  date,
  startedAt: `${date}T18:00:00+01:00`,
  endedAt: `${date}T19:00:00+01:00`,
  sets,
});

const tpl = (id: string, kind: 'forza' | 'corsa', exercises: { id: string; sets: number; warm?: number }[], dayOfWeek?: number): WorkoutTemplate => ({
  id,
  programId: 'p',
  name: id,
  kind,
  order: 1,
  dayOfWeek,
  exercises: exercises.map((e) => ({
    exerciseId: e.id,
    progression: 'doppia' as const,
    incrementKg: 2.5,
    sets: [
      ...Array.from({ length: e.warm ?? 0 }, () => ({ reps: [8, 8] as [number, number], restSec: 60, type: 'riscaldamento' as const })),
      ...Array.from({ length: e.sets }, () => ({ reps: [6, 10] as [number, number], restSec: 150, type: 'normale' as const })),
    ],
  })),
});

describe('serie per muscolo', () => {
  it('primario 1, secondario 0,5', () => {
    const r = setsByMuscle(logged('panca', 3), lib);
    expect(r.petto).toBe(3);
    expect(r.tricipiti).toBe(1.5);
    expect(r.spalle).toBe(1.5);
    expect(r.dorsali).toBe(0);
  });

  it('un esercizio con due muscoli primari li conta entrambi per intero', () => {
    const r = setsByMuscle(logged('dip', 2), lib);
    expect(r.petto).toBe(2);
    expect(r.tricipiti).toBe(2);
    expect(r.spalle).toBe(1);
  });

  it('esclude riscaldamento e serie non fatte', () => {
    const sets = [...logged('panca', 2), ...logged('panca', 2, { type: 'riscaldamento' }), ...logged('panca', 3, { done: false })];
    expect(setsByMuscle(sets, lib).petto).toBe(2);
  });

  it('può ignorare le serie troppo facili con minRpe, ma non quelle senza RPE', () => {
    const sets = [...logged('panca', 2, { rpe: 5 }), ...logged('panca', 3, { rpe: 8 }), ...logged('panca', 1)];
    expect(setsByMuscle(sets, lib, { minRpe: 6 }).petto).toBe(4);
    expect(setsByMuscle(sets, lib).petto).toBe(6);
  });

  it('elenca gli esercizi sconosciuti invece di inventare i muscoli', () => {
    const r = countSets([...logged('panca', 1), ...logged('sconosciuto', 2)], lib);
    expect(r.byMuscle.petto).toBe(1);
    expect(r.totalSets).toBe(1);
    expect(r.unknownExercises).toEqual(['sconosciuto']);
  });
});

describe('livello rispetto a 10-12 serie', () => {
  it('basso sotto 10, ok da 10 a 12, alto oltre 12', () => {
    expect(classifyVolume(0)).toBe('basso');
    expect(classifyVolume(9.5)).toBe('basso');
    expect(classifyVolume(10)).toBe('ok');
    expect(classifyVolume(11.5)).toBe('ok');
    expect(classifyVolume(12)).toBe('ok');
    expect(classifyVolume(12.5)).toBe('alto');
    expect(classifyVolume(20)).toBe('alto');
  });

  it('i limiti si possono cambiare', () => {
    expect(classifyVolume(6, { min: 4, max: 8 })).toBe('ok');
    expect(classifyVolume(9, { min: 4, max: 8 })).toBe('alto');
  });
});

describe('volume della settimana dalle sedute registrate', () => {
  const sedute = [
    seduta('2026-11-22', logged('panca', 5)), // domenica della settimana prima
    seduta('2026-11-23', [...logged('panca', 3), ...logged('curl', 2), ...logged('panca', 1, { type: 'riscaldamento' })]), // lunedì
    seduta('2026-11-27', logged('panca', 4)), // venerdì
    seduta('2026-11-29', logged('squat', 3)), // domenica
    seduta('2026-11-30', logged('squat', 9)), // lunedì dopo
  ];

  it('conta solo i giorni da lunedì a domenica della settimana indicata', () => {
    const r = weeklyVolumeFromSessions(sedute, '2026-11-25', { exercises: lib }); // un mercoledì qualunque
    expect(r.weekStart).toBe('2026-11-23');
    expect(r.byMuscle.petto).toBe(7);
    expect(r.byMuscle.bicipiti).toBe(2);
    expect(r.byMuscle.quadricipiti).toBe(3);
    expect(r.byMuscle.glutei).toBe(1.5);
    expect(r.byMuscle.tricipiti).toBe(3.5);
    expect(r.totalSets).toBe(3 + 2 + 4 + 3);
  });

  it('assegna a ogni muscolo il livello e segnala sotto le 4 serie', () => {
    const r = weeklyVolumeFromSessions(sedute, '2026-11-23', { exercises: lib });
    const per = Object.fromEntries(r.muscles.map((m) => [m.muscle, m]));
    expect(per.petto.level).toBe('basso');
    expect(per.petto.belowMinimum).toBe(false);
    expect(per.bicipiti.belowMinimum).toBe(true);
    expect(r.muscles).toHaveLength(14);
  });

  it('con 12 serie di panca il petto è ok e con 14 è alto', () => {
    const base = (n: number) => weeklyVolumeFromSessions([seduta('2026-11-24', logged('panca', n))], '2026-11-24', { exercises: lib });
    expect(base(12).muscles.find((m) => m.muscle === 'petto')!.level).toBe('ok');
    expect(base(14).muscles.find((m) => m.muscle === 'petto')!.level).toBe('alto');
  });

  it('una settimana senza sedute dà tutto a zero', () => {
    const r = weeklyVolumeFromSessions(sedute, '2026-11-09', { exercises: lib });
    expect(r.totalSets).toBe(0);
    expect(r.muscles.every((m) => m.sets === 0 && m.level === 'basso')).toBe(true);
  });

  it('riporta gli esercizi che non conosce', () => {
    const r = weeklyVolumeFromSessions([seduta('2026-11-24', logged('mistero', 3))], '2026-11-24', { exercises: lib });
    expect(r.unknownExercises).toEqual(['mistero']);
  });

  it('weeklyVolumeSeries dà una riga per settimana, dalla più vecchia', () => {
    const s = weeklyVolumeSeries(sedute, '2026-11-30', 2, { exercises: lib });
    expect(s.map((w) => w.weekStart)).toEqual(['2026-11-23', '2026-11-30']);
    expect(s[0].byMuscle.petto).toBe(7);
    expect(s[1].byMuscle.quadricipiti).toBe(9);
  });
});

describe('volume di una scheda pianificata', () => {
  it('con giorni fissi ogni seduta vale una volta a settimana', () => {
    const a = tpl('A', 'forza', [{ id: 'panca', sets: 3 }, { id: 'curl', sets: 2 }], 0);
    const b = tpl('B', 'forza', [{ id: 'panca', sets: 4 }, { id: 'squat', sets: 3 }], 3);
    const r = plannedWeeklyVolume([a, b], { exercises: lib });
    expect(r.byMuscle.petto).toBe(7);
    expect(r.byMuscle.bicipiti).toBe(2);
    expect(r.byMuscle.quadricipiti).toBe(3);
    expect(r.byMuscle.glutei).toBe(1.5);
    expect(r.totalSets).toBe(12);
  });

  it('con la rotazione A/B tre volte a settimana ogni seduta vale 1,5 volte', () => {
    const a = tpl('A', 'forza', [{ id: 'panca', sets: 4 }]);
    const b = tpl('B', 'forza', [{ id: 'squat', sets: 2 }]);
    const r = plannedWeeklyVolume([a, b], { exercises: lib, gymDaysPerWeek: 3 });
    expect(r.byMuscle.petto).toBe(6);
    expect(r.byMuscle.quadricipiti).toBe(3);
  });

  it('con una seduta a giorno fisso e due in rotazione divide i giorni rimasti', () => {
    const fisso = tpl('F', 'forza', [{ id: 'curl', sets: 2 }], 0);
    const a = tpl('A', 'forza', [{ id: 'panca', sets: 4 }]);
    const b = tpl('B', 'forza', [{ id: 'panca', sets: 2 }]);
    const r = plannedWeeklyVolume([fisso, a, b], { exercises: lib, gymDaysPerWeek: 3 });
    expect(r.byMuscle.bicipiti).toBe(2);
    expect(r.byMuscle.petto).toBe(6); // (4 + 2) x 1 rotazione ciascuna
  });

  it('esclude il riscaldamento e le sedute di corsa', () => {
    const a = tpl('A', 'forza', [{ id: 'panca', sets: 3, warm: 2 }], 0);
    const corsa = tpl('C', 'corsa', [], 1);
    expect(plannedWeeklyVolume([a, corsa], { exercises: lib }).byMuscle.petto).toBe(3);
  });

  it('le occorrenze si possono indicare a mano', () => {
    const a = tpl('A', 'forza', [{ id: 'panca', sets: 3 }]);
    const r = plannedWeeklyVolume([a], { exercises: lib, occurrences: { A: 2 } });
    expect(r.byMuscle.petto).toBe(6);
  });

  it('muscleFrequency conta le sedute a settimana in cui il muscolo è primario', () => {
    const a = tpl('A', 'forza', [{ id: 'panca', sets: 3 }, { id: 'curl', sets: 2 }], 0);
    const b = tpl('B', 'forza', [{ id: 'panca', sets: 3 }], 3);
    const f = muscleFrequency([a, b], { exercises: lib });
    expect(f.petto).toBe(2);
    expect(f.bicipiti).toBe(1);
    expect(f.dorsali).toBe(0);
    const rot = muscleFrequency([tpl('A', 'forza', [{ id: 'panca', sets: 3 }]), tpl('B', 'forza', [{ id: 'panca', sets: 3 }])], {
      exercises: lib,
      gymDaysPerWeek: 3,
    });
    expect(rot.petto).toBe(3);
  });
});
