/**
 * Caricamento del database alimenti e dei piatti.
 *
 * I JSON (circa 320 KB + 50 KB, 58 KB + 9 KB compressi) si importano in modo dinamico: Vite li mette
 * in chunk separati che non pesano sul primo caricamento e che il service worker della PWA mette in
 * cache insieme agli altri file JS, quindi la ricerca funziona anche offline.
 */
import type { FoodItem } from '@/db/types';
import type { DbFood, DishDbFile, DishItem, FoodDbFile } from './types';

let baseFile: Promise<FoodDbFile> | undefined;
let dishFile: Promise<DishDbFile> | undefined;

function loadBaseFile(): Promise<FoodDbFile> {
  baseFile ??= import('@/data/alimenti.json').then((m) => (m.default ?? m) as unknown as FoodDbFile);
  return baseFile;
}

function loadDishFile(): Promise<DishDbFile> {
  dishFile ??= import('@/data/ricette.json').then((m) => (m.default ?? m) as unknown as DishDbFile);
  return dishFile;
}

/** Alimenti del database base (CIQUAL 2025 e USDA), valori per 100 g. */
export async function loadBaseFoods(): Promise<DbFood[]> {
  return (await loadBaseFile()).alimenti;
}

/** Piatti romani e italiani calcolati da ricetta. */
export async function loadDishes(): Promise<DishItem[]> {
  return (await loadDishFile()).piatti;
}

/** Metadati del database: fonti, licenze, regole applicate (da mostrare nella pagina "Fonti"). */
export async function loadFoodDbMeta(): Promise<FoodDbFile['meta']> {
  return (await loadBaseFile()).meta;
}

/** Testo di attribuzione da mostrare nell'app (obbligatorio per la Licence Ouverte di CIQUAL). */
export const ATTRIBUTION =
  "Valori nutrizionali: Anses, Table de composition nutritionnelle des aliments Ciqual 2025 (Licence Ouverte 2.0); " +
  "USDA FoodData Central SR Legacy (pubblico dominio); prodotti confezionati: Open Food Facts (ODbL). " +
  'Selezione, nomi italiani, porzioni e ricette: Foro.';

/** Tutte le voci cercabili: base, piatti e alimenti dell'utente (tabella foods di Dexie). */
export async function loadAllFoods(userFoods: FoodItem[] = []): Promise<FoodItem[]> {
  const [base, dishes] = await Promise.all([loadBaseFoods(), loadDishes()]);
  return [...userFoods, ...dishes, ...base];
}
