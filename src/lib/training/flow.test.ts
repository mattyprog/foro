/**
 * Prova di integrazione: due settimane di full body A/B con tutti i moduli insieme
 * (scheda di partenza, piano del giorno, modalità palestra, progressione, record, volume, Dexie).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AppDB } from '../../db/db';
import type { GymSession, Program, WorkoutTemplate } from '../../db/types';
import { addDays } from './dates';
import { historyForExercise } from './records';
import {
  applySuggestion,
  completeSet,
  finishSession,
  nextSet,
  resumeSession,
  startSession,
  toGymSession,
  withSessionId,
  type SessionSummary,
} from './session';
import { createProgramFromStarter, isDeloadWeek, todaysPlan } from './templates';
import { plannedWeeklyVolume, weeklyVolumeFromSessions } from './volume';
import type { SessionMode } from './types';

function counter() {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
}

const START = '2026-11-23'; // lunedì
const at = (date: string, h: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, h - 1, 0, 0); // novembre a Roma: UTC+1
};

/** Chi si allena: applica il suggerimento, fa il massimo delle ripetizioni e segna RPE 7. */
function perform(template: WorkoutTemplate, history: GymSession[], date: string, mode: SessionMode = 'normale') {
  const start = at(date, 18);
  let s = startSession(template, history, start, { tzOffsetMin: 60, mode });
  let t = start;
  for (let n = nextSet(s), guard = 0; n && guard < 300; n = nextSet(s), guard++) {
    t += 120_000;
    const applied = applySuggestion(s, n.set.key);
    const set = applied.exercises[n.exerciseIndex].sets[n.setIndex];
    const warm = set.type === 'riscaldamento';
    s = completeSet(applied, n.set.key, t, {
      kg: set.kg ?? 20,
      reps: warm ? (set.reps as number) : set.repsMax,
      rpe: warm ? undefined : 7,
    });
  }
  return finishSession(s, t + 60_000, { history });
}

function setup(): { program: Program; templates: WorkoutTemplate[] } {
  return createProgramFromStarter('full-body-ab-3', { idGen: counter(), startDate: START, active: true, now: at(START, 9) });
}

interface Day {
  date: string;
  tipo: string;
  nome?: string;
}

function simulate(days: number) {
  const { program, templates } = setup();
  const sessions: GymSession[] = [];
  const summaries: { date: string; name: string; summary: SessionSummary }[] = [];
  const log: Day[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(START, i);
    const plan = todaysPlan(program, templates, sessions, [], date);
    const forza = plan.items.find((x) => x.kind === 'forza');
    log.push({ date, tipo: plan.tipo, nome: plan.items[0]?.template.name });
    if (!forza) continue;
    const done = perform(forza.template, sessions, date);
    sessions.push({ ...done.session, id: sessions.length + 1 });
    summaries.push({ date, name: forza.template.name, summary: done.summary });
  }
  return { program, templates, sessions, summaries, log };
}

