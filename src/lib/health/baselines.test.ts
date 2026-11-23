import { describe, expect, it } from 'vitest';
import type { WellnessDay } from '../../db/types';
import { addDays } from '../training/dates';
import {
  BASELINE_MIN_DAYS,
  computeBaselines,
  describeValues,
  indexByDate,
  metricValue,
  normalRange,
  valuesInWindow,
} from './baselines';

const TODAY = '2026-11-23';
const WIGGLE = [0, 2, -2, 1, -1, 3, -3];

const day = (offset: number, f: Partial<WellnessDay> = {}): WellnessDay => ({
  date: addDays(TODAY, offset),
  source: 'garmin',
  ...f,
});

/** Giorni stabili dall'offset -from all'offset -to (inclusi): HRV attorno a 55, FC a riposo attorno a 52, sonno 7,5 h. */
function stable(from: number, to = 1): WellnessDay[] {
  const out: WellnessDay[] = [];
  for (let i = from; i >= to; i--) {
    out.push(day(-i, { hrvNightAvg: 55 + WIGGLE[i % 7], restingHr: 52 + [0, 1, -1, 0, 1, -1, 0][i % 7], sleepSec: 7.5 * 3600 }));
  }
  return out;
}

describe('metricValue', () => {
  it('legge le tre metriche e converte il sonno in ore', () => {
    const d = day(0, { hrvNightAvg: 62, restingHr: 51, sleepSec: 27000 });
    expect(metricValue(d, 'hrv')).toBe(62);
    expect(metricValue(d, 'fcRiposo')).toBe(51);
    expect(metricValue(d, 'sonnoOre')).toBe(7.5);
  });

  it('un dato che manca o non ha senso non è un valore', () => {
    expect(metricValue(undefined, 'hrv')).toBeUndefined();
    expect(metricValue(day(0), 'hrv')).toBeUndefined();
    expect(metricValue(day(0, { hrvNightAvg: 0, restingHr: Number.NaN, sleepSec: -5 }), 'hrv')).toBeUndefined();
    expect(metricValue(day(0, { restingHr: Number.NaN }), 'fcRiposo')).toBeUndefined();
    expect(metricValue(day(0, { sleepSec: 0 }), 'sonnoOre')).toBeUndefined();
  });
});

describe('indexByDate', () => {
  it('una data per giorno, con i campi di orologio e inserimento manuale uniti', () => {
    const idx = indexByDate([
      day(0, { sleepSec: 20000, energy: undefined }),
      { date: TODAY, source: 'manuale', energy: 4, sleepSec: 99999 },
      day(-1, { hrvNightAvg: 50 }),
    ]);
    expect(idx.size).toBe(2);
    expect(idx.get(TODAY)).toMatchObject({ sleepSec: 20000, energy: 4 }); // il primo valore resta, i campi mancanti si riempiono
  });

  it('una mappa già pronta passa così com\'è', () => {
    const idx = indexByDate([day(0, { sleepSec: 1 })]);
    expect(indexByDate(idx)).toBe(idx);
  });
});

describe('valuesInWindow', () => {
  it('finestra che finisce alla data indicata, inclusa, in ordine di data, senza i buchi', () => {
    const days = [day(-3, { restingHr: 50 }), day(-2), day(-1, { restingHr: 52 }), day(0, { restingHr: 60 }), day(1, { restingHr: 99 })];
    expect(valuesInWindow(days, 'fcRiposo', TODAY, 3)).toEqual([{ date: '2026-11-22', value: 52 }, { date: TODAY, value: 60 }]);
    expect(valuesInWindow(days, 'fcRiposo', addDays(TODAY, -1), 7).map((x) => x.value)).toEqual([50, 52]);
    expect(valuesInWindow([], 'hrv', TODAY, 7)).toEqual([]);
  });
});

