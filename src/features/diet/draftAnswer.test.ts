import { describe, expect, it } from 'vitest';
import type { DraftItem } from '@/lib/nutrition';
import { answerItems } from './draftAnswer';

const per100 = (kcal: number, protein: number, carbs: number, fat: number) => ({ kcal, protein, carbs, fat });
const draft = (foodId: string, inputName: string, grams: number, p100: ReturnType<typeof per100>): DraftItem =>
  ({
    foodId, name: foodId, inputName, grams, gramsRange: [grams, grams], kcalRange: [(p100.kcal * grams) / 100, (p100.kcal * grams) / 100],
    nutrients: { kcal: (p100.kcal * grams) / 100, protein: (p100.protein * grams) / 100, carbs: (p100.carbs * grams) / 100, fat: (p100.fat * grams) / 100 },
    per100g: p100, source: 'ciqual', confidence: 'media', kind: 'alimento', alternatives: [], why: '',
  }) as unknown as DraftItem;

const pasta = draft('pasta-di-semola-cruda', 'pasta', 90, per100(364, 13.1, 72.7, 1.6));
const pollo = draft('petto-di-pollo-ai-ferri', 'pollo', 150, per100(141, 30.1, 0, 2));
const olio = draft('olio-extravergine-di-oliva', 'olio non visibile', 10, per100(899, 0.25, 0, 99.9));

describe('domanda sull’olio', () => {
  it('niente olio e poi un cucchiaio: la voce torna', () => {
    const tolto = answerItems([pasta, pollo, olio], olio, 0);
    expect(tolto.map((x) => x.foodId)).toEqual([pasta.foodId, pollo.foodId]);
    const tornato = answerItems(tolto, olio, 10);
    expect(tornato.map((x) => x.foodId)).toEqual([pasta.foodId, pollo.foodId, olio.foodId]);
    expect(tornato[2].grams).toBe(10);
    expect(tornato[2].nutrients.fat).toBeCloseTo(10, 0); // 99,9 g su 100 g, arrotondato
  });

  it('se togli una voce prima di rispondere, cambia comunque l’olio e non un altro alimento', () => {
    const senzaPasta = [pollo, olio];
    const r = answerItems(senzaPasta, olio, 20);
    expect(r.find((x) => x.foodId === pollo.foodId)!.grams).toBe(150);
    expect(r.find((x) => x.foodId === olio.foodId)!.grams).toBe(20);
  });

  it('domanda senza voce collegata: lista invariata', () => {
    const list = [pasta, pollo];
    expect(answerItems(list, undefined, 10)).toBe(list);
  });
});
