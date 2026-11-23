import type { WeightEntry } from '@/db/types';
import { weightTrend as trendPoints } from '@/lib/nutrition';

/**
 * Tendenza del peso per i grafici: la stessa media mobile esponenziale (alfa 0,1, una volta per pesata)
 * usata dall'adattamento settimanale dei target, così grafico e proposta del lunedì dicono la stessa cosa.
 */
export function weightTrend(weights: WeightEntry[]): { date: string; kg: number }[] {
  return trendPoints(weights).map((p) => ({ date: p.date, kg: Math.round(p.trend * 100) / 100 }));
}
