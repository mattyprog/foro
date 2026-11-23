import { describe, expect, it } from 'vitest';
import { checkAtwater, roundTo, scaleNutrients, sumNutrients } from './nutrients';
import { loadBaseFoods, loadDishes, loadFoodDbMeta } from './foodDb';

const CATEGORIE_BASE = new Set([
  'Verdura', 'Frutta', 'Frutta secca e semi', 'Legumi', 'Patate e tuberi', 'Pasta, riso e cereali',
  'Pane e lievitati', 'Carne', 'Salumi', 'Pesce', 'Uova', 'Latte e yogurt', 'Formaggi', 'Oli e grassi',
  'Condimenti e salse', 'Erbe e spezie', 'Dolci', 'Colazione', 'Snack salati', 'Bevande',
  'Bevande alcoliche', 'Integratori', 'Proteine vegetali', 'Piatti pronti',
]);

describe('database alimenti (alimenti.json)', async () => {
  const foods = await loadBaseFoods();
  const meta = await loadFoodDbMeta();

  it('contiene tra 600 e 1000 alimenti con id univoci', () => {
    expect(foods.length).toBeGreaterThanOrEqual(600);
    expect(foods.length).toBeLessThanOrEqual(1000);
    expect(new Set(foods.map((f) => f.id)).size).toBe(foods.length);
    expect(meta.numeroAlimenti).toBe(foods.length);
  });

  it('cita la fonte CIQUAL con licenza e versione', () => {
    const ciqual = meta.fonti.find((f) => f.id === 'ciqual');
    expect(ciqual?.citazione).toMatch(/Ciqual 2025/);
    expect(ciqual?.licenza).toMatch(/Licence Ouverte/);
    expect(foods.every((f) => f.source === 'ciqual' || f.source === 'usda')).toBe(true);
    expect(foods.filter((f) => f.source === 'ciqual').length).toBeGreaterThan(foods.length * 0.9);
  });

  it('ogni alimento ha valori per 100 g plausibili', () => {
    for (const f of foods) {
      const n = f.per100g;
      for (const k of ['kcal', 'protein', 'carbs', 'fat'] as const) {
        expect(Number.isFinite(n[k]), `${f.id}.${k}`).toBe(true);
        expect(n[k], `${f.id}.${k}`).toBeGreaterThanOrEqual(0);
      }
      expect(n.kcal, f.id).toBeLessThanOrEqual(900);
      expect(n.protein + n.carbs + n.fat, f.id).toBeLessThanOrEqual(100.5);
      expect(CATEGORIE_BASE.has(f.category), `${f.id}: ${f.category}`).toBe(true);
      expect(f.portions?.length, f.id).toBeGreaterThan(0);
      for (const p of f.portions ?? []) expect(p.grams, `${f.id} ${p.label}`).toBeGreaterThan(0);
    }
  });

  it('kcal coerenti con i macronutrienti (Atwater entro il 10%) per tutto il database', () => {
    const fuori = foods.filter((f) => !checkAtwater(f.per100g).ok).map((f) => f.id);
    expect(fuori).toEqual([]);
  });

  it('copre gli alimenti romani e da palestra richiesti', () => {
    const ids = new Set(foods.map((f) => f.id));
    for (const id of [
      'guanciale', 'pecorino-romano', 'mozzarella-fior-di-latte', 'ricotta-vaccina', 'ricotta-di-pecora',
      'parmigiano-reggiano', 'grana-padano', 'fiocchi-di-latte', 'yogurt-greco-bianco-0', 'prosciutto-crudo',
      'prosciutto-cotto', 'bresaola', 'mortadella', 'porchetta', 'carciofi-crudi', 'cicoria-cruda',
      'puntarelle-crude', 'broccoletti-cime-di-rapa-crudi', 'agretti-barba-di-frate-crudi',
      'pasta-di-semola-cruda', 'pasta-di-semola-cotta', 'riso-bianco-lessato', 'ceci-lessati',
      'proteine-whey-in-polvere', 'olio-extravergine-di-oliva', 'uovo-intero-crudo', 'petto-di-pollo-crudo',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('le porzioni standard richieste ci sono', () => {
    const byId = new Map(foods.map((f) => [f.id, f]));
    const porzione = (id: string, label: string) => byId.get(id)?.portions?.find((p) => p.label === label)?.grams;
    expect(porzione('uovo-intero-crudo', '1 uovo medio')).toBe(55);
    expect(porzione('pane-bianco', '1 fetta')).toBe(30);
    expect(porzione('olio-extravergine-di-oliva', '1 cucchiaio')).toBe(10);
    expect(porzione('pasta-di-semola-cruda', 'porzione')).toBe(80);
  });
});

describe('piatti da ricetta (ricette.json)', async () => {
  const foods = await loadBaseFoods();
  const dishes = await loadDishes();
  const byId = new Map(foods.map((f) => [f.id, f]));

  it('contiene tra 35 e 45 piatti, con i romani richiesti', () => {
    expect(dishes.length).toBeGreaterThanOrEqual(35);
    expect(dishes.length).toBeLessThanOrEqual(45);
    const ids = new Set(dishes.map((d) => d.id));
    for (const id of ['carbonara', 'cacio-e-pepe', 'amatriciana', 'gricia', 'suppli', 'pizza-bianca-romana',
      'maritozzo-con-la-panna', 'carciofo-alla-giudia', 'coda-alla-vaccinara', 'cappuccino', 'porridge-d-avena']) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const d of dishes) expect(byId.has(d.id), `collisione ${d.id}`).toBe(false);
  });

  it('gli ingredienti puntano ad alimenti esistenti e i valori si ricalcolano dalla ricetta', () => {
    for (const d of dishes) {
      const parts = d.recipe.map((r) => {
        const food = byId.get(r.foodId);
        expect(food, `${d.id}: ${r.foodId}`).toBeDefined();
        return scaleNutrients(food!.per100g, r.grams);
      });
      const tot = sumNutrients(parts);
      // la ricetta per porzione ricostruisce i valori della porzione standard (entro l'arrotondamento)
      expect(Math.abs(tot.kcal - d.perServing.kcal), d.id).toBeLessThanOrEqual(Math.max(2, d.perServing.kcal * 0.01));
      expect(Math.abs(tot.protein - d.perServing.protein), d.id).toBeLessThanOrEqual(0.6);
      const per100 = (d.perServing.kcal / d.servingGrams) * 100;
      expect(Math.abs(per100 - d.per100g.kcal), d.id).toBeLessThanOrEqual(1);
    }
  });

  it('Atwater entro il 10% per ogni piatto (per 100 g e per porzione)', () => {
    for (const d of dishes) {
      expect(checkAtwater(d.per100g).ok, d.id).toBe(true);
      expect(checkAtwater(d.perServing).ok, `${d.id} porzione`).toBe(true);
    }
  });

  it('ogni piatto ha porzione servita, resa, nota sulle ipotesi e intervallo di variabilita', () => {
    for (const d of dishes) {
      expect(d.servingGrams, d.id).toBeGreaterThan(0);
      expect(d.yieldGrams, d.id).toBeGreaterThanOrEqual(d.servingGrams);
      expect(d.note.length, d.id).toBeGreaterThan(20);
      expect(d.variability, d.id).toBeGreaterThan(0);
      expect(d.variability, d.id).toBeLessThanOrEqual(0.4);
      expect(d.portions?.[0]?.grams, d.id).toBe(d.servingGrams);
      // niente lineette lunghe nei testi per l'utente
      expect(/[\u2013\u2014]/.test(d.note + d.name), d.id).toBe(false);
    }
  });

  it('valori di riferimento: carbonara da trattoria tra 600 e 850 kcal', () => {
    const c = dishes.find((d) => d.id === 'carbonara')!;
    expect(c.perServing.kcal).toBeGreaterThan(600);
    expect(c.perServing.kcal).toBeLessThan(850);
    expect(roundTo(c.per100g.kcal, 0)).toBeGreaterThan(200);
  });
});
