import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/nutrition-off-8076800195057.json';
import notFound from '../../../tests/fixtures/nutrition-off-notfound.json';
import { isValidBarcode, lookupBarcode, lookupBarcodeDetailed, mapOffProduct, OffError } from './openfoodfacts';

// copia modificabile della fixture (tipi larghi: i test tolgono o cambiano campi)
type Mut = { code: string; product: Record<string, unknown> & { nutriments: Record<string, unknown> } };
const clone = (x: unknown): Mut => JSON.parse(JSON.stringify(x)) as Mut;
/** Toglie un nutriente in tutte le sue forme (_100g, _serving, _value...). */
const drop = (n: Record<string, unknown>, key: string) => {
  for (const k of Object.keys(n)) if (k === key || k.startsWith(`${key}_`)) delete n[k];
};

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('mapOffProduct (fixture reale: Spaghetti n.5 Barilla)', () => {
  it('valori per 100 g, nome italiano, marca pulita, porzione', () => {
    const r = mapOffProduct(fixture);
    expect(r.status).toBe('trovato');
    if (r.status !== 'trovato') return;
    const f = r.food;
    expect(f.id).toBe('off:8076800195057');
    expect(f.source).toBe('off');
    expect(f.barcode).toBe('8076800195057');
    expect(f.name).toBe('Spaghetti n.5');
    expect(f.brand).toBe('Barilla');
    expect(f.category).toBe('Pasta, riso e cereali');
    expect(f.per100g).toEqual({ kcal: 359, protein: 13, carbs: 71, fat: 2, fiber: 3, sugars: 3.5, satFat: 0.5, salt: 0.01 });
    expect(f.portions).toContainEqual({ label: '1 porzione (85 g)', grams: 85 });
    expect(f.portions).toContainEqual({ label: '1 confezione (500 g)', grams: 500 });
    expect(f.sourceRef).toBe('https://world.openfoodfacts.org/product/8076800195057');
    expect(r.atwaterOk).toBe(true);
    expect(r.kcalFrom).toBe('etichetta');
  });

  it('non usa mai i valori stimati da Open Food Facts (nutriments_estimated)', () => {
    const j = clone(fixture);
    drop(j.product.nutriments, 'fiber');
    j.product.nutriments_estimated = { fiber_100g: 9 };
    const r = mapOffProduct(j);
    expect(r.status === 'trovato' && r.food.per100g.fiber).toBeUndefined();
  });

  it('prodotto senza valori nutrizionali: niente zeri inventati, dice cosa manca', () => {
    const j = clone(fixture);
    j.product.nutriments = { 'energy-kcal_100g': 359 };
    const r = mapOffProduct(j);
    expect(r.status).toBe('senza-valori');
    if (r.status !== 'senza-valori') return;
    expect(r.name).toBe('Spaghetti n.5');
    expect(r.brand).toBe('Barilla');
    expect(r.missing).toEqual(['proteine', 'carboidrati', 'grassi']);
    expect(r.message).toMatch(/etichetta/);
  });

  it('energia solo in kJ, sale dal sodio, valori solo per porzione', () => {
    const j = clone(fixture);
    const n = j.product.nutriments;
    drop(n, 'energy-kcal');
    drop(n, 'salt');
    let r = mapOffProduct(j);
    expect(r.status === 'trovato' && r.food.per100g.kcal).toBe(364); // 1521 kJ / 4,184
    expect(r.status === 'trovato' && r.kcalFrom).toBe('kj');
    expect(r.status === 'trovato' && r.food.per100g.salt).toBe(0.01); // 0,004 g di sodio x 2,5

    const s = clone(fixture);
    s.product.nutrition_data_per = 'serving';
    s.product.nutriments = { 'energy-kcal_serving': 305, proteins_serving: 11.05, carbohydrates_serving: 60.35, fat_serving: 1.7 };
    r = mapOffProduct(s);
    expect(r.status).toBe('trovato');
    if (r.status !== 'trovato') return;
    expect(r.food.per100g.kcal).toBe(359); // 305 / 85 x 100 = 358,8
    expect(r.food.per100g.protein).toBe(13);
    expect(r.food.per100g.fiber).toBeUndefined();
  });

  it('valori impossibili: senza-valori', () => {
    const j = clone(fixture);
    j.product.nutriments['carbohydrates_100g'] = 710;
    expect(mapOffProduct(j).status).toBe('senza-valori');
  });
});

describe('lookupBarcode', () => {
  it('chiama l API v2 con i soli campi necessari e restituisce il FoodItem', async () => {
    const f = mockFetch(fixture);
    const food = await lookupBarcode('8076800195057', { fetch: f });
    expect(food?.name).toBe('Spaghetti n.5');
    const url = String(f.mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/8076800195057\.json\?fields=/);
    expect(url).toMatch(/nutriments/);
  });

  it('prodotto non trovato (404 reale): null', async () => {
    expect(notFound.status).toBe(0);
    expect(await lookupBarcode('8009999999991', { fetch: mockFetch(notFound, 404) })).toBeNull();
    const d = await lookupBarcodeDetailed('8009999999991', { fetch: mockFetch(notFound, 404) });
    expect(d.status).toBe('non-trovato');
  });

  it('prodotto senza valori: null da lookupBarcode, dettagli da lookupBarcodeDetailed', async () => {
    const j = clone(fixture);
    j.product.nutriments = {};
    expect(await lookupBarcode('8076800195057', { fetch: mockFetch(j) })).toBeNull();
    const d = await lookupBarcodeDetailed('8076800195057', { fetch: mockFetch(j) });
    expect(d.status).toBe('senza-valori');
  });

  it('codice non valido: errore senza chiamare la rete', async () => {
    const f = mockFetch(fixture);
    await expect(lookupBarcode('8076800195058', { fetch: f })).rejects.toMatchObject({ kind: 'codice-non-valido' });
    await expect(lookupBarcode('abc', { fetch: f })).rejects.toBeInstanceOf(OffError);
    expect(f).not.toHaveBeenCalled();
    expect(isValidBarcode('8076800195057')).toBe(true);
    expect(isValidBarcode('96385074')).toBe(true); // EAN-8
  });

  it('errori classificati con messaggi in italiano', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(lookupBarcode('8076800195057', { fetch: offline })).rejects.toMatchObject({ kind: 'rete' });
    await expect(lookupBarcode('8076800195057', { fetch: mockFetch({}, 429) })).rejects.toMatchObject({ kind: 'limite' });
    await expect(lookupBarcode('8076800195057', { fetch: mockFetch({}, 503) })).rejects.toMatchObject({ kind: 'rete' });
    await expect(lookupBarcode('8076800195057', { fetch: mockFetch('<html>') })).rejects.toMatchObject({ kind: 'risposta-non-valida' });
    try {
      await lookupBarcode('8076800195057', { fetch: offline });
    } catch (e) {
      expect((e as Error).message).toMatch(/connessione/);
    }
  });
});
