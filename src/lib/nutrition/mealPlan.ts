/**
 * Menu del giorno alla romana: proposte di pasti costruite sugli obiettivi del giorno.
 *
 * Ogni pasto è un modello con componenti a ruolo fisso. Si scalano la parte proteica e quella dei
 * carboidrati per centrare proteine e calorie della quota del pasto; verdura, olio e frutta restano
 * porzioni normali. Frutta e verdura vengono dal calendario di stagione del Lazio.
 * Nessun numero inventato: i valori sono quelli del database (CIQUAL, USDA) sui grammi proposti.
 */
import type { DietStyle, FoodItem, ISODate, MealSlot, Nutrients } from '@/db/types';
import { roundNutrients, scaleNutrients, sumNutrients } from './nutrients';
import { monthOf, seasonalProduce } from './season';

export type PlanRole = 'proteina' | 'carboidrati' | 'verdura' | 'frutta' | 'condimento' | 'extra';
/** Cosa contiene un pasto: serve per stile alimentare e allergie. */
export type PlanContent = 'carne' | 'pesce' | 'latticini' | 'uova' | 'miele' | 'glutine' | 'frutta a guscio' | 'soia';

interface PlanComponent {
  /** id del database, oppure 'stagione:verdura' / 'stagione:frutta'. */
  id: string;
  g: number;
  role: PlanRole;
  /** Grammi massimi sensati per questo alimento in un pasto. */
  max?: number;
}

export interface MealTemplate {
  id: string;
  slots: MealSlot[];
  nome: string;
  comps: PlanComponent[];
  contiene: PlanContent[];
}

const OLIO = 'olio-extravergine-di-oliva';
const PANE = 'pane-casereccio';
const PASTA = 'pasta-di-semola-cruda';
const RISO = 'riso-bianco-crudo';
const VERDURA = 'stagione:verdura';
const FRUTTA = 'stagione:frutta';

