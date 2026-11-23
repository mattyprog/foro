import { beforeAll, describe, expect, it } from 'vitest';
import type { FoodItem } from '@/db/types';
import { loadAllFoods } from './foodDb';
import { FoodSearchIndex, matchToDb, normalizeText, stem, tokenize } from './search';

let index: FoodSearchIndex;
const userFood: FoodItem = {
  id: 'utente-barretta-proteica',
  name: 'Barretta proteica al cioccolato',
  category: 'Prodotti confezionati',
  per100g: { kcal: 370, protein: 33, carbs: 30, fat: 12 },
  source: 'utente',
  brand: 'Marca Esempio',
};

beforeAll(async () => {
  index = new FoodSearchIndex(await loadAllFoods([userFood]));
});

const top = (q: string, opts?: Parameters<FoodSearchIndex['search']>[1]) => index.search(q, opts)[0]?.item.id;
const topN = (q: string, n = 3) => index.search(q, { limit: n }).map((r) => r.item.id);

describe('normalizzazione del testo', () => {
  it('toglie accenti, apostrofi e punteggiatura', () => {
    expect(normalizeText('Caffè Espresso')).toBe('caffe espresso');
    expect(normalizeText("Tonno sott'olio, sgocciolato")).toBe('tonno sott olio sgocciolato');
    expect(normalizeText('  BACCALÀ   fritto ')).toBe('baccala fritto');
  });

  it('riduce singolare e plurale alla stessa radice', () => {
    const coppie = [
      ['pomodori', 'pomodoro'], ['uova', 'uovo'], ['mele', 'mela'], ['fagioli', 'fagiolo'],
      ['funghi', 'fungo'], ['albicocche', 'albicocca'], ['spinaci', 'spinacio'], ['arance', 'arancia'],
      ['formaggi', 'formaggio'], ['zucchine', 'zucchina'], ['ciliegie', 'ciliegia'], ['carciofi', 'carciofo'],
      ['finocchi', 'finocchio'], ['radicchi', 'radicchio'], ['pistacchi', 'pistacchio'], ['germogli', 'germoglio'],
      ['oli', 'olio'], ['acciughe', 'acciuga'], ['noci', 'noce'], ['ceci', 'cece'],
    ];
    for (const [a, b] of coppie) expect(stem(a), `${a}/${b}`).toBe(stem(b));
  });

  it('scarta le parole vuote e normalizza i metodi di cottura', () => {
    expect(tokenize('petto di pollo alla griglia')).toEqual(['petto', 'pollo', 'ferri']);
    expect(tokenize('patate bollite')).toEqual(['patate', 'lessato']);
  });
});

