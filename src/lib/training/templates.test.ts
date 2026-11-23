import { describe, expect, it } from 'vitest';
import type { Activity, GymSession, WorkoutTemplate } from '../../db/types';
import { getExercise, isCompound, isTimed } from './library';
import {
  STARTERS,
  createProgramFromStarter,
  isDeloadWeek,
  isHardRun,
  isLegDay,
  listStarters,
  todaysPlan,
} from './templates';
import { muscleFrequency, plannedWeeklyVolume } from './volume';

/** Generatore di id deterministico per i test. */
function counter() {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
}

describe('schede di partenza', () => {
  it('elenca le schede con nome, giorni e descrizione', () => {
    const list = listStarters();
    expect(list.map((s) => s.id)).toEqual(['full-body-ab-3', 'superiore-inferiore-4']);
    expect(list[0].name).toBe('Full body A/B 3 volte');
    expect(list[1].name).toBe('Superiore/Inferiore 4 volte');
    expect(list.map((s) => s.gymDaysPerWeek)).toEqual([3, 4]);
    expect(list.every((s) => s.description.length > 20)).toBe(true);
  });

  it('createProgramFromStarter restituisce un programma e le sue sedute collegate', () => {
    const { program, templates } = createProgramFromStarter('full-body-ab-3');
    expect(program.name).toBe('Full body A/B 3 volte');
    expect(program.active).toBe(false);
    expect(program.deloadEvery).toBeGreaterThanOrEqual(6);
    expect(program.deloadEvery).toBeLessThanOrEqual(8);
    expect(program.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(templates.every((t) => t.programId === program.id)).toBe(true);
    expect(templates.map((t) => t.name)).toEqual(['A · Full body', 'B · Full body', 'Corsa facile', 'Corsa lunga facile']);
    expect(templates.map((t) => t.kind)).toEqual(['forza', 'forza', 'corsa', 'corsa']);
    expect(templates.map((t) => t.order)).toEqual([1, 2, 3, 4]);
  });

  it('ogni chiamata crea oggetti nuovi con id diversi e indipendenti dai dati di partenza', () => {
    const a = createProgramFromStarter('superiore-inferiore-4');
    const b = createProgramFromStarter('superiore-inferiore-4');
    const ids = [a.program.id, ...a.templates.map((t) => t.id), b.program.id, ...b.templates.map((t) => t.id)];
    expect(new Set(ids).size).toBe(ids.length);
    a.templates[0].exercises[0].sets[0].reps = [1, 1];
    a.templates[0].exercises.pop();
    const c = createProgramFromStarter('superiore-inferiore-4');
    expect(c.templates[0].exercises[0].sets[0].reps).not.toEqual([1, 1]);
    expect(c.templates[0].exercises.length).toBeGreaterThan(5);
    expect(b.templates[0].exercises[0].sets[0].reps).not.toEqual([1, 1]);
  });

  it('accetta un generatore di id, la data di inizio e l\'attivazione', () => {
    const { program, templates } = createProgramFromStarter('full-body-ab-3', {
      idGen: counter(),
      startDate: '2026-11-23',
      active: true,
    });
    expect(program.id).toBe('programma-1');
    expect(templates.map((t) => t.id)).toEqual(['seduta-2', 'seduta-3', 'seduta-4', 'seduta-5']);
    expect(program.startDate).toBe('2026-11-23');
    expect(program.active).toBe(true);
  });

  it('una scheda sconosciuta è un errore', () => {
    expect(() => createProgramFromStarter('non-esiste')).toThrow(/non-esiste/);
  });

  for (const starter of STARTERS) {
    describe(starter.name, () => {
      const { templates } = createProgramFromStarter(starter.id);
      const strength = templates.filter((t) => t.kind === 'forza');
      const runs = templates.filter((t) => t.kind === 'corsa');

      it('usa solo esercizi della libreria', () => {
        for (const t of strength) for (const pe of t.exercises) expect(getExercise(pe.exerciseId), pe.exerciseId).toBeDefined();
      });

      it('intervalli, recuperi e RPE seguono il metodo', () => {
        for (const t of strength) {
          for (const pe of t.exercises) {
            const ex = getExercise(pe.exerciseId)!;
            expect(pe.progression).toBe('doppia');
            expect(pe.incrementKg).toBe(ex.defaultIncrementKg);
            const work = pe.sets.filter((s) => s.type !== 'riscaldamento');
            expect(work.length, `${t.name}: ${ex.id}`).toBeGreaterThanOrEqual(2);
            expect(work.length, `${t.name}: ${ex.id}`).toBeLessThanOrEqual(3);
            for (const s of work) {
              if (isTimed(ex)) {
                expect(s.reps).toEqual([30, 60]);
              } else if (isCompound(ex)) {
                expect(s.reps, ex.id).toEqual([6, 10]);
                expect(s.restSec, ex.id).toBeGreaterThanOrEqual(120);
                expect(s.restSec, ex.id).toBeLessThanOrEqual(180);
                expect(s.rpe, ex.id).toBeGreaterThanOrEqual(7);
                expect(s.rpe, ex.id).toBeLessThanOrEqual(8);
              } else {
                expect(s.reps, ex.id).toEqual([10, 15]);
                expect(s.restSec, ex.id).toBeGreaterThanOrEqual(60);
                expect(s.restSec, ex.id).toBeLessThanOrEqual(90);
                expect(s.rpe, ex.id).toBeGreaterThanOrEqual(7);
                expect(s.rpe, ex.id).toBeLessThanOrEqual(8);
              }
            }
          }
        }
      });

      it('le sedute non sono eccessive: al massimo 8 esercizi e 22 serie allenanti', () => {
        for (const t of strength) {
          const work = t.exercises.flatMap((pe) => pe.sets.filter((s) => s.type !== 'riscaldamento'));
          expect(t.exercises.length, t.name).toBeLessThanOrEqual(8);
          expect(work.length, t.name).toBeLessThanOrEqual(22);
          expect(work.length, t.name).toBeGreaterThanOrEqual(14);
        }
      });

      it('porta i muscoli principali a 10-12 serie a settimana e ogni muscolo grande almeno 2 volte', () => {
        const gymDays = starter.gymDaysPerWeek;
        const report = plannedWeeklyVolume(templates, { gymDaysPerWeek: gymDays });
        for (const m of ['petto', 'dorsali', 'spalle', 'quadricipiti', 'femorali', 'glutei'] as const) {
          const row = report.muscles.find((x) => x.muscle === m)!;
          expect(row.sets, `${starter.id}: ${m}`).toBeGreaterThanOrEqual(10);
          expect(row.sets, `${starter.id}: ${m}`).toBeLessThanOrEqual(12);
          expect(row.level).toBe('ok');
        }
        for (const m of ['bicipiti', 'tricipiti', 'polpacci', 'addome'] as const) {
          // braccia, polpacci e addome sono anche allenati in modo indiretto: almeno il minimo efficace
          expect(report.byMuscle[m], `${starter.id}: ${m}`).toBeGreaterThanOrEqual(4);
        }
        expect(report.unknownExercises).toEqual([]);
        const freq = muscleFrequency(templates, { gymDaysPerWeek: gymDays });
        for (const m of ['petto', 'dorsali', 'spalle', 'quadricipiti', 'femorali'] as const) {
          expect(freq[m], `${starter.id}: frequenza ${m}`).toBeGreaterThanOrEqual(2);
        }
      });

      it('le corse sono facili in zona 2, 20-30 minuti', () => {
        expect(runs).toHaveLength(2);
        for (const t of runs) {
          expect(t.run?.zone).toBe(2);
          expect(['facile', 'lungo']).toContain(t.run?.type);
          expect(t.run!.targetMinutes).toBeGreaterThanOrEqual(20);
          expect(t.run!.targetMinutes).toBeLessThanOrEqual(30);
          expect(isHardRun(t.run!)).toBe(false);
          expect(t.exercises).toEqual([]);
        }
      });
    });
  }

  it('full body: pesi a rotazione, corse il martedì e il sabato', () => {
    const { templates } = createProgramFromStarter('full-body-ab-3');
    expect(templates.filter((t) => t.kind === 'forza').every((t) => t.dayOfWeek === undefined)).toBe(true);
    expect(templates.filter((t) => t.kind === 'corsa').map((t) => t.dayOfWeek)).toEqual([1, 5]);
  });

  it('superiore/inferiore: lunedì, martedì, giovedì, venerdì più due corse facili senza gambe il giorno dopo', () => {
    const { templates } = createProgramFromStarter('superiore-inferiore-4');
    expect(templates.map((t) => [t.name, t.dayOfWeek])).toEqual([
      ['A · Superiore', 0],
      ['A · Inferiore', 1],
      ['B · Superiore', 3],
      ['B · Inferiore', 4],
      ['Corsa facile', 2],
      ['Corsa lunga facile', 5],
    ]);
    const days = new Set(templates.filter((t) => t.kind === 'forza').map((t) => t.dayOfWeek!));
    for (const t of templates.filter((x) => x.kind === 'corsa')) {
      const next = (t.dayOfWeek! + 1) % 7;
      const nextIsLegs = templates.some((x) => x.kind === 'forza' && x.dayOfWeek === next && isLegDay(x));
      expect(nextIsLegs && isHardRun(t.run!)).toBe(false);
      expect(days.has(t.dayOfWeek!)).toBe(false);
    }
  });

  it('riconosce i giorni di gambe e le corse dure', () => {
    const fb = createProgramFromStarter('full-body-ab-3').templates;
    expect(fb.filter((t) => t.kind === 'forza').every((t) => isLegDay(t))).toBe(true);
    const ul = createProgramFromStarter('superiore-inferiore-4').templates;
    expect(ul.filter((t) => t.name.includes('Inferiore')).every((t) => isLegDay(t))).toBe(true);
    expect(ul.filter((t) => t.name.includes('Superiore')).some((t) => isLegDay(t))).toBe(false);
    expect(isHardRun({ type: 'tempo' })).toBe(true);
    expect(isHardRun({ type: 'ripetute' })).toBe(true);
    expect(isHardRun({ type: 'facile', zone: 4 })).toBe(true);
    expect(isHardRun({ type: 'facile', zone: 2 })).toBe(false);
    expect(isHardRun({ type: 'lungo' })).toBe(false);
    expect(isHardRun({ type: 'facile', zone: 2, intervals: [{ reps: 4, workSec: 20, restSec: 60 }] })).toBe(false);
  });
});

/* ------------------------------------------------------------------ todaysPlan */

const seduta = (date: string, t: WorkoutTemplate, extra: Partial<GymSession> = {}): GymSession => ({
  date,
  templateId: t.id,
  programId: t.programId,
  startedAt: `${date}T18:00:00+01:00`,
  endedAt: `${date}T19:00:00+01:00`,
  sets: [{ exerciseId: t.exercises[0]?.exerciseId ?? 'x', setIndex: 0, kg: 20, reps: 10, done: true }],
  ...extra,
});

const corsa = (date: string, extra: Partial<Activity> = {}): Activity => ({
  id: `garmin:${date}`,
  source: 'garmin',
  kind: 'corsa',
  typeKey: 'running',
  name: 'Corsa',
  start: `${date}T07:30:00+01:00`,
  durationSec: 1500,
  ...extra,
});

describe('todaysPlan: settimana tipo del full body', () => {
  const { program, templates } = createProgramFromStarter('full-body-ab-3', { idGen: counter() });
  const [A, B, facile, lunga] = templates;
  const oggi = (d: string, sessions: GymSession[] = [], activities: Activity[] = [], opts = {}) =>
    todaysPlan(program, templates, sessions, activities, d, opts);

  it('lunedì A, martedì corsa facile, mercoledì B, giovedì riposo, venerdì A, sabato corsa lunga, domenica riposo', () => {
    const sessions: GymSession[] = [];
    const nome = (d: string) => {
      const p = oggi(d, sessions);
      return p.riposo ? 'riposo' : p.items.map((i) => i.template.name).join(' + ');
    };

    expect(nome('2026-11-23')).toBe('A · Full body'); // lunedì
    sessions.push(seduta('2026-11-23', A));
    expect(nome('2026-11-24')).toBe('Corsa facile'); // martedì
    expect(nome('2026-11-25')).toBe('B · Full body'); // mercoledì
    sessions.push(seduta('2026-11-25', B));
    expect(nome('2026-11-26')).toBe('riposo'); // giovedì
    expect(nome('2026-11-27')).toBe('A · Full body'); // venerdì
    sessions.push(seduta('2026-11-27', A));
    expect(nome('2026-11-28')).toBe('Corsa lunga facile'); // sabato
    expect(nome('2026-11-29')).toBe('riposo'); // domenica: già tre sedute questa settimana
    expect(nome('2026-11-30')).toBe('B · Full body'); // lunedì dopo: la rotazione continua
  });

  it('spiega il riposo in una riga', () => {
    const sessions = [seduta('2026-11-25', B)];
    const giovedi = oggi('2026-11-26', sessions);
    expect(giovedi.riposo).toBe(true);
    expect(giovedi.tipo).toBe('riposo');
    expect(giovedi.items).toEqual([]);
    expect(giovedi.motivo).toMatch(/Ieri/);
    expect(giovedi.motivo).not.toMatch(/\n/);
    const domenica = oggi('2026-11-29', [seduta('2026-11-23', A), seduta('2026-11-25', B), seduta('2026-11-27', A)]);
    expect(domenica.riposo).toBe(true);
    expect(domenica.motivo).toMatch(/3 sedute/);
  });

  it('la prima seduta in assoluto è la A, e dopo la B tocca la A', () => {
    expect(oggi('2026-11-23').items[0].template.id).toBe(A.id);
    expect(oggi('2026-11-27', [seduta('2026-11-25', B)]).items[0].template.id).toBe(A.id);
    expect(oggi('2026-11-27', [seduta('2026-11-25', A)]).items[0].template.id).toBe(B.id);
  });

  it('il martedì con la corsa fissa non aggiunge i pesi anche se saltati il lunedì', () => {
    const p = oggi('2026-11-24');
    expect(p.tipo).toBe('corsa');
    expect(p.items.map((i) => i.template.id)).toEqual([facile.id]);
  });

  it('segna le sedute già fatte o in corso oggi', () => {
    const fatta = oggi('2026-11-23', [seduta('2026-11-23', A)]);
    expect(fatta.items).toHaveLength(1);
    expect(fatta.items[0]).toMatchObject({ status: 'fatta' });
    expect(fatta.completata).toBe(true);
    const inCorso = oggi('2026-11-23', [seduta('2026-11-23', A, { endedAt: undefined })]);
    expect(inCorso.items[0].status).toBe('in-corso');
    expect(inCorso.completata).toBe(false);
    const daFare = oggi('2026-11-23');
    expect(daFare.items[0].status).toBe('da-fare');
  });

  it('una seduta chiusa senza serie fatte non conta come allenamento', () => {
    const vuota = oggi('2026-11-23', [seduta('2026-11-23', A, { sets: [] })]);
    expect(vuota.items[0].status).not.toBe('fatta');
    expect(vuota.completata).toBe(false);
  });

  it('riconosce la corsa fatta dall\'orologio e la conta', () => {
    const p = oggi('2026-11-24', [], [corsa('2026-11-24')]);
    expect(p.items[0]).toMatchObject({ template: { id: facile.id }, status: 'fatta' });
    const sabato = oggi('2026-11-28', [], [corsa('2026-11-28')]);
    expect(sabato.items[0]).toMatchObject({ template: { id: lunga.id }, status: 'fatta' });
  });

  it('una forza registrata solo dall\'orologio vale come giorno di pesi per il recupero', () => {
    const forza: Activity = { ...corsa('2026-11-25'), kind: 'forza', typeKey: 'strength_training', id: 'garmin:forza' };
    const p = oggi('2026-11-26', [], [forza]);
    expect(p.riposo).toBe(true);
  });

  it('due giorni dopo l\'ultima seduta, anche in un giorno qualunque, tocca di nuovo ai pesi', () => {
    const p = oggi('2026-11-18', [seduta('2026-11-16', A)]); // mercoledì
    expect(p.items[0].template.id).toBe(B.id);
    // dopo un mese di pausa si riparte dalla successiva
    expect(oggi('2026-12-28', [seduta('2026-11-25', A)]).items[0].template.id).toBe(B.id);
  });

  it('la scheda non parte prima della data di inizio', () => {
    const { program: p2, templates: t2 } = createProgramFromStarter('full-body-ab-3', { startDate: '2026-12-01' });
    const r = todaysPlan(p2, t2, [], [], '2026-11-30');
    expect(r.riposo).toBe(true);
    expect(r.motivo).toMatch(/1 dicembre/);
  });

  it('con una corsa dura il giorno prima di una seduta con le gambe lo segnala', () => {
    const dura = templates.map((t) => (t.id === facile.id ? { ...t, run: { ...t.run!, type: 'tempo' as const, zone: 3 as const } } : t));
    const p = todaysPlan(program, dura, [seduta('2026-11-23', A)], [], '2026-11-24');
    expect(p.avvisi.some((a) => /gambe/.test(a))).toBe(true);
    const normale = oggi('2026-11-24', [seduta('2026-11-23', A)]);
    expect(normale.avvisi).toEqual([]);
  });

  it('pesi e corsa lo stesso giorno: pesi prima e almeno 6 ore di distanza', () => {
    const conPesiFissi = templates.map((t) => (t.id === A.id ? { ...t, dayOfWeek: 1 } : t));
    const p = todaysPlan(program, conPesiFissi, [], [], '2026-11-24');
    expect(p.tipo).toBe('doppio');
    expect(p.items.map((i) => i.kind)).toEqual(['forza', 'corsa']);
    expect(p.avvisi.some((a) => /6 ore/.test(a))).toBe(true);
  });

  it('indica la settimana di scarico prevista dalla scheda', () => {
    const { program: p, templates: t } = createProgramFromStarter('full-body-ab-3', { startDate: '2026-11-02' });
    expect(p.deloadEvery).toBeDefined();
    const every = p.deloadEvery!;
    const lunedi = (week: number) => {
      const d = new Date(Date.UTC(2026, 10, 2 + 7 * (week - 1)));
      return d.toISOString().slice(0, 10);
    };
    expect(isDeloadWeek(p, lunedi(1))).toBe(false);
    expect(isDeloadWeek(p, lunedi(every - 1))).toBe(false);
    expect(isDeloadWeek(p, lunedi(every))).toBe(true);
    expect(isDeloadWeek(p, lunedi(every + 1))).toBe(false);
    expect(isDeloadWeek(p, lunedi(2 * every))).toBe(true);
    expect(todaysPlan(p, t, [], [], lunedi(every)).deload).toBe(true);
    expect(isDeloadWeek({ ...p, startDate: undefined }, '2026-12-28')).toBe(false);
  });
});

describe('todaysPlan: superiore/inferiore a giorni fissi', () => {
  const { program, templates } = createProgramFromStarter('superiore-inferiore-4', { idGen: counter() });

  it('segue i giorni della settimana impostati nella scheda', () => {
    const nomi = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'].map((d) => {
      const p = todaysPlan(program, templates, [], [], d);
      return p.riposo ? 'riposo' : p.items.map((i) => i.template.name).join(' + ');
    });
    expect(nomi).toEqual(['A · Superiore', 'A · Inferiore', 'Corsa facile', 'B · Superiore', 'B · Inferiore', 'Corsa lunga facile', 'riposo']);
  });

  it('un giorno senza seduta è riposo previsto dalla scheda, anche se ieri non si è fatto nulla', () => {
    const p = todaysPlan(program, templates, [], [], '2026-11-29');
    expect(p.riposo).toBe(true);
    expect(p.motivo).toMatch(/riposo/i);
  });

  it('le sedute saltate non si recuperano da sole: vale il calendario', () => {
    const p = todaysPlan(program, templates, [], [], '2026-11-26');
    expect(p.items.map((i) => i.template.name)).toEqual(['B · Superiore']);
  });
});
