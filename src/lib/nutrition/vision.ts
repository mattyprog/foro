/**
 * Analisi di foto, etichette e testo con Gemini.
 *
 * La foto NON decide le calorie: Gemini individua alimenti, cottura, condimenti visibili e grammi con un
 * intervallo; le calorie le calcola il database (valori per 100 g x grammi). Se un alimento non c'e' nel
 * database si usa la stima per 100 g del modello, con fonte 'ai' e fiducia 'bassa'.
 * Nei piatti da ristorante l'olio non visibile vale 10-15 g e si chiede conferma con una domanda.
 */
import { z } from 'zod';
import type { FoodItem, Nutrients } from '@/db/types';
import { draftFromEstimate, draftFromFood, draftTotals, minConfidence, normalizeGrams, whyMatched } from './drafts';
import { loadAllFoods } from './foodDb';
import { blobToBase64, generateJson, GeminiError, type Cost, type GeminiOptions, type Part, type Usage } from './gemini';
import { compressImage } from './image';
import { atwaterKcal, checkAtwater, roundTo } from './nutrients';
import { FoodSearchIndex, matchToDb, normalizeText } from './search';
import { parseTextLocal } from './textParse';
import type { DraftItem } from './types';

export { GeminiError, DEFAULT_MODEL, computeCost } from './gemini';
export type { Cost, GeminiErrorKind, Usage } from './gemini';
export { rescaleDraft, replaceDraftFood, draftTotals } from './drafts';
export { parseTextLocal } from './textParse';

/* ------------------------------------------------------------ schemi */

const COOKING = ['crudo', 'bollito', 'al_vapore', 'alla_griglia', 'al_forno', 'in_padella', 'fritto', 'in_umido', 'non_applicabile'] as const;
const KINDS = ['piatto', 'alimento', 'condimento', 'bevanda'] as const;
const CONFIDENCE = ['alta', 'media', 'bassa'] as const;
const CONTEXTS = ['casa', 'ristorante', 'non_so'] as const;

const toNum = (v: unknown) => (typeof v === 'string' ? Number(v.replace(',', '.')) : v);
const num = z.preprocess(toNum, z.number().finite().min(0));
const optNum = z.preprocess((v) => (v === null || v === '' || v === undefined ? undefined : toNum(v)), z.number().finite().min(0).optional());
const optStr = z.preprocess((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined), z.string().optional());

const zItem = z.object({
  nome: z.string().min(1),
  tipo: z.enum(KINDS).catch('alimento'),
  cottura: z.enum(COOKING).catch('non_applicabile'),
  grammi: num,
  grammi_min: num,
  grammi_max: num,
  confidenza: z.enum(CONFIDENCE).catch('media'),
  kcal_100g: num,
  proteine_100g: num,
  carboidrati_100g: num,
  grassi_100g: num,
  ipotesi: optStr,
});

const zMeal = z.object({
  cibo_presente: z.boolean(),
  piatto: z.string().catch(''),
  contesto: z.enum(CONTEXTS).catch('non_so'),
  alimenti: z.array(zItem).max(25),
  olio: z.object({ rilevante: z.boolean(), grammi: optNum, motivo: optStr }),
  domande: z.array(z.string()).catch([]),
});
export type MealJson = z.infer<typeof zMeal>;

const S = { type: 'STRING' } as const;
const N = { type: 'NUMBER' } as const;
const B = { type: 'BOOLEAN' } as const;
const ITEM_PROPS = [
  'nome', 'tipo', 'cottura', 'grammi', 'grammi_min', 'grammi_max', 'confidenza',
  'kcal_100g', 'proteine_100g', 'carboidrati_100g', 'grassi_100g', 'ipotesi',
];

