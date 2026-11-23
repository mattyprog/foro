/**
 * Ricerca fuzzy in italiano su database base + piatti + alimenti dell'utente.
 *
 * - normalizzazione: minuscole, niente accenti e apostrofi, parole vuote scartate;
 * - radici leggere per singolare e plurale (pomodoro/pomodori, uovo/uova, fungo/funghi);
 * - sinonimi dei metodi di cottura (griglia = piastra = ai ferri, bollito = lessato, arrosto = al forno);
 * - l'ordine delle parole non conta ("pollo petto" = "petto di pollo");
 * - tolleranza agli errori di battitura (distanza di Damerau-Levenshtein 1-2);
 * - indice invertito costruito una volta: una query su ~1000 voci richiede frazioni di millisecondo.
 */
import type { Confidence, FoodItem, FoodSource } from '@/db/types';

const STOPWORDS = new Set([
  'di', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'd', 'da', 'dal', 'dalla', 'dallo', 'dai', 'dalle',
  'con', 'col', 'al', 'alla', 'allo', 'ai', 'agli', 'alle', 'all', 'e', 'ed', 'in', 'a', 'il', 'lo', 'la',
  'i', 'gli', 'le', 'l', 'un', 'uno', 'una', 'per', 'su', 'sul', 'sulla', 'o', 'od', 'tipo', 'media', 'q', 'b',
  // descrittori che non cambiano i valori nutrizionali
  'grattugiato', 'grattugiata', 'grattugiati', 'grattugiate', 'grattato', 'grattata', 'scaglie',
]);

/** Sinonimi dei metodi di cottura ricondotti a una parola sola. */
const CANON: Record<string, string> = {
  griglia: 'ferri', grigliato: 'ferri', grigliata: 'ferri', grigliati: 'ferri', grigliate: 'ferri',
  piastra: 'ferri', brace: 'ferri', bbq: 'ferri',
  bollito: 'lessato', bollita: 'lessato', bolliti: 'lessato', bollite: 'lessato',
  lesso: 'lessato', lessa: 'lessato', lessi: 'lessato', lesse: 'lessato',
  arrosto: 'forno', arrostito: 'forno', arrostita: 'forno', arrostiti: 'forno', arrostite: 'forno',
  infornato: 'forno', gratinato: 'forno', gratinati: 'forno',
  saltato: 'padella', saltata: 'padella', saltati: 'padella', saltate: 'padella',
  stufato: 'umido', stufata: 'umido', stufati: 'umido', stufate: 'umido',
  vapore: 'vapore', fritti: 'fritto', fritta: 'fritto', fritte: 'fritto', frittura: 'fritto',
};

const COOKED_STEMS = new Set([
  'cott', 'lessat', 'ferr', 'forn', 'padell', 'fritt', 'vapor', 'brasat', 'umid', 'tostat', 'ripassat',
  'sod', 'coqu', 'strapazzat', 'tegamin', 'scatol', 'pront', 'caldarrost',
]);
const RAW_STEMS = new Set(['crud', 'secc']);

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Radice leggera per singolare e plurale italiani: toglie la vocale finale (o "-io": finocchio/finocchi,
 * formaggio/formaggi) e uniforma -chi/-ghi e -ci/-gi (funghi/fungo, arance/arancia).
 */
export function stem(token: string): string {
  let s = normalizeText(token);
  if (s.length <= 3 || /\d/.test(s)) return s;
  if (s.length > 4 && s.endsWith('io')) s = s.slice(0, -2);
  else if (/[aeio]$/.test(s)) s = s.slice(0, -1);
  if (/[cg]h$/.test(s)) s = s.slice(0, -1);
  else if (s.length > 4 && /[cg]i$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** Parole significative (normalizzate, sinonimi applicati, senza parole vuote). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of normalizeText(s).split(' ')) {
    if (!t || STOPWORDS.has(t)) continue;
    out.push(CANON[t] ?? t);
  }
  return out;
}

function isMarker(st: string): boolean {
  return COOKED_STEMS.has(st) || RAW_STEMS.has(st);
}