describe('describeValues', () => {
  it('media, deviazione standard, mediana, MAD, minimo e massimo', () => {
    const s = describeValues([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.mean).toBe(5);
    expect(s.sd).toBeCloseTo(2.138, 3);
    expect(s.median).toBe(4.5);
    expect(s.mad).toBe(0.5);
    expect([s.min, s.max]).toEqual([2, 9]);
  });

  it('con pochi valori non inventa', () => {
    expect(describeValues([])).toEqual({ n: 0 });
    const one = describeValues([60]);
    expect(one).toMatchObject({ n: 1, mean: 60, median: 60, mad: 0 });
    expect(one.sd).toBeUndefined();
  });
});

describe('normalRange', () => {
  const values = Array.from({ length: 21 }, (_, i) => 55 + WIGGLE[i % 7]);

  it('mediana più o meno 1,5 deviazioni robuste', () => {
    const r = normalRange(values)!;
    expect(r.center).toBe(55);
    // MAD 2 -> deviazione robusta 2,965 -> mezza ampiezza 4,448 (più dell'8% di 55 = 4,4)
    expect(r.low).toBeCloseTo(50.552, 2);
    expect(r.high).toBeCloseTo(59.448, 2);
  });

  it('ha un\'ampiezza minima dell\'8% della mediana, anche se i valori sono tutti uguali', () => {
    const r = normalRange(Array.from({ length: 12 }, () => 60))!;
    expect(r.low).toBeCloseTo(55.2, 6);
    expect(r.high).toBeCloseTo(64.8, 6);
  });

  it('serve un numero minimo di valori, cambiabile', () => {
    expect(normalRange([55, 56, 57])).toBeUndefined();
    expect(normalRange([55, 56, 57], { minValues: 3 })).toBeDefined();
    expect(normalRange(values, { sdMultiplier: 3 })!.low).toBeLessThan(normalRange(values)!.low);
  });

  it('due o tre giorni storti non spostano l\'intervallo', () => {
    const withDip = [...values.slice(0, 18), 40, 41, 39];
    const r = normalRange(withDip)!;
    expect(r.center).toBeCloseTo(55, 0);
    expect(r.low).toBeGreaterThan(49);
    expect(40).toBeLessThan(r.low);
  });
});

describe('computeBaselines', () => {
  it('le finestre finiscono ieri: il valore di oggi non entra nella sua base di confronto', () => {
    const days = [...stable(21, 1), day(0, { hrvNightAvg: 20, restingHr: 80, sleepSec: 3600 })];
    const b = computeBaselines(days, TODAY);
    expect(b.windowEnd).toBe('2026-11-22');
    expect(b.hrv.last21.n).toBe(21);
    expect(b.hrv.last21.median).toBe(55);
    expect(b.hrv.last21.max).toBeLessThanOrEqual(58);
    expect(b.fcRiposo.last21.max).toBeLessThanOrEqual(53);
    expect(b.sonno.last21.mean).toBe(7.5);
  });

  it('finestra corta di 7 giorni e lunga di 21', () => {
    const days = [...stable(21, 8), ...Array.from({ length: 7 }, (_, k) => day(-(7 - k), { hrvNightAvg: 70 }))];
    const b = computeBaselines(days, TODAY);
    expect(b.hrv.last7).toMatchObject({ n: 7, mean: 70, median: 70 });
    expect(b.hrv.last21.n).toBe(21);
    expect(b.hrv.last21.mean).toBeCloseTo((14 * 55 + 7 * 70) / 21, 0);
    expect(b.hrv.last7.mean).toBeGreaterThan(b.hrv.last21.mean as number);
  });

  it('con includeToday le finestre arrivano a oggi (per i grafici)', () => {
    const days = [...stable(21, 1), day(0, { hrvNightAvg: 80 })];
    const b = computeBaselines(days, TODAY, { includeToday: true });
    expect(b.windowEnd).toBe(TODAY);
    expect(b.hrv.last7.max).toBe(80);
    expect(b.hrv.last21.n).toBe(21);
  });

  it('l\'intervallo normale si calcola solo con abbastanza valori', () => {
    expect(computeBaselines(stable(21, 1), TODAY).hrv.range).toBeDefined();
    expect(computeBaselines(stable(9, 1), TODAY).hrv.range).toBeUndefined();
    expect(computeBaselines(stable(10, 1), TODAY).hrv.range).toBeDefined();
  });

  it('servono 14 giorni con dati per fidarsi; ogni metrica conta', () => {
    const b13 = computeBaselines(stable(13, 1), TODAY);
    expect(b13).toMatchObject({ daysWithData: 13, daysNeeded: BASELINE_MIN_DAYS, ready: false, daysLeft: 1 });
    const b14 = computeBaselines(stable(14, 1), TODAY);
    expect(b14).toMatchObject({ daysWithData: 14, ready: true, daysLeft: 0 });
    // un giorno col solo sonno vale come giorno di dati; un giorno vuoto no
    const mixed = [day(-1, { sleepSec: 7 * 3600 }), day(-2, { hrvNightAvg: 50 }), day(-3, { steps: 9000 })];
    expect(computeBaselines(mixed, TODAY).daysWithData).toBe(2);
    expect(computeBaselines([], TODAY)).toMatchObject({ daysWithData: 0, ready: false, daysLeft: BASELINE_MIN_DAYS });
    expect(computeBaselines(stable(10, 1), TODAY, { minDays: 10 }).ready).toBe(true);
  });

  it('i dati oltre i 21 giorni o nel futuro non contano', () => {
    const days = [...stable(21, 1), day(-30, { hrvNightAvg: 200 }), day(3, { hrvNightAvg: 1 })];
    const b = computeBaselines(days, TODAY);
    expect(b.hrv.last21.n).toBe(21);
    expect(b.hrv.last21.max).toBeLessThan(100);
    expect(b.hrv.last21.min).toBeGreaterThan(40);
  });
});
