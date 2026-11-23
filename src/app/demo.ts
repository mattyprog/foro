import { db, setSetting } from '@/db/db';
import type { Activity, FoodLogEntry, GymSession, LoggedItem, LoggedSet, Program, WellnessDay, WeightEntry, WorkoutTemplate } from '@/db/types';
import { addDays, todayISO } from '@/lib/dates';
import { createProgramFromStarter } from '@/lib/training/templates';
import { getExercise, isTimed } from '@/lib/training/library';

/**
 * Dati di prova SINTETICI, per esplorare l'app prima di avere dati veri.
 * Tutto ciò che viene creato qui è marcato: id con prefisso 'demo:' o note 'dati di prova',
 * e si cancella con clearDemo(). Nessun valore viene da dati veri.
 */

const DEMO = 'dati di prova';

/** Generatore pseudo-casuale deterministico (stessi dati a ogni caricamento). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function item(name: string, grams: number, kcal: number, p: number, c: number, f: number): LoggedItem {
  return { name, grams, nutrients: { kcal, protein: p, carbs: c, fat: f }, source: 'ricetta', confidence: 'alta' };
}

/** Anello sintetico intorno allo Stadio dei Marmi (luogo pubblico), 5 km circa. */
function demoTrack(r: () => number): [number, number][] {
  const c: [number, number] = [41.9335, 12.4565];
  const pts: [number, number][] = [];
  for (let i = 0; i <= 240; i++) {
    const a = (i / 240) * Math.PI * 2;
    const rad = 0.0072 * (1 + 0.12 * Math.sin(a * 3) + 0.03 * (r() - 0.5));
    pts.push([c[0] + rad * Math.sin(a) * 0.8, c[1] + rad * Math.cos(a) * 1.25]);
  }
  return pts;
}

/** Carichi di partenza inventati per attrezzo (kg); il corpo libero parte da zero kg aggiunti. */
const BASE_KG: Record<string, number> = { bilanciere: 40, manubri: 14, macchina: 40, cavi: 20, multipower: 30, kettlebell: 12, elastici: 0, 'corpo-libero': 0, altro: 10 };

/** Scheda full body A/B con tre settimane di sedute inventate (lun, mer, ven alle 18:30). */
function demoTraining(today: string, r: () => number): { program: Program; templates: WorkoutTemplate[]; sessions: GymSession[] } {
  let n = 0;
  const { program, templates } = createProgramFromStarter('full-body-ab-3', {
    startDate: addDays(today, -21),
    idGen: (kind) => `demo:${kind}-${++n}`,
  });
  program.name = `${program.name} (prova)`;
  const forza = templates.filter((t) => t.kind === 'forza');
  const sessions: GymSession[] = [];
  let k = 0;
  for (let i = 21; i >= 1; i--) {
    const d = addDays(today, -i);
    const wd = (new Date(d + 'T12:00:00').getDay() + 6) % 7;
    if (wd !== 0 && wd !== 2 && wd !== 4) continue;
    const tpl = forza[k++ % forza.length];
    const week = Math.floor((21 - i) / 7);
    const start = new Date(`${d}T18:30:00`);
    let t = start.getTime() + 6 * 60e3;
    const sets: LoggedSet[] = [];
    for (const pe of tpl.exercises) {
      const ex = getExercise(pe.exerciseId);
      const timed = ex ? isTimed(ex) : false;
      const base = timed ? 0 : (BASE_KG[ex?.equipment ?? 'altro'] ?? 10);
      const kg = base === 0 ? 0 : base + week * pe.incrementKg;
      pe.sets.forEach((ps, setIndex) => {
        if (ps.type === 'riscaldamento') return;
        const reps = timed ? 35 + Math.round(r() * 15) : Math.max(ps.reps[0], ps.reps[1] - Math.floor(r() * 3));
        t += (ps.restSec + 35 + Math.round(r() * 20)) * 1000;
        sets.push({ exerciseId: pe.exerciseId, setIndex, kg, reps, rpe: 7.5 + Math.round(r() * 2) / 2, type: 'normale', done: true, ts: new Date(t).toISOString() });
      });
    }
    sessions.push({ date: d, templateId: tpl.id, programId: program.id, startedAt: start.toISOString(), endedAt: new Date(t + 90e3).toISOString(), sets, note: DEMO });
  }
  return { program, templates, sessions };
}