/** Radici che dicono quale cibo è: senza cottura, crudo/cotto e parole vuote. */
function foodStems(text: string): string[] {
  return tokenize(text)
    .map(stem)
    .filter((t) => t.length > 0 && !isMarker(t));
}

/** Distanza di Damerau-Levenshtein (con trasposizioni), interrotta appena supera max. */
function damerau(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = new Int32Array(lb + 1);
  let prev = new Int32Array(lb + 1);
  let cur = new Int32Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

interface NameEntry {
  text: string;
  surface: string[];
  stems: string[];
  /** Numero di parole che non sono marcatori crudo/cotto (per la copertura). */
  content: number;
  isMain: boolean;
}

interface Entry {
  item: FoodItem;
  names: NameEntry[];
  cooked: boolean;
  raw: boolean;
}

export interface SearchOptions {
  limit?: number;
  sources?: FoodSource[];
  categories?: string[];
  /** Preferenza crudo/cotto quando la query non la dice: 'cotto' per le foto, 'crudo' per chi pesa a crudo. */
  prefer?: 'crudo' | 'cotto';
  /** Bonus personalizzato (es. alimenti usati di recente), di solito tra 0 e 0,2. */
  boost?: (item: FoodItem) => number;
  /** Punteggio minimo (default 0,3). */
  minScore?: number;
}

export interface SearchResult {
  item: FoodItem;
  /** Punteggio per l'ordinamento (testo + preferenze crudo/cotto, alimenti dell'utente, boost). */
  score: number;
  /** Solo la somiglianza del testo: e' questo che decide se un abbinamento e' affidabile. */
  base: number;
  /** Nome o alias che ha prodotto il punteggio migliore. */
  matched: string;
}

type Hit = Map<number, number>; // chiave entry*64+nome -> peso migliore per un token della query

const W_EXACT = 1;
const W_STEM = 0.9;
const W_MARKER = 0.8;

export class FoodSearchIndex {
  private entries: Entry[] = [];
  private bySurface = new Map<string, number[]>();
  private byStem = new Map<string, number[]>();
  private vocab: string[] = [];
  private vocabByFirst = new Map<string, string[]>();
  private byId = new Map<string, FoodItem>();

  constructor(items: FoodItem[] = []) {
    this.update(items);
  }

  get size(): number {
    return this.entries.length;
  }

  get(id: string): FoodItem | undefined {
    return this.byId.get(id);
  }

  /** Ricostruisce l'indice (pochi millisecondi per ~1000 voci). A parita' di id vince la prima voce. */
  update(items: FoodItem[]): void {
    this.entries = [];
    this.bySurface.clear();
    this.byStem.clear();
    this.byId.clear();
    const vocab = new Set<string>();
    for (const item of items) {
      if (this.byId.has(item.id)) continue;
      this.byId.set(item.id, item);
      const texts = [item.name, ...(item.aliases ?? [])];
      if (item.brand) texts.push(`${item.brand} ${item.name}`, item.brand);
      const names: NameEntry[] = [];
      let cooked = item.source === 'ricetta';
      let raw = false;
      texts.slice(0, 63).forEach((text, i) => {
        const surface = tokenize(text);
        if (surface.length === 0) return;
        const stems = surface.map(stem);
        if (i === 0) {
          cooked ||= stems.some((s) => COOKED_STEMS.has(s));
          raw = stems.some((s) => RAW_STEMS.has(s));
        }
        names.push({ text: surface.join(' '), surface, stems, content: stems.filter((s) => !isMarker(s)).length, isMain: i === 0 });
      });
      if (names.length === 0) continue;
      const e = this.entries.length;
      this.entries.push({ item, names, cooked: cooked && !raw, raw });
      names.forEach((n, ni) => {
        const key = e * 64 + ni;
        n.surface.forEach((t, ti) => {
          vocab.add(t);
          pushTo(this.bySurface, t, key);
          pushTo(this.byStem, n.stems[ti], key);
        });
      });
    }
    this.vocab = [...vocab].sort();
    this.vocabByFirst.clear();
    for (const t of this.vocab) pushTo(this.vocabByFirst, t[0], t);
  }

  /** Pesi migliori per un token della query su tutte le coppie (voce, nome). */
  private matchToken(q: string): Hit {
    const hit: Hit = new Map();
    const set = (keys: number[] | undefined, w: number) => {
      if (!keys) return;
      for (const k of keys) if ((hit.get(k) ?? 0) < w) hit.set(k, w);
    };
    set(this.bySurface.get(q), W_EXACT);
    const qs = stem(q);
    set(this.byStem.get(qs), W_STEM);
    // "cotto" o "crudo" generici: valgono per qualsiasi marcatore dello stesso tipo
    if (qs === 'cott' || qs === 'crud') {
      const group = qs === 'cott' ? COOKED_STEMS : RAW_STEMS;
      for (const st of group) set(this.byStem.get(st), W_MARKER);
    }
    // prefissi (ricerca mentre si scrive)
    if (q.length >= 2) {
      let lo = 0;
      let hi = this.vocab.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.vocab[mid] < q) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.vocab.length && this.vocab[i].startsWith(q); i++) {
        const t = this.vocab[i];
        if (t !== q) set(this.bySurface.get(t), 0.55 + 0.35 * (q.length / t.length));
      }
    }
    // errori di battitura
    if (q.length >= 4 && !/\d/.test(q)) {
      const max = q.length >= 8 ? 2 : 1;
      for (const t of this.vocabByFirst.get(q[0]) ?? []) {
        if (t === q || Math.abs(t.length - q.length) > max) continue;
        const d = damerau(q, t, max);
        if (d <= max) set(this.bySurface.get(t), d === 1 ? 0.7 : 0.6);
      }
    }
    return hit;
  }

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const qText = qTokens.join(' ');
    const qStems = qTokens.map(stem);
    const explicitCooked = qStems.some((s) => COOKED_STEMS.has(s));
    const explicitRaw = qStems.some((s) => RAW_STEMS.has(s));
    const hits = qTokens.map((t) => this.matchToken(t));
    // le parole che il database non conosce (es. "grattugiato") pesano la meta'
    const nQ = qTokens.length;
    const nEff = hits.reduce((acc, h) => acc + (h.size > 0 ? 1 : 0.5), 0);

    // somma dei pesi per (voce, nome) e conteggio delle parole del nome coperte
    const agg = new Map<number, { sum: number; matched: number; first: boolean }>();
    hits.forEach((hit, qi) => {
      for (const [key, w] of hit) {
        const a = agg.get(key) ?? { sum: 0, matched: 0, first: false };
        a.sum += w;
        a.matched += 1;
        if (qi === 0) a.first = true;
        agg.set(key, a);
      }
    });

    const best = new Map<number, { score: number; name: NameEntry }>();
    for (const [key, a] of agg) {
      const e = key >> 6;
      const ni = key & 63;
      const entry = this.entries[e];
      const name = entry.names[ni];
      if (a.matched / nEff < 0.5) continue;
      const avg = a.sum / nEff;
      const contentMatched = Math.min(name.content, a.matched - countMarkers(qStems));
      const coverage = name.content > 0 ? Math.max(0, contentMatched) / name.content : 1;
      let s = avg * (0.75 + 0.25 * Math.min(1, coverage));
      if (name.text === qText) s += 0.3;
      else if (stripMarkers(name.text) === stripMarkers(qText)) s += 0.15;
      if (a.first && name.surface[0] === qTokens[0]) s += 0.05;
      if (!name.isMain) s *= 0.97;
      s -= 0.015 * Math.max(0, name.content - nQ);
      const prev = best.get(e);
      if (!prev || s > prev.score) best.set(e, { score: s, name });
    }

    const out: SearchResult[] = [];
    const minScore = opts.minScore ?? 0.3;
    for (const [e, { score, name }] of best) {
      const entry = this.entries[e];
      const item = entry.item;
      if (opts.sources && !opts.sources.includes(item.source)) continue;
      if (opts.categories && !opts.categories.includes(item.category)) continue;
      let s = score;
      const prefer = explicitCooked ? 'cotto' : explicitRaw ? 'crudo' : opts.prefer;
      if (prefer === 'cotto') s += entry.cooked ? 0.3 : entry.raw ? -0.3 : 0;
      if (prefer === 'crudo') s += entry.raw ? 0.3 : entry.cooked ? -0.3 : 0;
      if (item.source === 'utente') s += 0.05;
      if (opts.boost) s += opts.boost(item);
      if (s < minScore) continue;
      out.push({ item, score: s, base: score, matched: name.text });
    }
    out.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length || a.item.name.localeCompare(b.item.name));
    return out.slice(0, opts.limit ?? 20);
  }
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) {
    if (arr[arr.length - 1] !== v) arr.push(v);
  } else m.set(k, [v]);
}

