/**
 * Frutta e verdura di stagione nel Lazio (calendario indicativo, fonte ARSIAL e Campagna Amica).
 * Serve per i suggerimenti e per il segno "di stagione" nella ricerca.
 */
import data from '@/data/stagionalita-lazio.json';
import type { FoodItem, ISODate } from '@/db/types';
import { stem, tokenize } from './search';

export interface SeasonItem {
  /** Nome come nel calendario (es. "carciofi romaneschi"). */
  nome: string;
  /** Parola da cercare nel database quando diversa dal nome (es. "carciofi"). */
  chiave?: string;
  /** "inizio" o "primi": prodotto a inizio stagione. */
  nota?: string;
}

export interface SeasonMonth {
  verdura: SeasonItem[];
  frutta: SeasonItem[];
}

type SeasonFile = { meta: { nome: string; fonte: string; nota: string; aggiornato: string }; mesi: Record<string, SeasonMonth> };
const file = data as SeasonFile;

export const SEASON_SOURCE = file.meta.fonte;
export const SEASON_NOTE = file.meta.nota;

const CATEGORIES = new Set(['Verdura', 'Frutta', 'Legumi', 'Frutta secca e semi']);
/** Prodotti conservati: non sono mai "di stagione". */
const PRESERVED = new Set([
  'secc', 'scatol', 'surgelat', 'sciroppat', 'compost', 'confettur', 'marmellat', 'succ', 'essiccat',
  'disidratat', 'candit', 'conserv', 'sott', 'vasett',
]);

const keysByMonth = new Map<number, string[][]>();
for (let m = 1; m <= 12; m++) {
  const month = file.mesi[String(m)];
  const keys = [...month.verdura, ...month.frutta].map((it) => tokenize(it.chiave ?? it.nome).map(stem));
  keysByMonth.set(m, keys);
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`mese non valido: ${month}`);
}

/** Mese (1-12) di una data locale. */
export function monthOf(d: ISODate | Date): number {
  return typeof d === 'string' ? Number(d.slice(5, 7)) : d.getMonth() + 1;
}

/** Verdura e frutta di stagione nel mese indicato (1 = gennaio). */
export function seasonalProduce(month: number): SeasonMonth {
  assertMonth(month);
  return file.mesi[String(month)];
}

function nameStems(food: Pick<FoodItem, 'name' | 'aliases'>): string[][] | null {
  const main = tokenize(food.name).map(stem);
  if (main.some((s) => PRESERVED.has(s))) return null;
  const out = [main];
  for (const a of food.aliases ?? []) {
    const st = tokenize(a).map(stem);
    if (!st.some((s) => PRESERVED.has(s))) out.push(st);
  }
  return out;
}

/** Vero se l'alimento (verdura, frutta, legumi freschi, castagne) e' di stagione nel mese indicato. */
export function isInSeason(food: Pick<FoodItem, 'name' | 'category' | 'aliases'>, month: number): boolean {
  assertMonth(month);
  if (!CATEGORIES.has(food.category)) return false;
  const names = nameStems(food);
  if (!names) return false;
  const keys = keysByMonth.get(month)!;
  return names.some((st) => keys.some((k) => k.length > 0 && st[0] === k[0] && k.every((x) => st.includes(x))));
}

/** Mesi (1-12) in cui l'alimento e' di stagione; vuoto se non e' un prodotto stagionale. */
export function seasonMonths(food: Pick<FoodItem, 'name' | 'category' | 'aliases'>): number[] {
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) if (isInSeason(food, m)) out.push(m);
  return out;
}

/** Filtra gli alimenti di stagione nel mese indicato. */
export function seasonalFoods<T extends Pick<FoodItem, 'name' | 'category' | 'aliases'>>(foods: T[], month: number): T[] {
  return foods.filter((f) => isInSeason(f, month));
}
