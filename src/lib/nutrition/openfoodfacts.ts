/**
 * Prodotti confezionati da Open Food Facts (ODbL), letti in tempo reale dal browser e mai inclusi nel repo.
 * API: GET https://world.openfoodfacts.org/api/v2/product/<codice>.json?fields=... (CORS aperto).
 * Si usano solo i valori dichiarati in etichetta (nutriments), mai le stime di OFF (nutriments_estimated).
 */
import type { FoodItem, Nutrients } from '@/db/types';
import { checkAtwater, roundTo } from './nutrients';

export const OFF_BASE_URL = 'https://world.openfoodfacts.org';
export const OFF_FIELDS = [
  'code', 'product_name', 'product_name_it', 'generic_name_it', 'brands', 'quantity', 'product_quantity',
  'product_quantity_unit', 'serving_size', 'serving_quantity', 'nutrition_data_per', 'nutriments', 'categories_tags',
];

export type OffErrorKind = 'rete' | 'limite' | 'risposta-non-valida' | 'codice-non-valido';

export class OffError extends Error {
  constructor(
    public kind: OffErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'OffError';
  }
}

export interface OffOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  baseUrl?: string;
  /** Timeout in millisecondi (default 10 s). */
  timeoutMs?: number;
}

export type OffResult =
  | { status: 'trovato'; food: FoodItem; atwaterOk: boolean; kcalFrom: 'etichetta' | 'kj' | 'macronutrienti' }
  | { status: 'senza-valori'; code: string; name?: string; brand?: string; missing: string[]; message: string }
  | { status: 'non-trovato'; code: string };

/** Corrispondenza approssimativa tra le categorie di OFF e quelle del database (la prima che combacia). */
const CATEGORY_MAP: [string, string][] = [
  ['en:alcoholic-beverages', 'Bevande alcoliche'],
  ['en:beverages', 'Bevande'],
  ['en:protein-powders', 'Integratori'],
  ['en:dietary-supplements', 'Integratori'],
  ['en:cheeses', 'Formaggi'],
  ['en:yogurts', 'Latte e yogurt'],
  ['en:milks', 'Latte e yogurt'],
  ['en:prepared-meats', 'Salumi'],
  ['en:meats', 'Carne'],
  ['en:seafood', 'Pesce'],
  ['en:fishes', 'Pesce'],
  ['en:eggs', 'Uova'],
  ['en:pastas', 'Pasta, riso e cereali'],
  ['en:rices', 'Pasta, riso e cereali'],
  ['en:breakfast-cereals', 'Colazione'],
  ['en:breads', 'Pane e lievitati'],
  ['en:biscuits-and-cakes', 'Dolci'],
  ['en:chocolates', 'Dolci'],
  ['en:sweet-spreads', 'Dolci'],
  ['en:salty-snacks', 'Snack salati'],
  ['en:legumes', 'Legumi'],
  ['en:nuts', 'Frutta secca e semi'],
  ['en:fats', 'Oli e grassi'],
  ['en:sauces', 'Condimenti e salse'],
  ['en:condiments', 'Condimenti e salse'],
  ['en:fruits', 'Frutta'],
  ['en:vegetables', 'Verdura'],
  ['en:meals', 'Piatti pronti'],
  ['en:cereals-and-their-products', 'Pasta, riso e cereali'],
];

