import { describe, expect, it } from 'vitest';
import type { FoodLogEntry, WeightEntry } from '@/db/types';
import { addDays, dailyIntake, weeklyCheckIn } from './adaptive';

// 8 settimane di uso: pesate e pasti tutti i giorni, peso stabile
const start = '2026-09-28';
const today = '2026-11-22'; // domenica: la finestra finisce la domenica prima
const days = Array.from({ length: 56 }, (_, i) => addDays(start, i));
const weights: WeightEntry[] = days.map((d) => ({ date: d, kg: 72, source: 'manuale' }));
const log = (from: string): FoodLogEntry[] =>
  days.filter((d) => d >= from).map((d) => ({
    date: d, time: '13:00', slot: 'pranzo', method: 'manuale', createdAt: `${d}T13:00:00`,
    items: [{ name: 'Giornata', grams: 1000, nutrients: { kcal: 2600, protein: 130, carbs: 330, fat: 75 }, source: 'ricetta', confidence: 'alta' }],
  }));
const base = { asOf: today, weights, previousTdee: 2600, bmr: 1700, goal: 'mantenimento' as const };

describe('revisione del lunedì: primo giorno di uso', () => {
  it('con solo gli ultimi 28 giorni caricati e senza startDate la finestra si accorcia (il difetto)', () => {
    const r = weeklyCheckIn({ ...base, intake: dailyIntake(log(addDays(today, -28))) });
    expect(r.status === 'proposta' ? r.window.days : 0).toBeLessThan(21);
  });

  it('passando il primo giorno di uso vero la finestra resta di 3 settimane', () => {
    const r = weeklyCheckIn({ ...base, intake: dailyIntake(log(addDays(today, -28))), startDate: start });
    expect(r.status).toBe('proposta');
    if (r.status === 'proposta') expect(r.window.days).toBe(21);
  });
});
