import { beforeAll, describe, expect, it } from 'vitest';
import type { FoodItem } from '@/db/types';
import { loadBaseFoods } from './foodDb';
import { MEAL_TEMPLATES, buildDayMenu, compatibleTemplates, mealShares, type MenuOptions } from './mealPlan';

let byId: Map<string, FoodItem>;
const get = (id: string) => byId.get(id);

beforeAll(async () => {
  byId = new Map((await loadBaseFoods()).map((f) => [f.id, f]));
});

const base = (o: Partial<MenuOptions> = {}): MenuOptions => ({
  date: '2026-11-23',
  target: { kcal: 2600, protein: 128 },
  mealsPerDay: 4,
  diet: 'onnivora',
  get,
  ...o,
});

describe('menu del giorno', () => {
  it('ogni alimento dei modelli esiste nel database', () => {
    for (const t of MEAL_TEMPLATES)
      for (const c of t.comps) if (!c.id.startsWith('stagione:')) expect(byId.has(c.id), `${t.id}: ${c.id}`).toBe(true);
  });

  it('le quote dei pasti sommano a 1', () => {
    for (const n of [2, 3, 4, 5, 6]) expect(mealShares(n).reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 6);
  });

  it.each([
    { kcal: 2600, protein: 128, fat: 64, meals: 4 },
    { kcal: 2200, protein: 140, fat: 60, meals: 3 },
    { kcal: 3100, protein: 150, fat: 80, meals: 5 },
  ])('centra calorie, proteine e grassi ($kcal kcal, $protein g, $meals pasti)', ({ kcal, protein, fat, meals }) => {
    for (const month of ['01', '04', '07', '11'])
      for (let d = 1; d <= 10; d++) {
        const date = `2026-${month}-${String(d).padStart(2, '0')}`;
        const m = buildDayMenu(base({ date, target: { kcal, protein, fat }, mealsPerDay: meals }));
        expect(m.missing).toEqual([]);
        expect(m.meals).toHaveLength(Math.min(meals, 5));
        expect(Math.abs(m.totals.kcal - kcal) / kcal, `${date} kcal ${m.totals.kcal}`).toBeLessThan(0.08);
        expect(m.totals.protein, `${date} proteine`).toBeGreaterThan(protein * 0.9);
        expect(m.totals.protein, `${date} proteine`).toBeLessThan(protein * 1.25);
        expect(Math.abs(m.totals.fat - fat) / fat, `${date} grassi ${m.totals.fat}`).toBeLessThan(0.25);
        // porzioni da persona normale: niente piatti da 200 g di pasta o litri di latte
        for (const x of m.meals) for (const i of x.items) expect(i.grams, `${date} ${i.name}`).toBeLessThanOrEqual(500);
        const pasta = m.meals.flatMap((x) => x.items).filter((i) => /pasta-di-semola|riso-bianco/.test(i.foodId));
        for (const i of pasta) expect(i.grams, `${date} ${i.name}`).toBeLessThanOrEqual(150);
        expect(new Set(m.meals.map((x) => x.templateId)).size, `${date} pasti ripetuti`).toBe(m.meals.length);
      }
  });

  it('stesso giorno, stesso menu; altra proposta cambia il pasto scartato e lascia la colazione', () => {
    const a = buildDayMenu(base());
    const b = buildDayMenu(base());
    expect(b).toEqual(a);
    const lunch = a.meals.find((m) => m.slot === 'pranzo')!.templateId;
    const c = buildDayMenu(base({ avoid: { pranzo: [lunch] } }));
    expect(c.meals.find((m) => m.slot === 'pranzo')!.templateId).not.toBe(lunch);
    expect(c.meals.find((m) => m.slot === 'colazione')!.templateId).toBe(a.meals.find((m) => m.slot === 'colazione')!.templateId);
  });

  it('in una settimana i pranzi cambiano e pranzo e cena non ripetono la proteina', () => {
    const lunches = new Set<string>();
    for (let d = 16; d <= 22; d++) {
      const m = buildDayMenu(base({ date: `2026-11-${d}` }));
      lunches.add(m.meals.find((x) => x.slot === 'pranzo')!.templateId);
      const prot = (slot: string) => m.meals.find((x) => x.slot === slot)!.items.find((i) => i.role === 'proteina')!.foodId;
      expect(prot('pranzo')).not.toBe(prot('cena'));
    }
    expect(lunches.size).toBeGreaterThan(2);
  });

  it('vegana: niente carne, pesce, latticini, uova, miele', () => {
    for (const slot of ['colazione', 'pranzo', 'merenda', 'cena'] as const) {
      const list = compatibleTemplates(slot, { diet: 'vegana', get });
      expect(list.length).toBeGreaterThan(0);
      for (const t of list) expect(t.contiene.filter((c) => ['carne', 'pesce', 'latticini', 'uova', 'miele'].includes(c))).toEqual([]);
    }
  });

  it('allergie ed esclusioni tolgono i pasti che le contengono', () => {
    const noGlutine = compatibleTemplates('pranzo', { diet: 'onnivora', allergies: ['glutine'], get });
    expect(noGlutine.some((t) => t.contiene.includes('glutine'))).toBe(false);
    expect(noGlutine.length).toBeGreaterThan(0);
    const noTonno = compatibleTemplates('pranzo', { diet: 'onnivora', excluded: ['tonno'], get });
    expect(noTonno.some((t) => t.id === 'riso-tonno')).toBe(false);
  });

  it('frutta e verdura vengono dalla stagione del Lazio', () => {
    const nov = buildDayMenu(base({ date: '2026-11-23' }));
    const jul = buildDayMenu(base({ date: '2026-07-15' }));
    const fruits = (m: ReturnType<typeof buildDayMenu>) => m.meals.flatMap((x) => x.items.filter((i) => i.role === 'frutta').map((i) => i.foodId));
    expect(fruits(nov).some((f) => ['anguria-cruda', 'melone-crudo', 'pesca-cruda-con-buccia', 'albicocche-crude'].includes(f))).toBe(false);
    expect(fruits(jul).some((f) => ['arancia-cruda', 'clementine-o-mandarini-crudi', 'kiwi-crudo'].includes(f))).toBe(false);
  });

  it('se le restrizioni non lasciano niente lo dice, senza inventare', () => {
    const m = buildDayMenu(base({ diet: 'vegana', allergies: ['soia', 'glutine'], mealsPerDay: 3 }));
    expect(m.missing).toContain('colazione');
  });
});