/** responseSchema di Gemini per foto e testo. */
export const MEAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cibo_presente: { ...B, description: "false se non c'è cibo" },
    piatto: { ...S, description: 'nome italiano del pasto nel suo insieme' },
    contesto: { ...S, enum: [...CONTEXTS] },
    alimenti: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          nome: { ...S, description: 'nome italiano generico, come in una tabella di composizione' },
          tipo: { ...S, enum: [...KINDS] },
          cottura: { ...S, enum: [...COOKING] },
          grammi: { ...N, description: 'peso stimato come servito, in grammi (o ml)' },
          grammi_min: N,
          grammi_max: N,
          confidenza: { ...S, enum: [...CONFIDENCE] },
          kcal_100g: { ...N, description: 'stima di riserva per 100 g come servito' },
          proteine_100g: N,
          carboidrati_100g: N,
          grassi_100g: N,
          ipotesi: { ...S, description: 'ipotesi brevi, es. olio non visibile' },
        },
        required: ITEM_PROPS.slice(0, 11),
        propertyOrdering: ITEM_PROPS,
      },
    },
    olio: {
      type: 'OBJECT',
      properties: { rilevante: B, grammi: N, motivo: S },
      required: ['rilevante', 'grammi', 'motivo'],
      propertyOrdering: ['rilevante', 'grammi', 'motivo'],
    },
    domande: { type: 'ARRAY', items: S },
  },
  required: ['cibo_presente', 'piatto', 'contesto', 'alimenti', 'olio', 'domande'],
  propertyOrdering: ['cibo_presente', 'piatto', 'contesto', 'alimenti', 'olio', 'domande'],
};

const LABEL_NUM_KEYS = ['kcal', 'kj', 'grassi', 'saturi', 'carboidrati', 'zuccheri', 'fibre', 'proteine', 'sale', 'porzione_g'] as const;
const zLabel = z.object({
  leggibile: z.boolean(),
  nome: z.string().catch(''),
  marca: optStr,
  unita: z.enum(['g', 'ml']).catch('g'),
  valori_per: z.enum(['100g', 'porzione']).catch('100g'),
  kcal: optNum,
  kj: optNum,
  grassi: optNum,
  saturi: optNum,
  carboidrati: optNum,
  zuccheri: optNum,
  fibre: optNum,
  proteine: optNum,
  sale: optNum,
  porzione_g: optNum,
  porzione_descrizione: optStr,
  problemi: optStr,
});
export type LabelJson = z.infer<typeof zLabel>;

const NN = { type: 'NUMBER', nullable: true } as const;
const LABEL_PROPS = ['leggibile', 'nome', 'marca', 'unita', 'valori_per', ...LABEL_NUM_KEYS, 'porzione_descrizione', 'problemi'];
export const LABEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    leggibile: B,
    nome: S,
    marca: { type: 'STRING', nullable: true },
    unita: { ...S, enum: ['g', 'ml'] },
    valori_per: { ...S, enum: ['100g', 'porzione'] },
    ...Object.fromEntries(LABEL_NUM_KEYS.map((k) => [k, NN])),
    porzione_descrizione: { type: 'STRING', nullable: true },
    problemi: { type: 'STRING', nullable: true },
  },
  required: LABEL_PROPS,
  propertyOrdering: LABEL_PROPS,
};

/* ------------------------------------------------------------ prompt */

export const PHOTO_SYSTEM = `Sei il modulo che riconosce i pasti in un'app italiana di nutrizione. Guardi la foto di un pasto e descrivi cosa c'è, con stime di peso oneste. Non devi calcolare le calorie del pasto: le calcola l'app con il suo database.

Regole:
1. Elenca gli alimenti visibili con nomi italiani generici, come in una tabella di composizione degli alimenti (es. "petto di pollo", "patate", "riso basmati", "mozzarella", "olio extravergine di oliva"), senza marche.
2. Piatti tipici italiani e romani (carbonara, amatriciana, cacio e pepe, gricia, lasagna, parmigiana, suppli, pizza margherita, pizza bianca, saltimbocca, pasta e ceci, tiramisu...): UN solo elemento di tipo "piatto" con il nome del piatto e il peso totale della porzione. Non scomporli negli ingredienti. Scomponi invece i piatti misti o non standard (es. pollo con patate e insalata: tre elementi).
3. "grammi" è il peso come servito: cotto, scolato, senza ossa, gusci e scarti. Dai un intervallo realistico grammi_min - grammi_max: le stime da foto sbagliano facilmente del 20-30%. Per la scala usa riferimenti visivi: piatto piano circa 26-27 cm, piatto fondo circa 22 cm, forchetta circa 20 cm, bicchiere, mano.
4. "cottura": quella visibile o tipica. "crudo" per verdure crude, frutta, salumi crudi, pesce crudo; "non_applicabile" per pane, formaggi, dolci, bevande e piatti in cui non serve.
5. Condimenti: come elementi separati di tipo "condimento" solo quelli visibili e quantificabili (maionese, panna, formaggio grattugiato sopra, salse). Nel campo "olio" indica se c'è probabilmente olio aggiunto ma non misurabile (verdure ripassate o grigliate, insalate condite, carne e pesce in padella o ai ferri, patate al forno, fritture): rilevante=true e i grammi stimati per tutto il pasto. Al ristorante l'olio è di solito 10-15 g a porzione. Per i piatti tipici di tipo "piatto" l'olio della ricetta è già compreso: rilevante=false salvo un condimento extra evidente.
6. kcal_100g, proteine_100g, carboidrati_100g, grassi_100g: tua stima di riserva per 100 g dell'alimento come servito; l'app la usa solo se l'alimento non è nel database.
7. "confidenza": alta se alimento e quantità sono chiari, media se c'è qualche dubbio, bassa se è nascosto o ambiguo.
8. "contesto": "ristorante" se la foto sembra di un locale (impiattamento da ristorante, vassoio del bar, pizzeria), "casa" se sembra casalinga, altrimenti "non_so".
9. "domande": al massimo 2 domande brevi in italiano, solo se la risposta cambia molto le calorie (es. "La pasta era integrale?", "Il condimento era burro o olio?"). Non fare domande sull'olio: le fa già l'app.
10. Se nella foto non c'è cibo: cibo_presente=false e alimenti vuoto.
Rispondi solo con il JSON richiesto.`;