function countMarkers(stems: string[]): number {
  return stems.filter(isMarker).length;
}

function stripMarkers(text: string): string {
  return text
    .split(' ')
    .filter((t) => !isMarker(stem(t)))
    .join(' ');
}

/* ------------------------------------------------------------ abbinamento */

export interface MatchQuery {
  /** Nome restituito dal modello o scritto dall'utente (es. "petto di pollo"). */
  name: string;
  /** Metodo di cottura (valori dello schema di Gemini: bollito, alla_griglia, al_forno...). */
  cooking?: string;
  /** Stato dell'alimento nel piatto. */
  state?: 'crudo' | 'cotto' | 'non_applicabile';
  kind?: 'piatto' | 'alimento' | 'condimento' | 'bevanda';
}

export interface MatchResult {
  food: FoodItem;
  score: number;
  confidence: Confidence;
  alternatives: FoodItem[];
}

const COOKING_TOKEN: Record<string, string> = {
  bollito: 'lessato', al_vapore: 'vapore', alla_griglia: 'ferri', al_forno: 'forno', in_padella: 'padella',
  fritto: 'fritto', in_umido: 'umido', arrosto: 'forno',
};

/** Soglia sotto la quale l'abbinamento non e' affidabile e si usa la stima del modello. */
export const MATCH_THRESHOLD = 0.6;