/** Controllo del formato e della cifra di controllo GS1 (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function isValidBarcode(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Mappa la risposta JSON di OFF in un FoodItem (puro, testabile con la fixture). */
export function mapOffProduct(json: unknown, codeHint = ''): OffResult {
  const root = (json ?? {}) as Json;
  const code = str(root.code) ?? codeHint;
  const p = root.product as Json | undefined;
  if (!p || root.status === 0) return { status: 'non-trovato', code };

  const name = str(p.product_name_it) ?? str(p.product_name) ?? str(p.generic_name_it);
  const brand = str(p.brands)?.split(',')[0]?.trim();
  const n = (p.nutriments ?? {}) as Json;
  const servingG = num(p.serving_quantity);

  // valore per 100 g: diretto, oppure dai valori per porzione
  const per100 = (key: string): number | undefined => {
    const v = num(n[`${key}_100g`]);
    if (v !== undefined) return v;
    const s = num(n[`${key}_serving`]);
    if (s !== undefined && servingG && servingG > 0) return (s * 100) / servingG;
    return undefined;
  };

  const protein = per100('proteins');
  const carbs = per100('carbohydrates');
  const fat = per100('fat');
  const missing: string[] = [];
  if (protein === undefined) missing.push('proteine');
  if (carbs === undefined) missing.push('carboidrati');
  if (fat === undefined) missing.push('grassi');

  let kcal = per100('energy-kcal');
  let kcalFrom: 'etichetta' | 'kj' | 'macronutrienti' = 'etichetta';
  if (kcal === undefined) {
    const kj = per100('energy-kj') ?? per100('energy');
    if (kj !== undefined) {
      kcal = kj / 4.184;
      kcalFrom = 'kj';
    }
  }
  const fiber = per100('fiber');
  if (kcal === undefined && missing.length === 0) {
    kcal = 4 * protein! + 4 * carbs! + 9 * fat! + 2 * (fiber ?? 0);
    kcalFrom = 'macronutrienti';
  }
  if (kcal === undefined) missing.unshift('calorie');

  const noValues = (why: string[]): OffResult => ({
    status: 'senza-valori',
    code,
    name,
    brand,
    missing: why,
    message: `Su Open Food Facts mancano ${why.join(', ')} di questo prodotto: fotografa l'etichetta nutrizionale per aggiungerlo.`,
  });
  if (missing.length > 0) return noValues(missing);

  const per100g: Nutrients = { kcal: kcal!, protein: protein!, carbs: carbs!, fat: fat! };
  const opt: [keyof Nutrients, number | undefined][] = [
    ['fiber', fiber],
    ['sugars', per100('sugars')],
    ['satFat', per100('saturated-fat')],
    ['salt', per100('salt') ?? (per100('sodium') !== undefined ? per100('sodium')! * 2.5 : undefined)],
  ];
  for (const [k, v] of opt) if (v !== undefined) per100g[k] = v;

  const values = Object.values(per100g) as number[];
  if (values.some((v) => v < 0) || per100g.kcal > 900 || per100g.protein + per100g.carbs + per100g.fat > 101) {
    return noValues(['valori plausibili']);
  }

  const rounded: Nutrients = { kcal: roundTo(per100g.kcal, 0), protein: 0, carbs: 0, fat: 0 };
  for (const [k, v] of Object.entries(per100g) as [keyof Nutrients, number][]) {
    if (k !== 'kcal') rounded[k] = roundTo(v, k === 'salt' ? 2 : 1);
  }

  const portions: FoodItem['portions'] = [];
  if (servingG && servingG > 0) portions.push({ label: `1 porzione (${fmtG(servingG)} g)`, grams: servingG });
  const qty = num(p.product_quantity);
  const unit = str(p.product_quantity_unit)?.toLowerCase() ?? 'g';
  if (qty && qty > 0 && (unit === 'g' || unit === 'ml')) portions.push({ label: `1 confezione (${fmtG(qty)} ${unit})`, grams: qty });
  portions.push({ label: '100 g', grams: 100 });

  const tags = Array.isArray(p.categories_tags) ? (p.categories_tags as string[]) : [];
  const category = CATEGORY_MAP.find(([tag]) => tags.includes(tag))?.[1] ?? 'Prodotti confezionati';
  const aliases = [str(p.generic_name_it), str(p.product_name)].filter((a): a is string => !!a && a !== name);

  const food: FoodItem = {
    id: `off:${code}`,
    name: name ?? `Prodotto ${code}`,
    aliases: aliases.length ? aliases : undefined,
    category,
    per100g: rounded,
    source: 'off',
    sourceRef: `${OFF_BASE_URL}/product/${code}`,
    portions,
    barcode: code,
    brand,
  };
  if (!food.aliases) delete food.aliases;
  if (!food.brand) delete food.brand;
  return { status: 'trovato', food, atwaterOk: checkAtwater(per100g).ok, kcalFrom };
}

function fmtG(g: number): string {
  return String(roundTo(g, 1)).replace('.', ',');
}

/** Cerca un codice a barre: FoodItem, oppure null se il prodotto non c'e' o non ha valori utilizzabili. */
export async function lookupBarcode(code: string, opts: OffOptions = {}): Promise<FoodItem | null> {
  const r = await lookupBarcodeDetailed(code, opts);
  return r.status === 'trovato' ? r.food : null;
}

/** Come lookupBarcode, ma distingue "non trovato" da "trovato senza valori" (per proporre la foto dell'etichetta). */
export async function lookupBarcodeDetailed(code: string, opts: OffOptions = {}): Promise<OffResult> {
  const clean = code.trim();
  if (!isValidBarcode(clean)) {
    throw new OffError('codice-non-valido', 'Il codice letto non sembra un codice a barre valido: riprova la scansione o scrivilo a mano.');
  }
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${opts.baseUrl ?? OFF_BASE_URL}/api/v2/product/${clean}.json?fields=${OFF_FIELDS.join(',')}`;
  const signal = opts.signal ?? (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(opts.timeoutMs ?? 10_000) : undefined);
  let res: Response;
  try {
    res = await f(url, { signal, headers: { Accept: 'application/json' } });
  } catch {
    throw new OffError('rete', 'Nessuna connessione con Open Food Facts: controlla la connessione e riprova.');
  }
  if (res.status === 429) throw new OffError('limite', 'Troppe richieste a Open Food Facts: riprova tra un minuto.');
  if (res.status >= 500) throw new OffError('rete', 'Open Food Facts non risponde in questo momento: riprova più tardi.');
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new OffError('risposta-non-valida', 'Risposta non valida da Open Food Facts: riprova più tardi.');
  }
  if (res.status === 404 || (json as Json)?.status === 0) return { status: 'non-trovato', code: clean };
  if (!res.ok) throw new OffError('risposta-non-valida', `Open Food Facts ha risposto con un errore (${res.status}).`);
  return mapOffProduct(json, clean);
}