export const TEXT_SYSTEM = `Sei il modulo di un'app italiana di nutrizione che trasforma la descrizione a parole di un pasto in un elenco di alimenti con i grammi. Non calcolare le calorie del pasto: le calcola l'app con il suo database.

Regole:
1. Un elemento per ogni alimento o piatto citato, con nomi italiani generici come in una tabella di composizione degli alimenti. I piatti tipici italiani sono un solo elemento di tipo "piatto".
2. Se l'utente scrive i grammi, usali esattamente (grammi_min = grammi_max = grammi) e confidenza alta. Se scrive pezzi o porzioni ("un uovo", "una fetta di pane", "un piatto di pasta", "una birra media"), usa pesi tipici italiani con un intervallo.
3. Pasta, riso, cereali e legumi: grammi scritti senza dire "cotto" sono a crudo (cottura "crudo"); "un piatto di..." è il peso cotto.
4. "cottura": quella detta o tipica; "non_applicabile" se non serve.
5. "olio": rilevante=true se cita cibi di solito conditi (insalata, verdure ripassate, carne in padella) senza dire quanto condimento; grammi stimati per tutto il pasto.
6. kcal_100g, proteine_100g, carboidrati_100g, grassi_100g: stima di riserva per 100 g, usata solo se l'alimento non è nel database.
7. "contesto": "ristorante" se dice di aver mangiato fuori, "casa" se a casa, altrimenti "non_so".
8. "domande": al massimo 2, solo se servono davvero. Niente domande sull'olio.
9. Se il testo non descrive cibo: cibo_presente=false e alimenti vuoto.
Rispondi solo con il JSON richiesto.`;

export const LABEL_SYSTEM = `Leggi la tabella nutrizionale di un prodotto confezionato venduto in Italia (Regolamento UE 1169/2011).
Regole:
1. Trascrivi ESATTAMENTE i numeri stampati, senza stimare e senza arrotondare. Se un valore non è leggibile o non c'è, metti null.
2. Usa la colonna per 100 g (o 100 ml): valori_per="100g". Solo se manca, usa quella per porzione: valori_per="porzione" e porzione_g con il peso della porzione.
3. Se c'è un peso o una descrizione della porzione (es. "porzione 30 g", "1 vasetto 125 g"), mettili in porzione_g e porzione_descrizione.
4. unita: "ml" se i valori sono per 100 ml (bevande), altrimenti "g".
5. nome: il nome del prodotto se si vede, altrimenti una descrizione breve del tipo di prodotto. marca separata, null se non si vede.
6. leggibile=false se nella foto non c'è una tabella nutrizionale leggibile. In "problemi" segnala dubbi (riflessi, numeri tagliati, colonne confuse).
Rispondi solo con il JSON richiesto.`;

/* ------------------------------------------------------------ tipi pubblici */

export interface ClarifyingQuestion {
  id: string;
  text: string;
  /** Risposte pronte (es. quantita' di olio): il tocco imposta i grammi della voce itemIndex. */
  options?: { label: string; grams: number }[];
  itemIndex?: number;
}

export interface MealAnalysis {
  dishName: string;
  context: (typeof CONTEXTS)[number];
  notFood: boolean;
  items: DraftItem[];
  questions: ClarifyingQuestion[];
  totals: Nutrients & { kcalRange: [number, number] };
  usage: Usage;
  cost: Cost;
  model: string;
}

