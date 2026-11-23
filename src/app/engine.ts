import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { FoodItem, FoodLogEntry, MealSlot, Nutrients, Profile } from '@/db/types';
import { FoodSearchIndex, computeTargets, loadAllFoods, sumNutrients, weightTrend, type DayType, type Targets } from '@/lib/nutrition';
import { todaysPlan, type TodayPlan } from '@/lib/training/templates';
import { computeReadiness, type Readiness } from '@/lib/health/readiness';
import { addDays, todayISO } from '@/lib/dates';
import { useProfile, useSetting } from './hooks';

/* ------------------------------------------------------ Indice alimenti */

let indexPromise: Promise<FoodSearchIndex> | null = null;
let indexUserKey = '';

/** Indice di ricerca su database base + piatti romani + alimenti dell'utente. Si costruisce una volta. */
export function useFoodIndex(): FoodSearchIndex | null {
  const userFoods = useLiveQuery(() => db.foods.toArray(), []);
  const [index, setIndex] = useState<FoodSearchIndex | null>(null);
  useEffect(() => {
    if (!userFoods) return;
    const key = userFoods.map((f) => f.id).join('|');
    if (!indexPromise || key !== indexUserKey) {
      indexUserKey = key;
      indexPromise = loadAllFoods(userFoods).then((all) => new FoodSearchIndex(all));
    }
    let alive = true;
    indexPromise.then((ix) => alive && setIndex(ix));
    return () => {
      alive = false;
    };
  }, [userFoods]);
  return index;
}

export async function getFoodIndex(): Promise<FoodSearchIndex> {
  if (!indexPromise) {
    const userFoods = await db.foods.toArray();
    indexUserKey = userFoods.map((f) => f.id).join('|');
    indexPromise = loadAllFoods(userFoods).then((all) => new FoodSearchIndex(all));
  }
  return indexPromise;
}

export function invalidateFoodIndex() {
  indexPromise = null;
}

/* ----------------------------------------------------------- Diario */

export const SLOTS: { slot: MealSlot; label: string }[] = [
  { slot: 'colazione', label: 'Colazione' },
  { slot: 'spuntino', label: 'Spuntino' },
  { slot: 'pranzo', label: 'Pranzo' },
  { slot: 'merenda', label: 'Merenda' },
  { slot: 'cena', label: 'Cena' },
];

export function slotLabel(s: MealSlot): string {
  return SLOTS.find((x) => x.slot === s)?.label ?? s;
}

/** Pasto proposto in base all'ora. */
export function slotForTime(d = new Date()): MealSlot {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 10.5) return 'colazione';
  if (h < 12) return 'spuntino';
  if (h < 15.5) return 'pranzo';
  if (h < 19) return 'merenda';
  return 'cena';
}

export function entryTotals(e: Pick<FoodLogEntry, 'items'>): Nutrients {
  return sumNutrients(e.items.map((i) => i.nutrients));
}

export interface DayLog {
  entries: FoodLogEntry[];
  totals: Nutrients;
  bySlot: Map<MealSlot, FoodLogEntry[]>;
}

export function useDayLog(date: string): DayLog | undefined {
  const entries = useLiveQuery(() => db.foodLog.where('date').equals(date).sortBy('time'), [date]);
  return useMemo(() => {
    if (!entries) return undefined;
    const bySlot = new Map<MealSlot, FoodLogEntry[]>();
    for (const e of entries) {
      if (!bySlot.has(e.slot)) bySlot.set(e.slot, []);
      bySlot.get(e.slot)!.push(e);
    }
    return { entries, totals: sumNutrients(entries.flatMap((e) => e.items.map((i) => i.nutrients))), bySlot };
  }, [entries]);
}