/**
 * Abbina un alimento riconosciuto (foto, etichetta, testo) a una voce del database.
 * Considera la cottura (le foto mostrano cibi cotti) e, per i piatti composti, preferisce le ricette.
 */
export function matchToDb(index: FoodSearchIndex, q: MatchQuery, opts: { limit?: number } = {}): MatchResult | null {
  const prefer: SearchOptions['prefer'] =
    q.state === 'crudo'
      ? 'crudo'
      : q.state === 'cotto' || (q.cooking && q.cooking !== 'nessuna') || q.kind === 'piatto'
        ? 'cotto'
        : undefined;
  const boost = (item: FoodItem) =>
    q.kind === 'piatto' ? (item.source === 'ricetta' ? 0.1 : item.category === 'Piatti pronti' ? 0.05 : 0) : 0;
  const limit = opts.limit ?? 6;
  const merged = new Map<string, SearchResult>();
  const add = (res: SearchResult[]) => {
    for (const r of res) {
      const prev = merged.get(r.item.id);
      if (!prev || r.score > prev.score) merged.set(r.item.id, r);
    }
  };
  add(index.search(q.name, { prefer, boost, limit: 12 }));
  const tok = q.cooking ? COOKING_TOKEN[q.cooking] : undefined;
  if (tok && !tokenize(q.name).includes(tok)) add(index.search(`${q.name} ${tok}`, { prefer, boost, limit: 12 }));
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  // l'affidabilita' si giudica sulla somiglianza del testo, non sui bonus di preferenza
  if (!top || top.base < MATCH_THRESHOLD) return null;
  const confidence: Confidence = top.base >= 1 ? 'alta' : top.base >= 0.75 ? 'media' : 'bassa';
  // alternative dello stesso cibo: la ricerca con la cottura ("carbonara padella") porta anche
  // verdure ripassate in padella, che con il piatto non c'entrano
  const wanted = new Set([...foodStems(q.name), ...foodStems(top.item.name)]);
  const related = (r: SearchResult) => r === top || [r.item.name, r.matched].some((n) => foodStems(n).some((t) => wanted.has(t)));
  return { food: top.item, score: top.score, confidence, alternatives: ranked.filter(related).slice(0, limit).map((r) => r.item) };
}
