/**
 * Lettura locale di frasi come "200 g di pollo e 80 g di riso", "2 uova e una fetta di pane",
 * "un piatto di carbonara e una birra media", "mezzo litro di latte", "un etto di prosciutto".
 * Gratis e istantanea: Gemini serve solo per le frasi che qui non si capiscono.
 */
import type { FoodItem } from '@/db/types';
import { draftFromFood, kindOf, minConfidence, normalizeGrams } from './drafts';
import { matchToDb, stem, type FoodSearchIndex } from './search';
import type { DraftItem } from './types';

const NUM_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, mezzo: 0.5, mezza: 0.5, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7,
  otto: 8, nove: 9, dieci: 10, paio: 2,
};
const UNIT_FACTOR: Record<string, number> = {
  g: 1, gr: 1, grammo: 1, grammi: 1, kg: 1000, chilo: 1000, chili: 1000, hg: 100, etto: 100, etti: 100,
  ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000, litro: 1000, litri: 1000,
};
/** Unita' di misura domestiche: si cercano tra le porzioni dell'alimento, altrimenti valori tipici. */
const NOUN_DEFAULT: Record<string, number> = {
  fett: 30, cucchia: 10, cucchiain: 5, tazz: 200, tazzin: 30, bicchier: 200, piatt: 300, porzion: 100, vasett: 125,
  scatolett: 80, misurin: 30, bottigli: 500, lattin: 330, pezz: 50, bustin: 5, manciat: 30, fil: 5, spicch: 5,
};
const NOUN_RE = /^(fett[ae]|cucchiai[oe]?|cucchiain[oi]|tazz[ae]|tazzin[ae]|bicchier[ei]|piatt[oi]|porzion[ei]|vasett[oi]|scatolett[ae]|misurin[oi]|bottigli[ae]|lattin[ae]|pezz[oi]|bustin[ae]|manciat[ae]|filo|spicchi[o]?)\s+(?:di\s+|d\s+)?(.+)$/;