/** Totali dei 7 giorni prima di `date` (per le tacche sopra le corsie). */
export function useWeekHistory(date: string): Nutrients[] | undefined {
  const from = addDays(date, -7);
  const to = addDays(date, -1);
  const rows = useLiveQuery(() => db.foodLog.where('date').between(from, to, true, true).toArray(), [from, to]);
  return useMemo(() => {
    if (!rows) return undefined;
    const by = new Map<string, Nutrients[]>();
    for (const e of rows) {
      if (!by.has(e.date)) by.set(e.date, []);
      by.get(e.date)!.push(...e.items.map((i) => i.nutrients));
    }
    return [...by.values()].map((list) => sumNutrients(list));
  }, [rows]);
}

/* ------------------------------------------------------- Piano di oggi */

export function useTodayPlan(date: string): TodayPlan | null | undefined {
  // null = nessuna scheda attiva; undefined = sto ancora leggendo
  const program = useLiveQuery(async () => (await db.programs.filter((p) => p.active).first()) ?? null, []);
  const templates = useLiveQuery(() => (program ? db.templates.where('programId').equals(program.id).sortBy('order') : []), [program?.id]);
  const sessions = useLiveQuery(() => db.sessions.where('date').between(addDays(date, -21), date, true, true).toArray(), [date]);
  const acts = useLiveQuery(() => db.activities.where('start').aboveOrEqual(addDays(date, -21)).toArray(), [date]);
  const profile = useProfile();
  return useMemo(() => {
    if (program === undefined || templates === undefined || sessions === undefined || acts === undefined || profile === null) return undefined;
    if (!program || templates.length === 0) return null;
    return todaysPlan(program, templates, sessions, acts, date, {
      gymDaysPerWeek: profile?.gymDaysPerWeek,
      runDaysPerWeek: profile?.runDaysPerWeek,
    });
  }, [program, templates, sessions, acts, date, profile]);
}

export function dayTypeOf(plan: TodayPlan | null | undefined): DayType | null {
  if (!plan) return null;
  if (plan.tipo === 'riposo') return 'riposo';
  if (plan.tipo === 'corsa' || plan.tipo === 'doppio') return 'corsa';
  return 'palestra';
}

/* ---------------------------------------------------------- Target */

export interface TargetsState {
  targets: Targets;
  /** Target del giorno (tipo di giorno dalla scheda), o la media della settimana se non c'è una scheda. */
  day: { kcal: number; protein: number; carbs: number; fat: number; label: string };
  dayType: DayType | null;
  trendKg?: number;
}

export function useTargets(date: string, plan: TodayPlan | null | undefined): TargetsState | null | undefined {
  const profile = useProfile();
  const weights = useLiveQuery(() => db.weights.where('date').between(addDays(date, -60), date, true, true).toArray(), [date]);
  const [tdee] = useSetting<number | null>('nutrition.tdee', null);
  return useMemo(() => {
    if (profile === null || weights === undefined) return undefined;
    if (!profile) return null;
    const trend = weightTrend([...weights].sort((a, b) => a.date.localeCompare(b.date))).at(-1)?.trend;
    const targets = computeTargets(profile as Profile, { today: date, weightKg: trend, tdeeKcal: tdee ?? undefined });
    const dayType = dayTypeOf(plan);
    const src = dayType ? targets.days[dayType] : targets.average;
    const label = dayType === 'palestra' ? 'Giorno di palestra' : dayType === 'corsa' ? 'Giorno di corsa' : dayType === 'riposo' ? 'Giorno di riposo' : 'Media della settimana';
    return {
      targets,
      dayType,
      trendKg: trend,
      day: { kcal: src.kcal.value, protein: src.protein.value, carbs: src.carbs.value, fat: src.fat.value, label },
    };
  }, [profile, weights, tdee, date, plan]);
}

/* ---------------------------------------------------------- Prontezza */

export function useReadiness(date = todayISO()): Readiness | undefined {
  const days = useLiveQuery(() => db.wellness.where('date').between(addDays(date, -60), date, true, true).toArray(), [date]);
  return useMemo(() => (days ? computeReadiness(days, date) : undefined), [days, date]);
}

export type { FoodItem };
