/**
 * Tipi del motore di nutrizione. Estendono il contratto in src/db/types.ts senza modificarlo:
 * i campi in piu' sono opzionali e quindi retrocompatibili.
 */
import type { Confidence, FoodItem, FoodSource, LoggedItem, Nutrients } from '@/db/types';

/**
 * Nutrienti con le componenti energetiche minori del Regolamento UE 1169/2011.
 * Nel database compaiono solo quando sono maggiori di zero (vino, birra, aceto, frutta secca...).
 * Servono al controllo di Atwater; l'interfaccia puo' ignorarli.
 */
export interface NutrientsExt extends Nutrients {
  /** Alcol etilico, g (7 kcal/g). */
  alcohol?: number;
  /** Polioli, g (2,4 kcal/g), gia' compresi nei carboidrati. */
  polyols?: number;
  /** Acidi organici, g (3 kcal/g). */
  organicAcids?: number;
}

/** Alimento del database base (CIQUAL/USDA) con i campi descrittivi del file alimenti.json. */
export interface DbFood extends FoodItem {
  per100g: NutrientsExt;
  /** Nome originale nella fonte (francese per CIQUAL, inglese per USDA). */
  sourceName?: string;
  /** Ipotesi o approssimazioni (es. "valori della cicoria verde"). */
  note?: string;
}

/** Piatto calcolato da ricetta (src/data/ricette.json). */
export interface DishItem extends FoodItem {
  source: 'ricetta';
  per100g: NutrientsExt;
  recipe: { foodId: string; grams: number }[];
  /** Porzione standard servita, g. */
  servingGrams: number;
  /** Nutrienti della porzione standard (kcal intere, macro a 1 decimale). */
  perServing: Nutrients;
  /** Peso cotto dell'intera ricetta, g. */
  yieldGrams: number;
  /** Peso degli ingredienti crudi, g. */
  rawGrams: number;
  /** Scarto tipico +/- (0,2 = 20%) per gli intervalli. */
  variability: number;
  tags: string[];
  note: string;
}

export interface SourceInfo {
  id: string;
  citazione: string;
  versione: string;
  licenza: string;
  licenzaUrl?: string;
  file?: string;
  md5?: string;
}

export interface FoodDbFile {
  meta: { nome: string; descrizione: string; fonti: SourceInfo[]; modifiche: string[]; numeroAlimenti: number };
  alimenti: DbFood[];
}

export interface DishDbFile {
  meta: { nome: string; metodo: string; fonti: SourceInfo[]; numeroPiatti: number };
  piatti: DishItem[];
}

/** Bozza di voce del diario prodotta da foto, etichetta o testo: si conferma o si corregge prima di salvare. */
export interface DraftItem extends LoggedItem {
  confidence: Confidence;
  gramsRange: [number, number];
  /** Intervallo di kcal corrispondente a gramsRange. */
  kcalRange: [number, number];
  /** Nome restituito dal modello o scritto dall'utente. */
  inputName: string;
  kind: 'piatto' | 'alimento' | 'condimento' | 'bevanda';
  /** Valori per 100 g usati per il calcolo (database o, in mancanza, stima del modello). */
  per100g: Nutrients;
  /** Alternative del database per correggere l'abbinamento con un tocco. */
  alternatives: { foodId: string; name: string; source: FoodSource }[];
  /** Spiegazione breve dell'abbinamento o della stima. */
  why: string;
  cooking?: string;
}

export type { Confidence, FoodItem, FoodSource, LoggedItem, Nutrients };