describe('ricerca su query italiane reali', () => {
  it("l'ordine delle parole non conta: 'pollo petto' = 'petto di pollo'", () => {
    expect(top('pollo petto')).toBe('petto-di-pollo-crudo');
    expect(top('petto di pollo')).toBe('petto-di-pollo-crudo');
    expect(top('padano grana')).toBe(top('grana padano'));
  });

  it('accenti e maiuscole non contano', () => {
    expect(topN('baccala')).toContain('baccala-secco-salato');
    expect(topN('BACCALÀ FRITTO')).toContain('filetto-di-baccala-fritto');
    expect(top('caffe')).toBe('caffe-espresso');
  });

  it('plurali e singolari', () => {
    expect(top('uova')).toBe('uovo-intero-crudo');
    expect(topN('carciofo')).toContain('carciofi-crudi');
    expect(topN('pomodoro')).toContain('pomodori-crudi');
  });

  it('alias e nomi romani', () => {
    expect(top('cime di rapa')).toBe('broccoletti-cime-di-rapa-crudi');
    expect(top('carbonara')).toBe('carbonara');
    expect(top('matriciana')).toBe('amatriciana');
    expect(top('suppli')).toBe('suppli');
    expect(top('fiocchi di latte')).toBe('fiocchi-di-latte');
    expect(top('parmigiano')).toBe('parmigiano-reggiano');
    expect(topN('yogurt greco')).toContain('yogurt-greco-bianco-0');
    expect(top('olio')).toBe('olio-extravergine-di-oliva');
    expect(top('cornetto')).toBe('cornetto-semplice');
    expect(top('cappuccino')).toBe('cappuccino');
    expect(top('whey')).toBe('proteine-whey-in-polvere');
  });

  it('errori di battitura', () => {
    expect(top('mozarella')).toBe('mozzarella-fior-di-latte');
    expect(top('prosciuto crudo')).toBe('prosciutto-crudo');
    expect(topN('bresola')).toContain('bresaola');
  });

  it('pesce non confonde la pesca (frutto)', () => {
    const r = index.search('pesce', { limit: 1 })[0];
    expect(r.item.category).toBe('Pesce');
  });

  it('i metodi di cottura sono sinonimi', () => {
    expect(top('petto di pollo alla griglia')).toBe('petto-di-pollo-ai-ferri');
    expect(top('pollo alla piastra')).toBe('petto-di-pollo-ai-ferri');
    expect(top('zucchine bollite')).toBe('zucchine-lessate');
  });

  it("con prefer 'cotto' preferisce la versione cotta", () => {
    expect(top('pasta')).toBe('pasta-di-semola-cruda');
    expect(top('spaghetti', { prefer: 'cotto' })).toBe('pasta-di-semola-cotta');
    expect(top('riso', { prefer: 'cotto' })).toBe('riso-bianco-lessato');
  });

  it('unisce gli alimenti dell utente e li filtra per fonte', () => {
    expect(top('barretta proteica')).toBe('utente-barretta-proteica');
    expect(topN('marca esempio')).toContain('utente-barretta-proteica');
    const soloCiqual = index.search('carbonara', { sources: ['ciqual'] });
    expect(soloCiqual.every((r) => r.item.source === 'ciqual')).toBe(true);
  });

  it('query vuote o senza senso non restituiscono nulla', () => {
    expect(index.search('')).toEqual([]);
    expect(index.search('   di la ')).toEqual([]);
    expect(index.search('xyzzyqwv')).toEqual([]);
  });

  it('e veloce: meno di 5 ms a query sull intero database', async () => {
    const all = await loadAllFoods([userFood]);
    const t0 = performance.now();
    const idx = new FoodSearchIndex(all);
    const buildMs = performance.now() - t0;
    const queries = [
      'pollo', 'petto di pollo', 'pasta', 'spaghetti', 'riso basmati', 'carbonara', 'amatriciana', 'mozarella',
      'prosciutto crudo', 'bresaola', 'yogurt greco', 'banana', 'mela', 'pane integrale', 'olio', 'uova',
      'tonno in scatola', 'salmone', 'patate al forno', 'zucchine', 'cicoria', 'puntarelle', 'carciofi alla romana',
      'pizza margherita', 'suppli', 'cornetto', 'cappuccino', 'whey', 'fiocchi di latte', 'ricotta', 'parmigiano',
      'ceci', 'lenticchie', 'fagioli borlotti', 'biscotti', 'nutella', 'birra', 'vino rosso', 'caffe', 'latte',
      'grana', 'pecorino', 'gnocchi', 'lasagna', 'parmigiana', 'merluzzo', 'orata', 'gamberi', 'avena', 'miele',
    ];
    const reps = 4;
    const t1 = performance.now();
    for (let r = 0; r < reps; r++) for (const q of queries) idx.search(q);
    const perQuery = (performance.now() - t1) / (reps * queries.length);
    console.log(`ricerca: ${all.length} voci, indice in ${buildMs.toFixed(1)} ms, ${perQuery.toFixed(3)} ms a query`);
    expect(perQuery).toBeLessThan(5);
  });
});

describe('matchToDb (abbinamento dei nomi restituiti da Gemini)', () => {
  it('riconosce un piatto composto e usa la ricetta', () => {
    const m = matchToDb(index, { name: 'Spaghetti alla carbonara', kind: 'piatto' });
    expect(m?.food.id).toBe('carbonara');
    expect(m?.confidence).toBe('alta');
  });

  it('ignora i descrittori che non cambiano i valori (grattugiato, a scaglie)', () => {
    const m = matchToDb(index, { name: 'pecorino romano grattugiato' });
    expect(m?.food.id).toBe('pecorino-romano');
    expect(m?.confidence).toBe('alta');
    expect(matchToDb(index, { name: 'grana a scaglie' })?.food.id).toBe('grana-padano');
  });

  it('usa lo stato di cottura per scegliere la voce giusta', () => {
    expect(matchToDb(index, { name: 'riso', cooking: 'bollito' })?.food.id).toBe('riso-bianco-lessato');
    expect(matchToDb(index, { name: 'petto di pollo', cooking: 'alla_griglia' })?.food.id).toBe('petto-di-pollo-ai-ferri');
    expect(matchToDb(index, { name: 'spaghetti', state: 'cotto' })?.food.id).toBe('pasta-di-semola-cotta');
    expect(matchToDb(index, { name: 'pane casereccio', state: 'cotto' })?.food.id).toBe('pane-casereccio');
  });

  it('le alternative parlano dello stesso cibo, non della stessa cottura', () => {
    const m = matchToDb(index, { name: 'carbonara', cooking: 'in_padella', kind: 'piatto' });
    expect(normalizeText(m!.food.name)).toContain('carbonara');
    for (const a of m!.alternatives) expect(normalizeText(a.name)).not.toMatch(/cicoria|broccoletti|peperon|zucchin|spinaci/);
    const z = matchToDb(index, { name: 'zucchine', cooking: 'in_padella' });
    expect(z!.alternatives.length).toBeGreaterThan(1);
    for (const a of z!.alternatives) expect(normalizeText(a.name)).not.toMatch(/cicoria|broccoletti|peperon|spinaci|carciof|funghi/);
  });

  it('propone alternative per la correzione', () => {
    const m = matchToDb(index, { name: 'pollo', cooking: 'arrosto' });
    expect(m).not.toBeNull();
    expect(m!.alternatives.length).toBeGreaterThan(1);
  });

  it('se il database non ha niente di simile restituisce null', () => {
    expect(matchToDb(index, { name: 'salsa al wasabi e yuzu fermentato' })).toBeNull();
  });
});