export interface AnalyzeOptions extends GeminiOptions {
  /** Indice di ricerca (default: database base + piatti + userFoods). */
  index?: FoodSearchIndex;
  userFoods?: FoodItem[];
  /** Nota dell'utente da passare al modello (es. "pasta integrale", "ero al ristorante"). */
  note?: string;
  /** false per inviare la foto cosi' com'e'; una funzione per una compressione diversa. */
  compress?: boolean | ((b: Blob) => Promise<Blob>);
}

export interface LabelAnalysis {
  food: FoodItem;
  warnings: string[];
  usage: Usage;
  cost: Cost;
  model: string;
}

export interface TextAnalysis {
  items: DraftItem[];
  /** Pezzi della frase che non hanno trovato un alimento. */
  unmatched: string[];
  questions: ClarifyingQuestion[];
  totals: Nutrients & { kcalRange: [number, number] };
  usedModel: boolean;
  usage?: Usage;
  cost?: Cost;
}

/* ------------------------------------------------------------ indice di default */

let baseIndex: Promise<FoodSearchIndex> | undefined;
async function indexFor(opts: { index?: FoodSearchIndex; userFoods?: FoodItem[] }): Promise<FoodSearchIndex> {
  if (opts.index) return opts.index;
  if (opts.userFoods?.length) return new FoodSearchIndex(await loadAllFoods(opts.userFoods));
  baseIndex ??= loadAllFoods().then((all) => new FoodSearchIndex(all));
  return baseIndex;
}

/* ------------------------------------------------------------ dalla risposta del modello alle bozze */

/** Il modello scrive spesso il piatto in minuscolo ("carbonara"): nel titolo serve la maiuscola. */
const sentenceCase = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('it-IT') + s.slice(1) : s);

const OIL_ID = 'olio-extravergine-di-oliva';
const OIL_DEFAULT: Record<MealJson['contesto'], { grams: number; range: [number, number]; why: string }> = {
  ristorante: { grams: 12, range: [10, 15], why: 'al ristorante di solito 10-15 g a porzione' },
  casa: { grams: 8, range: [5, 10], why: 'a casa di solito 5-10 g' },
  non_so: { grams: 10, range: [5, 15], why: 'di solito 5-15 g' },
};
export const OIL_OPTIONS = [
  { label: 'Niente olio', grams: 0 },
  { label: 'Un filo (5 g)', grams: 5 },
  { label: '1 cucchiaio (10 g)', grams: 10 },
  { label: 'Abbondante (15 g)', grams: 15 },
  { label: 'Molto (20 g)', grams: 20 },
];

function stateOf(cooking: MealJson['alimenti'][number]['cottura']): 'crudo' | 'cotto' | undefined {
  if (cooking === 'crudo') return 'crudo';
  if (cooking === 'non_applicabile') return undefined;
  return 'cotto';
}

function draftFromModel(it: MealJson['alimenti'][number], index: FoodSearchIndex): DraftItem {
  const { grams, range } = normalizeGrams(it.grammi, it.grammi_min, it.grammi_max, it.grammi_min === it.grammi_max ? 0 : 0.1);
  const m = matchToDb(index, { name: it.nome, cooking: it.cottura, state: stateOf(it.cottura), kind: it.tipo });
  if (m) {
    return draftFromFood(m.food, grams, range, {
      inputName: it.nome,
      kind: it.tipo,
      confidence: minConfidence(it.confidenza, m.confidence),
      why: whyMatched(it.nome, m, it.ipotesi),
      alternatives: m.alternatives,
      cooking: it.cottura,
    });
  }
  return draftFromEstimate(
    it.nome,
    { kcal: it.kcal_100g, protein: it.proteine_100g, carbs: it.carboidrati_100g, fat: it.grassi_100g },
    grams,
    range,
    {
      inputName: it.nome,
      kind: it.tipo,
      why: `"${it.nome}" non è nel database: valori per 100 g stimati dal modello, controllali.${it.ipotesi ? ` ${it.ipotesi}` : ''}`,
      cooking: it.cottura,
    },
  );
}