export async function loadDemo(now = new Date()): Promise<void> {
  const r = rng(42);
  const today = todayISO(now);
  const wellness: WellnessDay[] = [];
  const weights: WeightEntry[] = [];
  const acts: Activity[] = [];
  const food: FoodLogEntry[] = [];

  let kg = 71.2;
  for (let i = 34; i >= 0; i--) {
    const d = addDays(today, -i);
    const night = new Date(d + 'T00:00:00');
    const startH = 23 + r() * 1.4 - 0.4;
    const durH = 6.4 + r() * 1.6 - (i === 1 ? 1.2 : 0);
    const start = new Date(night.getTime() + (startH - 24) * 3600e3);
    const end = new Date(start.getTime() + durH * 3600e3);
    const sleepSec = Math.round(durH * 3600 * 0.94);
    const base = 62;
    const hrv = Math.round(base + (r() - 0.5) * 16 - (i === 1 || i === 2 ? 14 : 0));
    wellness.push({
      date: d,
      source: 'garmin',
      sleepSec,
      sleepScore: Math.round(62 + r() * 30 - (i === 1 ? 15 : 0)),
      deepSec: Math.round(sleepSec * (0.15 + r() * 0.06)),
      remSec: Math.round(sleepSec * (0.2 + r() * 0.05)),
      lightSec: Math.round(sleepSec * 0.52),
      awakeSec: Math.round(sleepSec * 0.05),
      sleepStart: start.toISOString(),
      sleepEnd: end.toISOString(),
      hrvNightAvg: hrv,
      hrvBaselineLow: 54,
      hrvBaselineHigh: 72,
      hrvStatus: hrv < 54 ? 'UNBALANCED' : 'BALANCED',
      restingHr: Math.round(54 + r() * 4 + (i === 1 ? 4 : 0)),
      stressAvg: Math.round(24 + r() * 18),
      bodyBatteryHigh: Math.round(70 + r() * 28),
      bodyBatteryLow: Math.round(10 + r() * 20),
      steps: Math.round(5200 + r() * 7000),
      activeKcal: Math.round(380 + r() * 500),
      vo2max: 46,
    });
    kg += 0.012 + (r() - 0.5) * 0.35;
    if (r() > 0.35) weights.push({ date: d, kg: Math.round(kg * 10) / 10, source: 'manuale' });

    // corse: martedì e sabato
    const wd = (new Date(d + 'T12:00:00').getDay() + 6) % 7;
    if (wd === 1 || wd === 5) {
      const km = wd === 5 ? 6 + r() * 1.5 : 4 + r();
      const pace = 360 + r() * 25;
      const dur = Math.round(km * pace);
      const laps = Array.from({ length: Math.floor(km) }, () => {
        const p = Math.round(pace + (r() - 0.5) * 30);
        return { distanceM: 1000, durationSec: p, avgPaceSecPerKm: p, avgHr: Math.round(142 + r() * 10) };
      });
      acts.push({
        id: `demo:run-${d}`,
        source: 'manuale',
        kind: 'corsa',
        typeKey: 'running',
        name: wd === 5 ? 'Corsa lunga facile (prova)' : 'Corsa facile (prova)',
        start: `${d}T07:${String(10 + Math.floor(r() * 30)).padStart(2, '0')}:00+01:00`,
        durationSec: dur,
        distanceM: Math.round(km * 1000),
        avgPaceSecPerKm: pace,
        avgHr: 145,
        maxHr: 163,
        calories: Math.round(km * kg),
        elevGainM: 24,
        aerobicTE: 2.8,
        hrZonesSec: [180, Math.round(dur * 0.62), Math.round(dur * 0.28), 120, 0],
        laps,
        track: demoTrack(r),
      });
    }

    if (i <= 6) {
      const entries: [FoodLogEntry['slot'], string, LoggedItem[]][] = [
        ['colazione', '07:40', [item('Yogurt greco 0%', 170, 97, 17, 6.5, 0.7), item('Fiocchi d\u2019avena', 40, 150, 5.3, 23.6, 2.8), item('Banana', 120, 107, 1.3, 23, 0.4)]],
        ['pranzo', '13:15', [item('Pasta e ceci', 350, 520, 22, 78, 11)]],
        ['merenda', '17:00', [item('Ricotta romana', 100, 146, 10, 3.5, 10.6), item('Mela', 150, 78, 0.4, 18.6, 0.2)]],
        ['cena', '20:30', [item('Petto di pollo ai ferri', 180, 216, 42, 0, 4.6), item('Cicoria ripassata', 200, 120, 4, 6, 9), item('Pane casereccio', 60, 160, 5, 32, 0.8)]],
      ];
      for (const [slot, time, items] of entries) {
        if (i === 0 && (slot === 'cena' || slot === 'merenda')) continue;
        food.push({ date: d, time, slot, items, method: 'manuale', note: DEMO, createdAt: `${d}T${time}:00` });
      }
    }
  }

  const training = demoTraining(today, r);

  await db.transaction('rw', [db.wellness, db.weights, db.activities, db.foodLog, db.settings, db.programs, db.templates, db.sessions], async () => {
    // la scheda di prova diventa attiva solo se non ce n'è già una tua
    training.program.active = !(await db.programs.filter((p) => p.active).first());
    await db.programs.put(training.program);
    await db.templates.bulkPut(training.templates);
    await db.sessions.bulkAdd(training.sessions);
    // salvo solo i giorni scritti davvero, con i valori scritti: alla cancellazione tolgo solo quelli
    // (i giorni che erano già tuoi, o che hai cambiato dopo, restano)
    const wroteWellness: Record<string, WellnessDay> = {};
    const wroteWeights: Record<string, number> = {};
    for (const w of wellness)
      if (!(await db.wellness.get(w.date))) {
        await db.wellness.put(w);
        wroteWellness[w.date] = w;
      }
    for (const w of weights)
      if (!(await db.weights.get(w.date))) {
        await db.weights.put(w);
        wroteWeights[w.date] = w.kg;
      }
    await db.activities.bulkPut(acts);
    await db.foodLog.bulkAdd(food);
    await setSetting('demo.loaded', { at: now.toISOString(), wellness: wroteWellness, weights: wroteWeights });
  });
}