describe('due settimane di full body A/B', () => {
  const sim = simulate(14);

  it('il piano del giorno segue la settimana tipo e le sedute A e B si alternano', () => {
    expect(sim.log.map((d) => [d.date.slice(5), d.tipo, d.nome])).toEqual([
      ['11-23', 'forza', 'A · Full body'],
      ['11-24', 'corsa', 'Corsa facile'],
      ['11-25', 'forza', 'B · Full body'],
      ['11-26', 'riposo', undefined],
      ['11-27', 'forza', 'A · Full body'],
      ['11-28', 'corsa', 'Corsa lunga facile'],
      ['11-29', 'riposo', undefined],
      ['11-30', 'forza', 'B · Full body'],
      ['12-01', 'corsa', 'Corsa facile'],
      ['12-02', 'forza', 'A · Full body'],
      ['12-03', 'riposo', undefined],
      ['12-04', 'forza', 'B · Full body'],
      ['12-05', 'corsa', 'Corsa lunga facile'],
      ['12-06', 'riposo', undefined],
    ]);
    expect(sim.sessions).toHaveLength(6);
  });

  it('tutte le sedute chiuse hanno serie fatte, durata e riepilogo coerenti', () => {
    for (const { summary } of sim.summaries) {
      expect(summary.completamento).toBe(100);
      expect(summary.serieFatte).toBe(summary.seriePianificate);
      expect(summary.durataSec).toBeGreaterThan(600);
      expect(summary.tonnellaggioKg).toBeGreaterThan(0);
      expect(summary.eserciziSaltati).toBe(0);
    }
    for (const s of sim.sessions) {
      expect(s.endedAt).toBeDefined();
      expect(s.templateId).toBeDefined();
      expect(s.sets.every((x) => x.done)).toBe(true);
    }
  });

  it('prima volta: nessun record. Dalla seconda i carichi salgono con la doppia progressione', () => {
    expect(sim.summaries[0].summary.record).toEqual([]); // A, prima volta
    expect(sim.summaries[1].summary.record).toEqual([]); // B, prima volta
    const goblet = (i: number) => sim.sessions[i].sets.filter((x) => x.exerciseId === 'goblet-squat' && x.type !== 'riscaldamento');
    // lunedì: 20 kg, 10 ripetizioni (il massimo). Venerdì: 22 kg (+2 dei manubri) e ripartenza da 6, ma il lavoro svolto è di nuovo al massimo.
    expect(goblet(0).map((x) => [x.kg, x.reps])).toEqual([[20, 10], [20, 10], [20, 10]]);
    expect(goblet(2).map((x) => [x.kg, x.reps])).toEqual([[22, 10], [22, 10], [22, 10]]);
    expect(goblet(4).map((x) => x.kg)).toEqual([24, 24, 24]); // mercoledì della seconda settimana: terza volta di A
    // venerdì: nuovo massimo di carico per il goblet squat
    const friday = sim.summaries[2].summary;
    expect(friday.record.some((r) => r.exerciseId === 'goblet-squat' && r.tipo === 'carico')).toBe(true);
    expect(friday.recordTesti.some((t) => /Goblet squat: nuovo massimo di carico, 22 kg \(prima 20 kg\)/.test(t))).toBe(true);
  });

  it('le serie del plank (a tempo, corpo libero) salgono di secondi e non di chili', () => {
    const plank = (i: number) => sim.sessions[i].sets.filter((x) => x.exerciseId === 'plank');
    expect(plank(0).map((x) => [x.kg, x.reps])).toEqual([[0, 60], [0, 60]]);
    // già al massimo (60 s) a corpo libero: la progressione propone una variante più difficile, ma il carico resta 0
    expect(plank(2).every((x) => x.kg === 0)).toBe(true);
  });

  it('il volume registrato in due settimane è il doppio di quello pianificato', () => {
    const planned = plannedWeeklyVolume(sim.templates);
    const w1 = weeklyVolumeFromSessions(sim.sessions, '2026-11-23');
    const w2 = weeklyVolumeFromSessions(sim.sessions, '2026-11-30');
    for (const m of Object.keys(planned.byMuscle) as (keyof typeof planned.byMuscle)[]) {
      expect(w1.byMuscle[m] + w2.byMuscle[m]).toBeCloseTo(2 * planned.byMuscle[m], 6);
    }
    // i muscoli grandi arrivano alle 10-12 serie con la scheda di partenza
    expect(planned.byMuscle.quadricipiti).toBeGreaterThanOrEqual(10);
    expect(planned.byMuscle.petto).toBeGreaterThanOrEqual(8);
  });

  it('lo storico di un esercizio si legge dalla più recente e senza riscaldamenti inutili', () => {
    const h = historyForExercise(sim.sessions, 'goblet-squat');
    expect(h).toHaveLength(3);
    expect(h[0].filter((x) => x.type !== 'riscaldamento')[0].kg).toBe(24);
    expect(h[2].filter((x) => x.type !== 'riscaldamento')[0].kg).toBe(20);
  });

  it('nessuna settimana di scarico nelle prime due', () => {
    expect(isDeloadWeek(sim.program, '2026-11-23')).toBe(false);
    expect(isDeloadWeek(sim.program, '2026-12-07')).toBe(false);
    expect(isDeloadWeek(sim.program, '2027-01-11')).toBe(true); // ottava settimana
  });
});

