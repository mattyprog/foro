/**
 * Operazioni sui nutrienti: scala per grammi, somma, arrotondamenti per l'interfaccia,
 * controllo di coerenza di Atwater con i fattori del Regolamento UE 1169/2011.
 */
import type { Nutrients } from '@/db/types';
import type { NutrientsExt } from './types';

export const REQUIRED_KEYS = ['kcal', 'protein', 'carbs', 'fat'] as const;
export const OPTIONAL_KEYS = ['fiber', 'sugars', 'satFat', 'salt'] as const;
const EXTRA_KEYS = ['alcohol', 'polyols', 'organicAcids'] as const;

type OptionalKey = (typeof OPTIONAL_KEYS)[number];

/** Arrotondamento decimale robusto (evita 1,005 -> 1,00 per errore binario). */
export function roundTo(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(Number(`${x}e${decimals}`));
  return Number(`${r}e-${decimals}`);
}

function assertGrams(grams: number): void {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new RangeError(`grammi non validi: ${grams}`);
  }
}

/** Valori per 100 g scalati ai grammi indicati. I nutrienti mancanti restano undefined. */
export function scaleNutrients<T extends Nutrients>(per100g: T, grams: number): T {
  assertGrams(grams);
  const f = grams / 100;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(per100g)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v * f;
  }
  return out as unknown as T;
}

export interface SumOptions {
  /** Se vero, un opzionale mancante in una voce rende vuoto il totale di quell'opzionale. */
  strict?: boolean;
}

/**
 * Somma di piu' voci. Per gli opzionali (fibre, zuccheri, saturi, sale) somma i valori disponibili;
 * il totale e' undefined solo se nessuna voce lo riporta (o se una manca, con strict).
 */
export function sumNutrients(list: Nutrients[], opts: SumOptions = {}): Nutrients {
  const out: Nutrients = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const n of list) {
    for (const k of REQUIRED_KEYS) out[k] += n[k];
  }
  for (const k of OPTIONAL_KEYS) {
    const vals = list.map((n) => n[k]);
    const present = vals.filter((v): v is number => typeof v === 'number');
    if (present.length === 0) continue;
    if (opts.strict && present.length < vals.length) continue;
    out[k as OptionalKey] = present.reduce((a, b) => a + b, 0);
  }
  return out;
}

/** Arrotondamento per l'interfaccia: kcal intere, tutto il resto a un decimale. */
export function roundNutrients(n: Nutrients): Nutrients {
  const out: Nutrients = {
    kcal: roundTo(n.kcal, 0),
    protein: roundTo(n.protein, 1),
    carbs: roundTo(n.carbs, 1),
    fat: roundTo(n.fat, 1),
  };
  for (const k of OPTIONAL_KEYS) {
    const v = n[k];
    if (typeof v === 'number') out[k] = roundTo(v, 1);
  }
  return out;
}

/**
 * Energia attesa dai macronutrienti con i fattori UE: 4 kcal/g proteine e carboidrati disponibili,
 * 9 grassi, 2 fibre, 7 alcol, 2,4 polioli (gia' inclusi nei carboidrati), 3 acidi organici.
 */
export function atwaterKcal(n: NutrientsExt): number {
  const g = (v: number | undefined) => (typeof v === 'number' ? v : 0);
  const polyols = g(n.polyols);
  return (
    4 * n.protein +
    4 * (n.carbs - polyols) +
    2.4 * polyols +
    9 * n.fat +
    2 * g(n.fiber) +
    7 * g(n.alcohol) +
    3 * g(n.organicAcids)
  );
}

export interface AtwaterCheck {
  ok: boolean;
  expected: number;
  /** kcal dichiarate - kcal attese. */
  diff: number;
  /** diff / kcal dichiarate (0 se le kcal sono 0). */
  diffPct: number;
}

/** Coerenza tra kcal e macronutrienti: entro il 10% (o entro 3 kcal per gli alimenti quasi senza calorie). */
export function checkAtwater(
  n: NutrientsExt,
  opts: { tolerance?: number; minAbsKcal?: number } = {},
): AtwaterCheck {
  const tolerance = opts.tolerance ?? 0.1;
  const minAbs = opts.minAbsKcal ?? 3;
  const expected = atwaterKcal(n);
  const diff = n.kcal - expected;
  const diffPct = n.kcal > 0 ? diff / n.kcal : 0;
  return { ok: Math.abs(diff) <= Math.max(tolerance * n.kcal, minAbs), expected, diff, diffPct };
}

/** Intervallo di kcal (interi) per un intervallo di grammi. */
export function kcalRange(per100g: Nutrients, gramsRange: [number, number]): [number, number] {
  const [a, b] = gramsRange;
  assertGrams(a);
  assertGrams(b);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return [roundTo((per100g.kcal * lo) / 100, 0), roundTo((per100g.kcal * hi) / 100, 0)];
}

/** Ripartizione percentuale delle calorie tra i macronutrienti (somma 1, salvo arrotondamenti). */
export function macroSplit(n: Nutrients): { protein: number; carbs: number; fat: number } {
  const p = 4 * n.protein;
  const c = 4 * n.carbs;
  const f = 9 * n.fat;
  const tot = p + c + f;
  if (tot <= 0) return { protein: 0, carbs: 0, fat: 0 };
  return { protein: p / tot, carbs: c / tot, fat: f / tot };
}

export function isExtraKey(k: string): boolean {
  return (EXTRA_KEYS as readonly string[]).includes(k);
}
