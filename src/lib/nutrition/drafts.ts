/**
 * Bozze di voci del diario: abbinamento al database, grammi e intervalli.
 * Condiviso da foto, testo ed etichetta.
 */
import type { Confidence, FoodItem, FoodSource, Nutrients } from '@/db/types';
import { atwaterKcal, checkAtwater, kcalRange as kcalRangeOf, roundNutrients, roundTo, scaleNutrients, sumNutrients } from './nutrients';
import type { FoodSearchIndex, MatchResult } from './search';
import type { DishItem, DraftItem } from './types';

export const CONF_RANK: Record<Confidence, number> = { bassa: 0, media: 1, alta: 2 };
export const minConfidence = (a: Confidence, b: Confidence): Confidence => (CONF_RANK[a] <= CONF_RANK[b] ? a : b);

export const SOURCE_LABEL: Record<FoodSource, string> = {
  ciqual: 'valori CIQUAL',
  usda: 'valori USDA',
  crea: 'valori CREA',
  ricetta: 'calcolato dalla ricetta',
  off: 'Open Food Facts',
  utente: 'tuo alimento',
  ai: 'stima del modello',
};

const KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'satFat', 'salt'] as const;

/** Solo i campi di Nutrients (senza alcol, polioli...). */
export function pickNutrients(n: Nutrients): Nutrients {
  const out: Nutrients = { kcal: n.kcal, protein: n.protein, carbs: n.carbs, fat: n.fat };
  for (const k of KEYS.slice(4)) if (typeof n[k] === 'number') out[k] = n[k];
  return out;
}