describe('scarico, ripresa e Dexie', () => {
  it('una seduta di scarico riduce serie e carichi e non falsa la progressione che segue', () => {
    const sim = simulate(14);
    const aTemplate = sim.templates.find((t) => t.name.startsWith('A'))!;
    const date = '2026-12-07'; // lunedì della terza settimana
    const lastGoblet = sim.sessions.at(-2)!; // ultima A normale (mercoledì 2 dicembre)
    expect(lastGoblet.sets.some((x) => x.exerciseId === 'goblet-squat' && x.kg === 24)).toBe(true);

    const deload = perform(aTemplate, sim.sessions, date, 'scarico');
    const deloadGoblet = deload.session.sets.filter((x) => x.exerciseId === 'goblet-squat' && x.type !== 'riscaldamento');
    expect(deloadGoblet).toHaveLength(2); // 3 serie -> 2
    expect(deloadGoblet[0].kg).toBeLessThan(24); // carico -10%, arrotondato ai manubri
    expect(deload.summary.record).toEqual([]); // niente record in una seduta di scarico
    expect(deload.summary.mode).toBe('scarico');
    expect((deload.session as { foro?: { modo: string } }).foro?.modo).toBe('scarico');

    // la seduta A seguente riparte dal lavoro normale (24 kg -> 26 kg), non dallo scarico
    const after = startSession(aTemplate, [...sim.sessions, { ...deload.session, id: 99 }], at('2026-12-09', 18), { tzOffsetMin: 60 });
    const goblet = after.exercises.find((e) => e.exerciseId === 'goblet-squat')!;
    expect(goblet.sets.find((s) => s.type !== 'riscaldamento')!.suggestion).toMatchObject({ kg: 26, repsTarget: 6 });
    expect(goblet.lastTime?.sets[0]).toMatchObject({ kg: 24, reps: 10 });
  });

  it('una seduta interrotta si riprende da Dexie con il timer di recupero', async () => {
    const db = new AppDB(`test-flow-${Math.random().toString(36).slice(2)}`);
    try {
      const { program, templates } = setup();
      await db.programs.add(program);
      await db.templates.bulkAdd(templates);
      const sessions: GymSession[] = [];
      for (const [i, date] of ['2026-11-23', '2026-11-25'].entries()) {
        const t = templates.find((x) => x.name.startsWith(i === 0 ? 'A' : 'B'))!;
        const done = perform(t, sessions, date);
        const id = (await db.sessions.add(done.session)) as number;
        sessions.push({ ...done.session, id });
      }
      expect(await db.sessions.count()).toBe(2);

      // venerdì: si apre la seduta A, si fanno due serie e l'app si chiude
      const stored = await db.sessions.toArray();
      const a = (await db.templates.toArray()).find((t) => t.name.startsWith('A'))!;
      const start = at('2026-11-27', 18);
      let s = startSession(a, stored, start, { tzOffsetMin: 60 });
      s = withSessionId(s, (await db.sessions.add(toGymSession(s))) as number);
      for (let k = 0; k < 2; k++) {
        const n = nextSet(s)!;
        s = completeSet(applySuggestion(s, n.set.key), n.set.key, start + (k + 1) * 150_000, { kg: n.set.kg ?? 10, reps: n.set.reps ?? 8 });
        await db.sessions.put(toGymSession(s));
      }
      const open = (await db.sessions.toArray()).filter((x) => !x.endedAt);
      expect(open).toHaveLength(1);

      // l'app si riapre: la seduta si riprende e il recupero continua dall'orologio di sistema
      const resumed = resumeSession(open[0])!;
      expect(resumed).toEqual(s);
      expect(resumed.rest).toBeDefined();
      expect(resumed.rest!.endsAt).toBe(start + 2 * 150_000 + (resumed.rest!.durationSec * 1000));
      expect(resumed.exercises[0].sets.filter((x) => x.done)).toHaveLength(2);
    } finally {
      await db.delete();
    }
  });
});