/** Trasforma la risposta validata del modello in bozze abbinate al database, con olio e domande. */
export function buildMealAnalysis(raw: MealJson, index: FoodSearchIndex): Pick<MealAnalysis, 'dishName' | 'context' | 'notFood' | 'items' | 'questions' | 'totals'> {
  const context = raw.contesto;
  if (!raw.cibo_presente || raw.alimenti.length === 0) {
    return { dishName: sentenceCase(raw.piatto), context, notFood: true, items: [], questions: [], totals: draftTotals([]) };
  }
  const items = raw.alimenti.map((it) => draftFromModel(it, index));
  const questions: ClarifyingQuestion[] = raw.domande
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((text, i) => ({ id: `domanda-${i + 1}`, text }));

  const hasOil = items.some((d) => d.kind === 'condimento' && /\bolio\b/.test(normalizeText(`${d.inputName} ${d.name}`)));
  const onlyRecipes = items.every((d) => d.source === 'ricetta');
  const oil = index.get(OIL_ID);
  if (raw.olio.rilevante && !hasOil && !onlyRecipes && oil) {
    const def = OIL_DEFAULT[context];
    const g = Math.min(def.range[1], Math.max(def.range[0], raw.olio.grammi ?? def.grams));
    items.push(
      draftFromFood(oil, g, def.range, {
        inputName: 'olio non visibile',
        kind: 'condimento',
        confidence: 'bassa',
        why: `Olio probabile ma non misurabile dalla foto${raw.olio.motivo ? ` (${raw.olio.motivo.replace(/\.$/, '')})` : ''}: ${def.why}. Correggilo con la domanda.`,
      }),
    );
    questions.unshift({ id: 'olio', text: "Quanto olio c'era in tutto?", options: OIL_OPTIONS, itemIndex: items.length - 1 });
  }
  return { dishName: sentenceCase(raw.piatto), context, notFood: false, items, questions, totals: draftTotals(items) };
}

/* ------------------------------------------------------------ API pubblica */