function variabilityOf(food: FoodItem): number {
  const v = (food as Partial<DishItem>).variability;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * Intervallo di kcal: dai grammi, combinato in quadratura con la variabilita' della ricetta
 * (due incertezze indipendenti: quanto ce n'e' nel piatto e come e' stato cucinato).
 */
export function rangeKcal(per100: Nutrients, grams: number, range: [number, number], variability = 0): [number, number] {
  if (!variability || grams <= 0) return kcalRangeOf(per100, range);
  const center = (per100.kcal * grams) / 100;
  const rg = (range[1] - range[0]) / (2 * grams);
  const r = Math.sqrt(rg * rg + variability * variability);
  return [roundTo(center * Math.max(0, 1 - r), 0), roundTo(center * (1 + r), 0)];
}

/** Grammi e intervallo coerenti (min <= grammi <= max, almeno +-10%). */
export function normalizeGrams(grams: number, lo?: number, hi?: number, minSpread = 0.1): { grams: number; range: [number, number] } {
  const g = Math.min(5000, Math.max(1, Number.isFinite(grams) ? grams : 100));
  let a = Number.isFinite(lo) ? (lo as number) : g * 0.8;
  let b = Number.isFinite(hi) ? (hi as number) : g * 1.2;
  if (a > b) [a, b] = [b, a];
  a = Math.min(a, g * (1 - minSpread));
  b = Math.max(b, g * (1 + minSpread));
  return { grams: g, range: [Math.max(0, a), b] };
}

export interface DraftInfo {
  inputName: string;
  kind: DraftItem['kind'];
  confidence: Confidence;
  why: string;
  alternatives?: FoodItem[];
  cooking?: string;
}

/** Bozza da una voce del database. */
export function draftFromFood(food: FoodItem, grams: number, gramsRange: [number, number], info: DraftInfo): DraftItem {
  const g = roundTo(grams, 0);
  const range: [number, number] = [roundTo(gramsRange[0], 0), roundTo(gramsRange[1], 0)];
  return {
    foodId: food.id,
    name: food.name,
    grams: g,
    nutrients: roundNutrients(scaleNutrients(pickNutrients(food.per100g), g)),
    source: food.source,
    confidence: info.confidence,
    gramsRange: range,
    kcalRange: rangeKcal(food.per100g, g, range, variabilityOf(food)),
    inputName: info.inputName,
    kind: info.kind,
    per100g: pickNutrients(food.per100g),
    alternatives: (info.alternatives ?? [])
      .filter((a) => a.id !== food.id)
      .slice(0, 5)
      .map((a) => ({ foodId: a.id, name: a.name, source: a.source })),
    why: info.why,
    ...(info.cooking ? { cooking: info.cooking } : {}),
  };
}

/** Bozza con i valori per 100 g stimati dal modello (alimento assente dal database): fonte 'ai', fiducia bassa. */
export function draftFromEstimate(name: string, per100: Nutrients, grams: number, gramsRange: [number, number], info: Omit<DraftInfo, 'confidence'>): DraftItem {
  const p: Nutrients = {
    kcal: Math.min(900, Math.max(0, per100.kcal)),
    protein: Math.max(0, per100.protein),
    carbs: Math.max(0, per100.carbs),
    fat: Math.max(0, per100.fat),
  };
  let why = info.why;
  if (!checkAtwater(p, { tolerance: 0.25 }).ok) {
    p.kcal = roundTo(atwaterKcal(p), 0);
    why += ' Calorie ricalcolate dai macronutrienti stimati.';
  }
  const g = roundTo(grams, 0);
  const range: [number, number] = [roundTo(gramsRange[0], 0), roundTo(gramsRange[1], 0)];
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    grams: g,
    nutrients: roundNutrients(scaleNutrients(p, g)),
    source: 'ai',
    confidence: 'bassa',
    gramsRange: range,
    kcalRange: kcalRangeOf(p, range),
    inputName: info.inputName,
    kind: info.kind,
    per100g: p,
    alternatives: (info.alternatives ?? []).slice(0, 5).map((a) => ({ foodId: a.id, name: a.name, source: a.source })),
    why,
    ...(info.cooking ? { cooking: info.cooking } : {}),
  };
}

/** Nuovi grammi per una bozza (correzione dall'interfaccia): intervallo spostato in proporzione. */
export function rescaleDraft(d: DraftItem, grams: number): DraftItem {
  const k = d.grams > 0 ? grams / d.grams : 1;
  const range: [number, number] = [roundTo(d.gramsRange[0] * k, 0), roundTo(d.gramsRange[1] * k, 0)];
  return {
    ...d,
    grams: roundTo(grams, 0),
    gramsRange: range,
    nutrients: roundNutrients(scaleNutrients(d.per100g, grams)),
    kcalRange: [roundTo(d.kcalRange[0] * k, 0), roundTo(d.kcalRange[1] * k, 0)],
  };
}

/** Sostituisce l'alimento abbinato (es. scelta tra le alternative) mantenendo i grammi. */
export function replaceDraftFood(d: DraftItem, food: FoodItem): DraftItem {
  return draftFromFood(food, d.grams, d.gramsRange, {
    inputName: d.inputName,
    kind: d.kind,
    confidence: d.confidence,
    why: `Scelto da te: ${food.name} (${SOURCE_LABEL[food.source]}).`,
    cooking: d.cooking,
  });
}

/** Totali di una lista di bozze, con intervallo come somma degli intervalli. */
export function draftTotals(items: DraftItem[]): Nutrients & { kcalRange: [number, number] } {
  const tot = roundNutrients(sumNutrients(items.map((i) => i.nutrients)));
  const lo = items.reduce((a, i) => a + i.kcalRange[0], 0);
  const hi = items.reduce((a, i) => a + i.kcalRange[1], 0);
  return { ...tot, kcalRange: [lo, hi] };
}

export function kindOf(food: FoodItem): DraftItem['kind'] {
  if (food.source === 'ricetta' || food.category === 'Piatti pronti') return 'piatto';
  if (food.category === 'Bevande' || food.category === 'Bevande alcoliche') return 'bevanda';
  if (food.category === 'Oli e grassi' || food.category === 'Condimenti e salse') return 'condimento';
  return 'alimento';
}

export function whyMatched(input: string, m: MatchResult, extra?: string | null): string {
  const base = `"${input}" abbinato a ${m.food.name} (${SOURCE_LABEL[m.food.source]}).`;
  return extra ? `${base} ${extra.trim().replace(/\.?$/, '.')}` : base;
}

export type { FoodSearchIndex };
