import { describe, expect, it } from 'vitest';
import type { Nutrients } from '@/db/types';
import {
  atwaterKcal,
  checkAtwater,
  kcalRange,
  roundNutrients,
  scaleNutrients,
  sumNutrients,
} from './nutrients';

const pastaCruda: Nutrients = { kcal: 364, protein: 13.1, carbs: 72.7, fat: 1.6, fiber: 2.91, sugars: 2.58, satFat: 0.33, salt: 0.016 };
const guanciale: Nutrients = { kcal: 652, protein: 6.38, carbs: 0, fat: 69.61, fiber: 0, sugars: 0, satFat: 25.26 };

describe('scaleNutrients', () => {
  it('scala i valori per 100 g ai grammi indicati', () => {
    const n = scaleNutrients(pastaCruda, 80);
    expect(n.kcal).toBeCloseTo(291.2, 5);
    expect(n.protein).toBeCloseTo(10.48, 5);
    expect(n.salt).toBeCloseTo(0.0128, 6);
  });

  it('lascia undefined i nutrienti che mancano, senza inventare zeri', () => {
    const n = scaleNutrients(guanciale, 30);
    expect(n.salt).toBeUndefined();
    expect(n.fat).toBeCloseTo(20.883, 5);
  });

  it('rifiuta grammi negativi o non numerici', () => {
    expect(() => scaleNutrients(pastaCruda, -1)).toThrow(RangeError);
    expect(() => scaleNutrients(pastaCruda, Number.NaN)).toThrow(RangeError);
  });
});

describe('sumNutrients', () => {
  it('somma i macronutrienti e gli opzionali disponibili', () => {
    const tot = sumNutrients([scaleNutrients(pastaCruda, 100), scaleNutrients(guanciale, 30)]);
    expect(tot.kcal).toBeCloseTo(364 + 195.6, 5);
    expect(tot.fat).toBeCloseTo(1.6 + 20.883, 5);
    // il sale c'e' solo nella pasta: la somma usa i valori disponibili
    expect(tot.salt).toBeCloseTo(0.016, 6);
  });

  it('in modalita rigorosa un opzionale mancante rende vuoto il totale', () => {
    const tot = sumNutrients([scaleNutrients(pastaCruda, 100), scaleNutrients(guanciale, 30)], { strict: true });
    expect(tot.salt).toBeUndefined();
    expect(tot.fiber).toBeCloseTo(2.91, 5);
  });

  it('lista vuota: zero calorie e nessun opzionale', () => {
    expect(sumNutrients([])).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });
});

describe('roundNutrients', () => {
  it('kcal intere e macronutrienti a un decimale', () => {
    const r = roundNutrients({ kcal: 291.49, protein: 10.48, carbs: 58.16, fat: 1.25, fiber: 2.328, salt: 0.0128 });
    expect(r).toEqual({ kcal: 291, protein: 10.5, carbs: 58.2, fat: 1.3, fiber: 2.3, salt: 0 });
  });

  it('arrotonda correttamente i casi .5 con errore binario', () => {
    expect(roundNutrients({ kcal: 100.5, protein: 1.05, carbs: 0, fat: 0 }).protein).toBe(1.1);
  });
});

describe('Atwater', () => {
  it('calcola 4 x proteine + 4 x carboidrati + 9 x grassi + 2 x fibre', () => {
    expect(atwaterKcal(pastaCruda)).toBeCloseTo(4 * 13.1 + 4 * 72.7 + 9 * 1.6 + 2 * 2.91, 6);
  });

  it('conta alcol, polioli e acidi organici quando presenti', () => {
    expect(atwaterKcal({ kcal: 70, protein: 0, carbs: 2, fat: 0, alcohol: 9 })).toBeCloseTo(8 + 63, 6);
    expect(atwaterKcal({ kcal: 0, protein: 0, carbs: 10, fat: 0, polyols: 5 })).toBeCloseTo(20 + 12, 6);
  });

  it('accetta scarti entro il 10% e segnala quelli oltre', () => {
    expect(checkAtwater(pastaCruda).ok).toBe(true);
    const sbagliato = { kcal: 500, protein: 10, carbs: 10, fat: 10 };
    const r = checkAtwater(sbagliato);
    expect(r.ok).toBe(false);
    expect(r.expected).toBeCloseTo(170, 6);
    expect(r.diffPct).toBeCloseTo((500 - 170) / 500, 6);
  });

  it('per gli alimenti quasi senza calorie usa una tolleranza assoluta di 3 kcal', () => {
    expect(checkAtwater({ kcal: 11, protein: 0.7, carbs: 1.8, fat: 0, fiber: 1 }).ok).toBe(true);
  });
});

describe('kcalRange', () => {
  it('ricava l intervallo di calorie dall intervallo di grammi', () => {
    expect(kcalRange(pastaCruda, [70, 90])).toEqual([255, 328]);
  });
});