/** Analizza la foto di un pasto: bozze del diario con grammi, intervalli, domande e costo della chiamata. */
export async function analyzePhoto(photo: Blob, opts: AnalyzeOptions): Promise<MealAnalysis> {
  const index = await indexFor(opts);
  let jpeg = photo;
  if (opts.compress !== false) jpeg = typeof opts.compress === 'function' ? await opts.compress(photo) : (await compressImage(photo)).blob;
  const parts: Part[] = [
    { inlineData: { mimeType: jpeg.type || 'image/jpeg', data: await blobToBase64(jpeg) } },
    { text: `Analizza il pasto nella foto.${opts.note ? ` Nota dell'utente: ${opts.note.slice(0, 300)}` : ''}` },
  ];
  const r = await generateJson({ system: PHOTO_SYSTEM, parts, schema: MEAL_SCHEMA, thinking: 'low' }, zMeal, opts);
  return { ...buildMealAnalysis(r.data, index), usage: r.usage, cost: r.cost, model: r.model };
}

/**
 * Trasforma una frase in bozze. Prima prova la lettura locale (gratis); usa Gemini solo se qualcosa non torna
 * e se c'e' la chiave (o con forceModel).
 */
export async function parseText(text: string, opts: Partial<AnalyzeOptions> & { forceModel?: boolean } = {}): Promise<TextAnalysis> {
  const index = await indexFor(opts);
  const local = parseTextLocal(text, index);
  const localOk = local.items.length > 0 && local.unmatched.length === 0 && local.items.every((i) => i.confidence !== 'bassa');
  if ((!opts.forceModel && localOk) || !opts.apiKey) {
    return { ...local, questions: [], totals: draftTotals(local.items), usedModel: false };
  }
  const r = await generateJson(
    { system: TEXT_SYSTEM, parts: [{ text: `Pasto descritto dall'utente: ${text.slice(0, 1000)}` }], schema: MEAL_SCHEMA, thinking: 'low' },
    zMeal,
    opts as GeminiOptions,
  );
  const a = buildMealAnalysis(r.data, index);
  return { items: a.items, unmatched: [], questions: a.questions, totals: a.totals, usedModel: true, usage: r.usage, cost: r.cost };
}

function slug(s: string): string {
  return normalizeText(s).replace(/\s+/g, '-').slice(0, 40) || 'prodotto';
}

function shortId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

/** Converte la lettura dell'etichetta in un FoodItem dell'utente (valori per 100 g). */
export function labelToFood(raw: LabelJson): { food: FoodItem; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw.leggibile) {
    throw new GeminiError('etichetta-illeggibile', "Non riesco a leggere l'etichetta: rifai la foto più da vicino, dritta e senza riflessi.");
  }
  let factor = 1;
  if (raw.valori_per === 'porzione') {
    if (!raw.porzione_g) {
      throw new GeminiError('etichetta-illeggibile', "L'etichetta mostra solo i valori per porzione ma non il peso della porzione: fotografa la colonna per 100 g.");
    }
    factor = 100 / raw.porzione_g;
    warnings.push(`Valori calcolati per 100 g dalla porzione da ${raw.porzione_g} g.`);
  }
  const missing = (['proteine', 'carboidrati', 'grassi'] as const).filter((k) => raw[k] === undefined);
  if (missing.length) {
    throw new GeminiError('etichetta-illeggibile', `Sull'etichetta non leggo ${missing.join(', ')}: rifai la foto inquadrando tutta la tabella.`);
  }
  const p = raw.proteine! * factor;
  const c = raw.carboidrati! * factor;
  const f = raw.grassi! * factor;
  let kcal = raw.kcal !== undefined ? raw.kcal * factor : undefined;
  if (kcal === undefined && raw.kj !== undefined) {
    kcal = (raw.kj * factor) / 4.184;
    warnings.push('Calorie calcolate dai kJ.');
  }
  const fiber = raw.fibre !== undefined ? raw.fibre * factor : undefined;
  if (kcal === undefined) {
    kcal = atwaterKcal({ kcal: 0, protein: p, carbs: c, fat: f, fiber });
    warnings.push('Calorie non leggibili: calcolate dai macronutrienti.');
  }
  const per100g: Nutrients = { kcal: roundTo(kcal, 0), protein: roundTo(p, 1), carbs: roundTo(c, 1), fat: roundTo(f, 1) };
  const opt: [keyof Nutrients, number | undefined][] = [
    ['fiber', fiber],
    ['sugars', raw.zuccheri],
    ['satFat', raw.saturi],
    ['salt', raw.sale],
  ];
  for (const [k, v] of opt) if (v !== undefined) per100g[k] = roundTo(k === 'fiber' ? v : v * factor, k === 'salt' ? 2 : 1);
  if (per100g.kcal > 900 || per100g.protein + per100g.carbs + per100g.fat > 101) {
    throw new GeminiError('etichetta-illeggibile', "I valori letti non sono possibili: rifai la foto dell'etichetta.");
  }
  if (!checkAtwater(per100g, { tolerance: 0.15, minAbsKcal: 5 }).ok) {
    warnings.push('Le calorie non tornano con i macronutrienti: controlla i valori prima di salvare.');
  }
  if (raw.problemi) warnings.push(`Lettura incerta: ${raw.problemi}`);
  const name = raw.nome.trim() || 'Prodotto da etichetta';
  const portions: FoodItem['portions'] = [];
  if (raw.porzione_g) {
    const desc = raw.porzione_descrizione ? raw.porzione_descrizione.replace(/\s*\(?\d+([.,]\d+)?\s*(g|ml)\)?\s*$/i, '').trim() : '';
    portions.push({ label: `${desc || '1 porzione'} (${String(raw.porzione_g).replace('.', ',')} ${raw.unita})`, grams: raw.porzione_g });
  }
  portions.push({ label: `100 ${raw.unita}`, grams: 100 });
  const food: FoodItem = {
    id: `utente:${slug(name)}-${shortId()}`,
    name,
    category: 'Prodotti confezionati',
    per100g,
    source: 'utente',
    sourceRef: 'etichetta fotografata',
    portions,
    ...(raw.marca ? { brand: raw.marca } : {}),
  };
  return { food, warnings };
}

/** Legge l'etichetta nutrizionale di un prodotto: FoodItem con fonte 'utente' e valori per 100 g. */
export async function analyzeLabel(photo: Blob, opts: Omit<AnalyzeOptions, 'index' | 'userFoods' | 'note'>): Promise<LabelAnalysis> {
  let jpeg = photo;
  if (opts.compress !== false) {
    // le etichette hanno caratteri piccoli: lato lungo 1536 px
    jpeg = typeof opts.compress === 'function' ? await opts.compress(photo) : (await compressImage(photo, 1536, 0.9)).blob;
  }
  const parts: Part[] = [
    { inlineData: { mimeType: jpeg.type || 'image/jpeg', data: await blobToBase64(jpeg) } },
    { text: "Leggi la tabella nutrizionale nell'immagine." },
  ];
  const r = await generateJson({ system: LABEL_SYSTEM, parts, schema: LABEL_SCHEMA, thinking: 'low' }, zLabel, opts);
  const { food, warnings } = labelToFood(r.data);
  return { food, warnings, usage: r.usage, cost: r.cost, model: r.model };
}