export const MEAL_TEMPLATES: MealTemplate[] = [
  // colazione
  { id: 'yogurt-avena', slots: ['colazione'], nome: "Yogurt greco, fiocchi d'avena e frutta di stagione", contiene: ['latticini', 'glutine', 'frutta a guscio'],
    comps: [{ id: 'yogurt-greco-bianco-0', g: 170, role: 'proteina', max: 300 }, { id: 'fiocchi-d-avena', g: 40, role: 'carboidrati', max: 90 }, { id: FRUTTA, g: 150, role: 'frutta' }, { id: 'noci-gherigli', g: 10, role: 'condimento' }] },
  { id: 'pane-ricotta', slots: ['colazione'], nome: 'Pane casereccio, ricotta di pecora e miele', contiene: ['latticini', 'glutine', 'miele'],
    comps: [{ id: 'ricotta-di-pecora', g: 100, role: 'proteina', max: 200 }, { id: PANE, g: 70, role: 'carboidrati', max: 160 }, { id: 'miele', g: 10, role: 'extra' }, { id: FRUTTA, g: 150, role: 'frutta' }] },
  { id: 'uova-pane', slots: ['colazione'], nome: 'Uova strapazzate, pane casereccio e frutta', contiene: ['uova', 'glutine'],
    comps: [{ id: 'uova-strapazzate', g: 120, role: 'proteina', max: 200 }, { id: PANE, g: 70, role: 'carboidrati', max: 160 }, { id: FRUTTA, g: 150, role: 'frutta' }] },
  { id: 'soia-avena', slots: ['colazione'], nome: "Bevanda di soia, fiocchi d'avena e frutta", contiene: ['soia', 'glutine', 'frutta a guscio'],
    comps: [{ id: 'bevanda-di-soia-senza-zucchero', g: 300, role: 'proteina', max: 400 }, { id: 'fiocchi-d-avena', g: 50, role: 'carboidrati', max: 90 }, { id: FRUTTA, g: 150, role: 'frutta' }, { id: 'noci-gherigli', g: 10, role: 'condimento' }] },

  // pranzo e cena
  { id: 'pasta-e-ceci', slots: ['pranzo', 'cena'], nome: 'Pasta e ceci', contiene: ['glutine'],
    comps: [{ id: 'ceci-lessati', g: 150, role: 'proteina', max: 350 }, { id: PASTA, g: 70, role: 'carboidrati', max: 150 }, { id: 'pomodori-pelati-in-scatola', g: 50, role: 'extra' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'pasta-lenticchie', slots: ['pranzo', 'cena'], nome: 'Pasta e lenticchie', contiene: ['glutine'],
    comps: [{ id: 'lenticchie-lessate', g: 180, role: 'proteina', max: 320 }, { id: PASTA, g: 70, role: 'carboidrati', max: 150 }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'pasta-pollo-broccoletti', slots: ['pranzo'], nome: 'Pasta con pollo e broccoletti ripassati', contiene: ['carne', 'glutine', 'latticini'],
    comps: [{ id: 'petto-di-pollo-crudo', g: 120, role: 'proteina', max: 220 }, { id: PASTA, g: 80, role: 'carboidrati', max: 150 }, { id: 'broccoletti-cime-di-rapa-lessati', g: 150, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }, { id: 'pecorino-romano', g: 5, role: 'extra' }] },
  { id: 'riso-tonno', slots: ['pranzo'], nome: 'Riso, tonno e verdura di stagione', contiene: ['pesce'],
    comps: [{ id: 'tonno-al-naturale-sgocciolato', g: 100, role: 'proteina', max: 160 }, { id: RISO, g: 80, role: 'carboidrati', max: 150 }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'tacchino-riso', slots: ['pranzo', 'cena'], nome: 'Fesa di tacchino, riso e verdura di stagione', contiene: ['carne'],
    comps: [{ id: 'fesa-di-tacchino-cruda', g: 150, role: 'proteina', max: 250 }, { id: RISO, g: 80, role: 'carboidrati', max: 150 }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'pollo-patate', slots: ['pranzo', 'cena'], nome: 'Pollo ai ferri, patate al forno, verdura e pane', contiene: ['carne', 'glutine'],
    comps: [{ id: 'petto-di-pollo-crudo', g: 160, role: 'proteina', max: 250 }, { id: 'patate-crude-senza-buccia', g: 250, role: 'carboidrati', max: 400 }, { id: PANE, g: 40, role: 'carboidrati', max: 100 }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'alici-cicoria', slots: ['cena', 'pranzo'], nome: 'Alici al forno, cicoria ripassata e pane casereccio', contiene: ['pesce', 'glutine'],
    comps: [{ id: 'alici-crude', g: 180, role: 'proteina', max: 280 }, { id: PANE, g: 70, role: 'carboidrati', max: 180 }, { id: 'cicoria-cruda', g: 250, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'merluzzo-patate', slots: ['cena', 'pranzo'], nome: 'Merluzzo al forno con patate, verdura e pane', contiene: ['pesce', 'glutine'],
    comps: [{ id: 'merluzzo-crudo', g: 200, role: 'proteina', max: 300 }, { id: 'patate-crude-senza-buccia', g: 250, role: 'carboidrati', max: 400 }, { id: PANE, g: 40, role: 'carboidrati', max: 100 }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'frittata-verdure', slots: ['cena'], nome: 'Frittata con verdura di stagione e pane', contiene: ['uova', 'glutine'],
    comps: [{ id: 'uovo-intero-crudo', g: 165, role: 'proteina', max: 220 }, { id: PANE, g: 70, role: 'carboidrati', max: 160 }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 5, role: 'condimento' }] },
  { id: 'tofu-riso', slots: ['pranzo', 'cena'], nome: 'Tofu saltato, riso e verdura di stagione', contiene: ['soia'],
    comps: [{ id: 'tofu', g: 150, role: 'proteina', max: 250 }, { id: RISO, g: 80, role: 'carboidrati', max: 150 }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },
  { id: 'fagioli-uccelletto', slots: ['cena', 'pranzo'], nome: "Fagioli all'uccelletto, pane casereccio e verdura", contiene: ['glutine'],
    comps: [{ id: 'fagioli-cannellini-lessati', g: 200, role: 'proteina', max: 350 }, { id: PANE, g: 70, role: 'carboidrati', max: 160 }, { id: 'pomodori-pelati-in-scatola', g: 100, role: 'extra' }, { id: VERDURA, g: 200, role: 'verdura' }, { id: OLIO, g: 10, role: 'condimento' }] },

  // spuntino e merenda
  { id: 'lupini-frutta', slots: ['spuntino', 'merenda'], nome: 'Lupini e frutta di stagione', contiene: [],
    comps: [{ id: 'lupini-pronti-in-salamoia', g: 80, role: 'proteina', max: 200 }, { id: FRUTTA, g: 150, role: 'frutta' }] },
  { id: 'yogurt-frutta', slots: ['spuntino', 'merenda'], nome: 'Yogurt greco e frutta di stagione', contiene: ['latticini'],
    comps: [{ id: 'yogurt-greco-bianco-0', g: 170, role: 'proteina', max: 300 }, { id: FRUTTA, g: 150, role: 'frutta' }] },
  { id: 'pane-tonno', slots: ['merenda', 'spuntino'], nome: 'Pane casereccio e tonno', contiene: ['pesce', 'glutine'],
    comps: [{ id: 'tonno-al-naturale-sgocciolato', g: 60, role: 'proteina', max: 110 }, { id: PANE, g: 60, role: 'carboidrati', max: 120 }] },
  { id: 'soia-frutta', slots: ['spuntino', 'merenda'], nome: 'Bevanda di soia, frutta e noci', contiene: ['soia', 'frutta a guscio'],
    comps: [{ id: 'bevanda-di-soia-senza-zucchero', g: 250, role: 'proteina', max: 350 }, { id: FRUTTA, g: 150, role: 'frutta' }, { id: 'noci-gherigli', g: 10, role: 'condimento' }] },
];

/** Nome nel calendario di stagione -> voce del database e porzione. */
const SEASON_FOOD: Record<string, { id: string; g?: number }> = {
  agretti: { id: 'agretti-barba-di-frate-crudi' }, asparagi: { id: 'asparagi-verdi-lessati' }, bietole: { id: 'bietole-lessate' },
  broccoletti: { id: 'broccoletti-cime-di-rapa-lessati' }, broccoli: { id: 'broccoli-lessati' }, carciofi: { id: 'carciofi-lessati' },
  cavolfiori: { id: 'cavolfiore-lessato' }, cetrioli: { id: 'cetriolo-crudo' }, cicoria: { id: 'cicoria-cruda' },
  fagiolini: { id: 'fagiolini-lessati' }, finocchi: { id: 'finocchio-crudo' }, lattuga: { id: 'lattuga-cruda' },
  melanzane: { id: 'melanzane-cotte' }, peperoni: { id: 'peperone-rosso-crudo' }, pomodori: { id: 'pomodori-crudi' },
  puntarelle: { id: 'puntarelle-crude' }, radicchio: { id: 'radicchio-rosso-crudo' }, rucola: { id: 'rucola-cruda', g: 80 },
  spinaci: { id: 'spinaci-lessati' }, zucca: { id: 'zucca-cruda' }, zucchine: { id: 'zucchine-lessate' },
  albicocche: { id: 'albicocche-crude' }, angurie: { id: 'anguria-cruda', g: 250 }, arance: { id: 'arancia-cruda' },
  cachi: { id: 'cachi-crudi' }, ciliegie: { id: 'ciliegie-crude' }, clementine: { id: 'clementine-o-mandarini-crudi' },
  mandarini: { id: 'clementine-o-mandarini-crudi' }, fichi: { id: 'fichi-crudi', g: 100 }, fragole: { id: 'fragole-crude' },
  kiwi: { id: 'kiwi-crudo' }, mele: { id: 'mela-cruda-con-buccia' }, pere: { id: 'pera-cruda-con-buccia' },
  meloni: { id: 'melone-crudo', g: 250 }, pesche: { id: 'pesca-cruda-con-buccia' }, prugne: { id: 'prugne-susine-crude' },
  uva: { id: 'uva-cruda', g: 120 }, melagrana: { id: 'melagrana-chicchi', g: 100 }, more: { id: 'more-crude' }, nespole: { id: 'nespole-crude' },
};
const FALLBACK = { verdura: 'insalata-verde-cruda-senza-condimento', frutta: 'mela-cruda-con-buccia' };

/** Quote delle calorie della giornata per pasto, secondo quanti pasti fai. */
export function mealShares(mealsPerDay: number): { slot: MealSlot; share: number }[] {
  const n = Math.max(2, Math.min(6, Math.round(mealsPerDay)));
  if (n === 2) return [{ slot: 'pranzo', share: 0.5 }, { slot: 'cena', share: 0.5 }];
  if (n === 3) return [{ slot: 'colazione', share: 0.25 }, { slot: 'pranzo', share: 0.4 }, { slot: 'cena', share: 0.35 }];
  if (n === 4) return [{ slot: 'colazione', share: 0.22 }, { slot: 'pranzo', share: 0.35 }, { slot: 'merenda', share: 0.1 }, { slot: 'cena', share: 0.33 }];
  return [{ slot: 'colazione', share: 0.2 }, { slot: 'spuntino', share: 0.1 }, { slot: 'pranzo', share: 0.3 }, { slot: 'merenda', share: 0.1 }, { slot: 'cena', share: 0.3 }];
}

const BY_DIET: Record<DietStyle, PlanContent[]> = {
  onnivora: [],
  pescetariana: ['carne'],
  vegetariana: ['carne', 'pesce'],
  vegana: ['carne', 'pesce', 'latticini', 'uova', 'miele'],
};

/** Allergie dell'onboarding -> contenuti da evitare. */
const BY_ALLERGY: Record<string, PlanContent[]> = {
  lattosio: ['latticini'],
  glutine: ['glutine'],
  'frutta a guscio': ['frutta a guscio'],
  uova: ['uova'],
  pesce: ['pesce'],
  soia: ['soia'],
};

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

export interface MenuOptions {
  date: ISODate;
  target: { kcal: number; protein: number; carbs?: number; fat?: number };
  mealsPerDay: number;
  diet: DietStyle;
  allergies?: string[];
  excluded?: string[];
  get: (id: string) => FoodItem | undefined;
  /** Proposte scartate con "altra proposta", per pasto: non tornano finché ce ne sono altre. */
  avoid?: Partial<Record<MealSlot, string[]>>;
}

export interface MenuItem {
  foodId: string;
  name: string;
  grams: number;
  role: PlanRole;
  nutrients: Nutrients;
}

export interface MenuMeal {
  slot: MealSlot;
  templateId: string;
  name: string;
  items: MenuItem[];
  totals: Nutrients;
  target: { kcal: number; protein: number };
  /** Quante proposte compatibili ci sono per questo pasto. */
  options: number;
}

export interface DayMenu {
  meals: MenuMeal[];
  totals: Nutrients;
  /** Pasti senza nessuna proposta compatibile (allergie o esclusioni troppo strette). */
  missing: MealSlot[];
}

/** Modelli compatibili con stile alimentare, allergie e cibi esclusi, per un pasto. */
export function compatibleTemplates(slot: MealSlot, o: Pick<MenuOptions, 'diet' | 'allergies' | 'excluded' | 'get'>): MealTemplate[] {
  const banned = new Set<PlanContent>([...BY_DIET[o.diet], ...(o.allergies ?? []).flatMap((a) => BY_ALLERGY[norm(a)] ?? [])]);
  const excluded = (o.excluded ?? []).map(norm).filter((x) => x.length >= 3);
  return MEAL_TEMPLATES.filter((t) => {
    if (!t.slots.includes(slot)) return false;
    if (t.contiene.some((c) => banned.has(c))) return false;
    if (excluded.length === 0) return true;
    const words = [t.nome, ...t.comps.map((c) => o.get(c.id)?.name ?? c.id)].map(norm).join(' | ');
    return !excluded.some((x) => words.includes(x));
  });
}

function dayNumber(date: ISODate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function seasonalFood(kind: 'verdura' | 'frutta', date: ISODate, salt: number, get: MenuOptions['get'], excluded: string[]): { food: FoodItem; g?: number } | undefined {
  const s = seasonalProduce(monthOf(date));
  const names = (s?.[kind] ?? []).map((x) => (x as { chiave?: string; nome: string }).chiave ?? x.nome);
  const foods = names
    .map((n) => SEASON_FOOD[n])
    .filter((x): x is { id: string; g?: number } => !!x)
    .map((x) => ({ food: get(x.id), g: x.g }))
    .filter((x): x is { food: FoodItem; g: number | undefined } => !!x.food && !excluded.some((e) => norm(x.food!.name).includes(e)));
  // niente doppioni (es. clementine e mandarini sono la stessa voce)
  const uniq = foods.filter((x, i) => foods.findIndex((y) => y.food.id === x.food.id) === i);
  if (uniq.length > 0) return uniq[(dayNumber(date) + salt) % uniq.length];
  const fb = get(FALLBACK[kind]);
  return fb ? { food: fb } : undefined;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function roundGrams(g: number, role: PlanRole): number {
  if (role === 'condimento' || role === 'extra') return Math.max(5, Math.round(g / 5) * 5);
  if (g < 100) return Math.max(5, Math.round(g / 5) * 5);
  return Math.round(g / 10) * 10;
}

interface Resolved {
  food: FoodItem;
  g: number;
  role: PlanRole;
  max?: number;
}

export interface MealTarget {
  kcal: number;
  protein: number;
  /** Se presente, l'olio si regola per avvicinare anche i grassi. */
  fat?: number;
}

type Scales = { sp: number; sc: number; sf: number };

const factorOf = (r: Resolved, k: Scales) => (r.role === 'proteina' ? k.sp : r.role === 'carboidrati' ? k.sc : r.role === 'condimento' ? k.sf : 1);

function totalsAt(parts: Resolved[], k: Scales): Nutrients {
  return sumNutrients(parts.map((r) => scaleNutrients(r.food.per100g, r.g * factorOf(r, k))));
}

/** Limite superiore del fattore per un ruolo: il minimo tra 2,6 e i tetti in grammi dei suoi alimenti. */
function upper(parts: Resolved[], role: PlanRole, hi: number): number {
  return parts.filter((r) => r.role === role).reduce((u, r) => (r.max ? Math.min(u, r.max / r.g) : u), hi);
}

/**
 * Fattori per proteine (sp), carboidrati (sc) e olio (sf) che centrano proteine, calorie e, se dati, grassi.
 * Sistema lineare 2x2 per proteine e calorie, ripetuto dopo ogni correzione dell'olio; tutto dentro limiti sensati.
 */
export function fitMeal(parts: Resolved[], target: MealTarget): Scales {
  const LO = 0.4;
  const spHi = upper(parts, 'proteina', 2.6);
  const scHi = upper(parts, 'carboidrati', 2.6);
  const k: Scales = { sp: 1, sc: 1, sf: 1 };
  const of = (role: PlanRole) => sumNutrients(parts.filter((r) => r.role === role).map((r) => scaleNutrients(r.food.per100g, r.g)));
  const P = of('proteina');
  const C = of('carboidrati');
  const F = of('condimento');
  for (let it = 0; it < 6; it++) {
    const rest = sumNutrients(
      parts.filter((r) => r.role !== 'proteina' && r.role !== 'carboidrati').map((r) => scaleNutrients(r.food.per100g, r.g * factorOf(r, k))),
    );
    const tp = target.protein - rest.protein;
    const tk = target.kcal - rest.kcal;
    if (P.kcal > 0 && C.kcal > 0) {
      const det = P.protein * C.kcal - C.protein * P.kcal;
      let sp = Math.abs(det) > 1e-6 ? (tp * C.kcal - C.protein * tk) / det : tp / Math.max(P.protein, 0.1);
      let sc = Math.abs(det) > 1e-6 ? (P.protein * tk - P.kcal * tp) / det : 1;
      if (sp < LO || sp > spHi || sc < LO || sc > scHi) {
        sp = clamp((tp - C.protein * clamp(sc, LO, scHi)) / Math.max(P.protein, 0.1), LO, spHi);
        sc = clamp((tk - sp * P.kcal) / C.kcal, LO, scHi);
      }
      k.sp = sp;
      k.sc = sc;
    } else if (P.kcal > 0) {
      k.sp = clamp(tp / Math.max(P.protein, 0.1), LO, spHi);
    } else if (C.kcal > 0) {
      k.sc = clamp(tk / C.kcal, LO, scHi);
    }
    if (target.fat === undefined || F.fat <= 0) break;
    // l'olio copre i grassi che mancano (da 5 a 25 g circa); i carboidrati si riadattano al giro dopo
    const fat = totalsAt(parts, k).fat;
    const next = clamp(k.sf + (target.fat - fat) / F.fat, 0.5, 2.5);
    if (Math.abs(next - k.sf) < 0.02) break;
    k.sf = next;
  }
  return k;
}

export function buildMeal(t: MealTemplate, slot: MealSlot, target: MealTarget, o: MenuOptions, salt: number, options: number): MenuMeal | undefined {
  const excluded = (o.excluded ?? []).map(norm).filter((x) => x.length >= 3);
  const parts: Resolved[] = [];
  for (const c of t.comps) {
    if (c.id === VERDURA || c.id === FRUTTA) {
      const s = seasonalFood(c.id === VERDURA ? 'verdura' : 'frutta', o.date, salt, o.get, excluded);
      if (s) parts.push({ food: s.food, g: s.g ?? c.g, role: c.role });
      continue;
    }
    const f = o.get(c.id);
    if (!f) return undefined;
    parts.push({ food: f, g: c.g, role: c.role, max: c.max });
  }
  const k = fitMeal(parts, target);
  const items: MenuItem[] = parts.map((r) => {
    const grams = roundGrams(r.g * factorOf(r, k), r.role);
    return { foodId: r.food.id, name: r.food.name, grams, role: r.role, nutrients: roundNutrients(scaleNutrients(r.food.per100g, grams)) };
  });
  return { slot, templateId: t.id, name: t.nome, items, totals: roundNutrients(sumNutrients(items.map((i) => i.nutrients))), target: { kcal: target.kcal, protein: target.protein }, options };
}

const proteinSource = (t: MealTemplate) => t.comps.find((c) => c.role === 'proteina')?.id ?? '';

/** Quanto un pasto si allontana dal suo obiettivo (0 = perfetto); le proteine mancanti pesano di più. */
export function mealError(m: MenuMeal): number {
  const { kcal, protein } = m.target;
  return (
    Math.abs(m.totals.kcal - kcal) / Math.max(kcal, 1) +
    (1.5 * Math.max(0, protein - m.totals.protein)) / Math.max(protein, 1) +
    Math.max(0, m.totals.protein - protein * 1.3) / Math.max(protein, 1)
  );
}

/**
 * Il menu di un giorno: un pasto per quota, scelto in modo stabile per data (cambia con "altra proposta").
 * Si parte dai pasti piccoli; quello che manca o avanza passa a pranzo e cena, l'ultima chiude il conto.
 * Se la proposta di turno non riesce a centrare i numeri (es. legumi con proteine molto alte) si passa alla successiva.
 */
export function buildDayMenu(o: MenuOptions): DayMenu {
  const shares = mealShares(o.mealsPerDay);
  const isMain = (s: MealSlot) => s === 'pranzo' || s === 'cena';
  const order = [...shares.filter((s) => !isMain(s.slot)), ...shares.filter((s) => isMain(s.slot))];
  let mainLeft = shares.filter((s) => isMain(s.slot)).reduce((a, s) => a + s.share, 0);
  let kcalDebt = 0;
  let proteinDebt = 0;
  let fatDebt = 0;
  const day = dayNumber(o.date);
  const usedTemplates = new Set<string>();
  const meals: MenuMeal[] = [];
  const missing: MealSlot[] = [];
  const usedProtein = new Set<string>();

  for (const { slot, share } of order) {
    const all = compatibleTemplates(slot, o);
    if (all.length === 0) {
      missing.push(slot);
      continue;
    }
    const avoid = new Set(o.avoid?.[slot] ?? []);
    const fresh = all.filter((t) => !avoid.has(t.id));
    const list = fresh.length > 0 ? fresh : all;
    // senza un obiettivo dei grassi uso il 27% delle calorie (dentro il 20-35% delle linee guida ISSN)
    const fatDay = o.target.fat ?? (o.target.kcal * 0.27) / 9;
    const target: MealTarget = { kcal: o.target.kcal * share, protein: o.target.protein * share, fat: fatDay * share };
    if (isMain(slot) && mainLeft > 0) {
      const part = share / mainLeft;
      target.kcal += kcalDebt * part;
      target.protein += proteinDebt * part;
      target.fat = Math.max(0, (target.fat ?? 0) + fatDebt * part);
      kcalDebt -= kcalDebt * part;
      proteinDebt -= proteinDebt * part;
      fatDebt -= fatDebt * part;
      mainLeft -= share;
    }
    const salt = shares.findIndex((s) => s.slot === slot) * 3;
    const start = (day + salt) % list.length;
    let best: MenuMeal | undefined;
    let bestErr = Infinity;
    for (let k = 0; k < list.length; k++) {
      const t = list[(start + k) % list.length];
      // nella stessa giornata niente pasti ripetuti e, se si può, fonti di proteine diverse
      if (usedTemplates.has(t.id) && list.length > 1) continue;
      if (usedProtein.has(proteinSource(t)) && list.some((x) => !usedProtein.has(proteinSource(x)) && !usedTemplates.has(x.id))) continue;
      const meal = buildMeal(t, slot, target, o, salt, all.length);
      if (!meal) continue;
      const err = mealError(meal);
      if (err < bestErr) {
        best = meal;
        bestErr = err;
      }
      if (err <= 0.09) break;
    }
    if (!best) {
      missing.push(slot);
      continue;
    }
    usedTemplates.add(best.templateId);
    usedProtein.add(proteinSource(MEAL_TEMPLATES.find((t) => t.id === best!.templateId)!));
    kcalDebt += target.kcal - best.totals.kcal;
    proteinDebt += target.protein - best.totals.protein;
    fatDebt += (target.fat ?? 0) - best.totals.fat;
    meals.push(best);
  }
  meals.sort((a, b) => shares.findIndex((s) => s.slot === a.slot) - shares.findIndex((s) => s.slot === b.slot));
  return { meals, totals: roundNutrients(sumNutrients(meals.map((m) => m.totals))), missing };
}