const NUM_KEYS = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|');
const QTY = `\\d+(?:\\.\\d+)?|${NUM_KEYS}`;
const UNITS = Object.keys(UNIT_FACTOR).sort((a, b) => b.length - a.length).join('|');
const LEAD_RE = new RegExp(`^(?:un\\s+)?(${QTY})\\s*(${UNITS})?(?:\\s+|$)(?:di\\s+|d\\s+)?(.*)$`);
const TRAIL_RE = new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNITS})$`);
/** Inizio di una quantita': una cifra, oppure una parola-numero seguita da spazio o fine frase. */
const QTY_START_RE = new RegExp(`^(?:\\d|(?:${NUM_KEYS})(?:\\s|$))`);

/** Normalizzazione per il parser: come quella della ricerca ma conserva i decimali (1,5 -> 1.5). */
export function normParse(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[’'`´]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Divide la frase sugli elenchi: virgole, "piu'", e "e"/"con" solo se seguiti da una quantita'. */
export function splitSegments(text: string): string[] {
  const out: string[] = [];
  for (const coarse of text.split(/[,;+\n]|\s+più\s+|\s+piu\s+/i)) {
    const words = normParse(coarse).split(' ').filter(Boolean);
    let cur: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if ((w === 'e' || w === 'ed' || w === 'con') && cur.length > 0 && QTY_START_RE.test(words.slice(i + 1).join(' '))) {
        out.push(cur.join(' '));
        cur = [];
        continue;
      }
      cur.push(w);
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out.filter(Boolean);
}

export interface ParsedSegment {
  raw: string;
  qty?: number;
  /** Grammi (o ml) se la quantita' ha un'unita' di misura. */
  grams?: number;
  /** Unita' domestica (radice: fett, cucchia, piatt...). */
  noun?: string;
  food: string;
}

const qtyOf = (s: string) => (s in NUM_WORDS ? NUM_WORDS[s] : Number(s));

export function parseSegment(raw: string): ParsedSegment {
  const s = normParse(raw);
  let qty: number | undefined;
  let grams: number | undefined;
  let rest = s;
  const lead = s.match(LEAD_RE);
  if (lead && lead[3] !== undefined && (lead[2] || lead[3])) {
    qty = qtyOf(lead[1]);
    if (lead[2]) grams = qty * UNIT_FACTOR[lead[2]];
    rest = lead[3];
  } else {
    const trail = s.match(TRAIL_RE);
    if (trail) {
      rest = trail[1];
      qty = Number(trail[2]);
      grams = qty * UNIT_FACTOR[trail[3]];
    }
  }
  let noun: string | undefined;
  if (grams === undefined) {
    const n = rest.match(NOUN_RE);
    if (n) {
      noun = stem(n[1]);
      rest = n[2];
    }
  }
  return { raw, qty, grams, noun, food: rest.replace(/^(di|d)\s+/, '').trim() };
}

/** Porzione dell'alimento che corrisponde meglio alla frase (unita' domestica, aggettivi come "media"). */
function pickPortion(food: FoodItem, seg: ParsedSegment): { label: string; grams: number } | undefined {
  const portions = food.portions ?? [];
  if (portions.length === 0) return undefined;
  const segWords = new Set(normParse(seg.raw).split(' ').map(stem));
  let best: { label: string; grams: number } | undefined;
  let bestScore = -Infinity;
  portions.forEach((p, i) => {
    const words = normParse(p.label).split(' ').map(stem);
    if (seg.noun && !words.includes(seg.noun)) return;
    let score = words.filter((w) => w.length > 2 && segWords.has(w)).length;
    if (seg.qty !== undefined && /^1\s/.test(p.label)) score += 0.5;
    if (seg.qty === undefined && /^porzione/.test(p.label)) score += 0.5;
    score -= i * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return best;
}

const RAW_STAPLE_CATEGORIES = new Set(['Pasta, riso e cereali', 'Legumi', 'Carne', 'Pesce']);

export interface LocalParse {
  items: DraftItem[];
  unmatched: string[];
}

export function parseTextLocal(text: string, index: FoodSearchIndex): LocalParse {
  const items: DraftItem[] = [];
  const unmatched: string[] = [];
  for (const raw of splitSegments(text)) {
    const seg = parseSegment(raw);
    if (!seg.food) {
      unmatched.push(raw);
      continue;
    }
    const isDishNoun = seg.noun === 'piatt' || seg.noun === 'porzion';
    const m = matchToDb(index, { name: seg.food, kind: isDishNoun ? 'piatto' : undefined });
    if (!m) {
      unmatched.push(raw);
      continue;
    }
    const food = m.food;
    let grams: number;
    let how: string;
    let conf = m.confidence;
    if (seg.grams !== undefined) {
      grams = seg.grams;
      how = `${grams} g indicati da te`;
    } else {
      const p = pickPortion(food, seg);
      const count = seg.qty ?? 1;
      const dish = food as Partial<{ servingGrams: number }>;
      if (p) {
        grams = p.grams * count;
        how = `${count === 1 ? '' : `${count} x `}${p.label} (${p.grams} g)`;
      } else if (seg.noun && isDishNoun && dish.servingGrams) {
        grams = dish.servingGrams * count;
        how = `porzione standard (${dish.servingGrams} g)`;
      } else {
        const unit = seg.noun ? NOUN_DEFAULT[seg.noun] ?? 100 : 100;
        grams = unit * count;
        how = seg.noun ? `${count} x ${unit} g (misura tipica)` : `${grams} g (quantità non indicata)`;
      }
      const standard = food.source === 'ricetta' || kindOf(food) === 'bevanda' || (p !== undefined && /^1\s/.test(p.label));
      conf = minConfidence(conf, seg.qty !== undefined || standard ? 'media' : 'bassa');
    }
    const rawNote =
      seg.grams !== undefined && RAW_STAPLE_CATEGORIES.has(food.category) && /crud|secc/.test(normParse(food.name))
        ? ' Peso inteso a crudo: se era cotto scegli la voce cotta.'
        : '';
    const exact = seg.grams !== undefined;
    const { range } = normalizeGrams(grams, exact ? grams : grams * 0.8, exact ? grams : grams * 1.2, exact ? 0 : 0.1);
    items.push(
      draftFromFood(food, grams, range, {
        inputName: raw,
        kind: kindOf(food),
        confidence: conf,
        why: `"${raw}": ${how}, abbinato a ${food.name}.${rawNote}`,
        alternatives: m.alternatives,
      }),
    );
  }
  return { items, unmatched };
}