const SUBJECTIVE = ['energy', 'mood', 'soreness'] as const;

/**
 * Toglie da una giornata di salute i valori messi dai dati di prova, lasciando quelli arrivati dopo
 * (come ti senti, dati veri del Garmin). Restituisce null se non resta niente.
 */
export function stripDemoDay(current: WellnessDay, demo: WellnessDay): WellnessDay | null {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(demo)) {
    if (k === 'date') continue;
    if (out[k] === v) delete out[k];
  }
  const rest = Object.keys(out).filter((k) => k !== 'date' && k !== 'source' && out[k] !== undefined);
  if (rest.length === 0) return null;
  const onlyFeeling = rest.every((k) => (SUBJECTIVE as readonly string[]).includes(k));
  return { ...(out as Partial<WellnessDay>), date: current.date, source: onlyFeeling ? 'manuale' : (current.source ?? 'garmin') } as WellnessDay;
}

export async function clearDemo(): Promise<void> {
  const row = await db.settings.get('demo.loaded');
  const info = row?.value as { wellness?: string[] | Record<string, WellnessDay>; weights?: string[] | Record<string, number> } | undefined;
  await db.transaction('rw', [db.wellness, db.weights, db.activities, db.foodLog, db.sessions, db.settings, db.programs, db.templates], async () => {
    await db.activities.where('id').startsWith('demo:').delete();
    await db.templates.where('id').startsWith('demo:').delete();
    await db.programs.where('id').startsWith('demo:').delete();
    await db.foodLog.filter((e) => e.note === DEMO).delete();
    await db.sessions.filter((s) => s.note === DEMO).delete();
    if (Array.isArray(info?.wellness)) await db.wellness.bulkDelete(info.wellness);
    else if (info?.wellness) {
      for (const [d, demoDay] of Object.entries(info.wellness)) {
        const cur = await db.wellness.get(d);
        if (!cur) continue;
        const kept = stripDemoDay(cur, demoDay);
        if (kept) await db.wellness.put(kept);
        else await db.wellness.delete(d);
      }
    }
    const weightDays = Array.isArray(info?.weights) ? Object.fromEntries(info.weights.map((d) => [d, undefined])) : (info?.weights ?? {});
    for (const [d, kg] of Object.entries(weightDays)) {
      const w = await db.weights.get(d);
      // via solo se è ancora il peso di prova (un peso vero inserito dopo resta)
      if (w && w.source === 'manuale' && (kg === undefined || w.kg === kg)) await db.weights.delete(d);
    }
    await db.settings.delete('demo.loaded');
  });
}

export const DEMO_NOTE = DEMO;
