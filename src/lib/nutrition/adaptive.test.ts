import { describe, expect, it } from 'vitest';
import type { FoodLogEntry, WeightEntry } from '@/db/types';
import { addDays, dailyIntake, mondayOf, weeklyCheckIn, weightTrend, type CheckInInput, type DailyIntake } from './adaptive';

// Serie sintetiche: si parte lunedi 7 settembre 2026, proposta di lunedi 5 ottobre (giorno 28).
const START = '2026-09-07';
const MONDAY = '2026-10-05';
const day = (i: number) => addDays(START, i);

function series(n: number, kg: (i: number) => number, kcal: (i: number) => number | undefined, skipWeights: number[] = []) {
  const weights: WeightEntry[] = [];
  const intake: DailyIntake[] = [];
  for (let i = 0; i < n; i++) {
    if (!skipWeights.includes(i)) weights.push({ date: day(i), kg: kg(i), source: 'manuale' });
    const k = kcal(i);
    if (k !== undefined) intake.push({ date: day(i), kcal: k });
  }
  return { weights, intake };
}

/** EMA indipendente per i valori attesi. */
function ema(values: number[], alpha = 0.1): number[] {
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : out[i - 1] + alpha * (v - out[i - 1])));
  return out;
}

const baseInput = (over: Partial<CheckInInput>): CheckInInput => ({
  asOf: MONDAY,
  weights: [],
  intake: [],
  previousTdee: 2400,
  bmr: 1700,
  goal: 'mantenimento',
  ...over,
});

describe('date e tendenza', () => {
  it('lunedi della settimana', () => {
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(mondayOf('2026-10-08')).toBe('2026-10-05');
    expect(mondayOf('2026-10-11')).toBe('2026-10-05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30'); // cambio dell ora legale
  });

  it('media mobile esponenziale con alfa 0,1 e pesate disordinate', () => {
    const t = weightTrend([
      { date: '2026-01-03', kg: 71, source: 'manuale' },
      { date: '2026-01-01', kg: 70, source: 'manuale' },
      { date: '2026-01-02', kg: 72, source: 'garmin' },
    ]);
    expect(t.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(t[0].trend).toBe(70);
    expect(t[1].trend).toBeCloseTo(70.2, 10);
    expect(t[2].trend).toBeCloseTo(70.28, 10);
  });

  it('la tendenza riduce il rumore delle pesate', () => {
    const noise = (i: number) => 0.4 * Math.sin(i * 2.1) + 0.25 * Math.cos(i * 5.3);
    const t = weightTrend(series(28, (i) => 75 + noise(i), () => 2500).weights);
    const raw = t.slice(10).map((p) => p.kg);
    const tr = t.slice(10).map((p) => p.trend);
    const sd = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + (x - a.reduce((q, y) => q + y, 0) / a.length) ** 2, 0) / a.length);
    expect(sd(tr)).toBeLessThan(sd(raw) / 2);
  });

  it('somma le kcal del diario per giorno', () => {
    const it = (kcal: number) => ({ name: 'x', grams: 100, nutrients: { kcal, protein: 0, carbs: 0, fat: 0 }, source: 'ciqual' as const });
    const log: FoodLogEntry[] = [
      { date: '2026-01-01', time: '08:00', slot: 'colazione', items: [it(300), it(100)], method: 'manuale', createdAt: '' },
      { date: '2026-01-01', time: '13:00', slot: 'pranzo', items: [it(700)], method: 'foto', createdAt: '' },
      { date: '2026-01-02', time: '20:00', slot: 'cena', items: [it(650)], method: 'testo', createdAt: '' },
    ];
    expect(dailyIntake(log)).toEqual([
      { date: '2026-01-01', kcal: 1100 },
      { date: '2026-01-02', kcal: 650 },
    ]);
  });
});

describe('weeklyCheckIn: proposta del lunedi', () => {
  it('peso stabile e 2600 kcal: dispendio reale 2600, nuovo 0,7 x 2400 + 0,3 x 2600 = 2460', () => {
    const { weights, intake } = series(28, () => 75, () => 2600);
    const r = weeklyCheckIn(baseInput({ weights, intake }));
    expect(r.status).toBe('proposta');
    if (r.status !== 'proposta') return;
    expect(r.monday).toBe(MONDAY);
    expect(r.window).toEqual({ from: day(7), to: day(27), days: 21 });
    expect(r.avgKcal).toBe(2600);
    expect(r.measuredTdee).toBe(2600);
    expect(r.newTdee).toBe(2460);
    expect(r.kcalTarget).toBe(2460);
    expect(r.limitedBy).toEqual([]);
    expect(r.reason).not.toMatch(/\n|[\u2013\u2014]/);
  });

  it('crescita lineare di 0,02 kg al giorno in massa: valori dalla tendenza, ritmo in linea', () => {
    const kg = (i: number) => 75 + 0.02 * i;
    const { weights, intake } = series(28, kg, () => 2800);
    const r = weeklyCheckIn(baseInput({ weights, intake, previousTdee: 2600, goal: 'massa', experience: 'nuovo' }));
    expect(r.status).toBe('proposta');
    if (r.status !== 'proposta') return;
    const tr = ema(Array.from({ length: 28 }, (_, i) => kg(i)));
    const dT = tr[27] - tr[6];
    const measured = 2800 - (dT * 7700) / 21;
    expect(r.trendChangeKg).toBeCloseTo(dT, 3);
    expect(r.measuredTdee).toBe(Math.round(measured)); // circa 2677
    expect(r.newTdee).toBe(Math.round(0.7 * 2600 + 0.3 * measured)); // circa 2623
    expect(r.kcalTarget).toBe(Math.round((0.7 * 2600 + 0.3 * measured) * 1.075));
    expect(r.ratePctPerMonth).toBeCloseTo((dT / tr[6]) * (30.44 / 21) * 100, 2);
    expect(r.rateStatus).toBe('in linea');
  });

  it('crescita troppo veloce in massa: segnala il ritmo sopra l obiettivo', () => {
    const { weights, intake } = series(28, (i) => 75 + 0.06 * i, () => 3200);
    const r = weeklyCheckIn(baseInput({ weights, intake, previousTdee: 2600, goal: 'massa', experience: 'nuovo' }));
    expect(r.status).toBe('proposta');
    if (r.status !== 'proposta') return;
    expect(r.rateStatus).toBe('sopra');
    expect(r.reason).toMatch(/sopra/);
  });

  it('variazione massima +150 kcal a settimana', () => {
    const { weights, intake } = series(28, () => 75, () => 3500);
    const r = weeklyCheckIn(baseInput({ weights, intake }));
    expect(r.status === 'proposta' && r.newTdee).toBe(2550);
    expect(r.status === 'proposta' && r.limitedBy).toEqual(['max-150']);
  });

  it('variazione massima -150 kcal e mai sotto il basale', () => {
    const { weights, intake } = series(28, () => 60, () => 1200);
    const r = weeklyCheckIn(baseInput({ weights, intake, previousTdee: 1800, bmr: 1700 }));
    expect(r.status).toBe('proposta');
    if (r.status !== 'proposta') return;
    expect(r.newTdee).toBe(1700);
    expect(r.limitedBy).toEqual(['max-150', 'bmr']);
    const def = weeklyCheckIn(baseInput({ weights, intake, previousTdee: 1800, bmr: 1700, goal: 'definizione' }));
    expect(def.status === 'proposta' && def.kcalTarget).toBe(1700); // 1700 x 0,85 sarebbe sotto il basale
  });

  it('con il rumore delle pesate la proposta resta stabile', () => {
    const noise = (i: number) => 0.5 * Math.sin(i * 1.7) + 0.3 * Math.cos(i * 4.1);
    const { weights, intake } = series(28, (i) => 75 + noise(i), () => 2600);
    const r = weeklyCheckIn(baseInput({ weights, intake }));
    expect(r.status).toBe('proposta');
    if (r.status !== 'proposta') return;
    expect(Math.abs(r.newTdee - 2460)).toBeLessThanOrEqual(80);
  });

  it('a meta settimana la proposta e quella del lunedi', () => {
    const { weights, intake } = series(31, () => 75, () => 2600);
    const a = weeklyCheckIn(baseInput({ weights, intake }));
    const b = weeklyCheckIn(baseInput({ weights, intake, asOf: '2026-10-08' }));
    expect(b).toEqual(a);
  });
});

describe('weeklyCheckIn: dati insufficienti', () => {
  it('ignora la prima settimana: servono 14 giorni dopo', () => {
    const { weights, intake } = series(14, () => 75, () => 2600);
    const r = weeklyCheckIn(baseInput({ weights, intake, asOf: '2026-09-21' }));
    expect(r.status).toBe('dati-insufficienti');
    if (r.status !== 'dati-insufficienti') return;
    expect(r.missing.join(' ')).toMatch(/prima settimana/);
  });

  it('meno di 5 pesate negli ultimi 7 giorni', () => {
    const { weights, intake } = series(28, () => 75, () => 2600, [21, 23, 25]);
    const r = weeklyCheckIn(baseInput({ weights, intake }));
    expect(r.status).toBe('dati-insufficienti');
    if (r.status !== 'dati-insufficienti') return;
    expect(r.missing.join(' ')).toMatch(/4 pesate/);
  });

  it('meno di 5 giorni registrati negli ultimi 7', () => {
    const { weights, intake } = series(28, () => 75, (i) => (i >= 21 && i % 2 === 0 ? undefined : 2600));
    const r = weeklyCheckIn(baseInput({ weights, intake }));
    expect(r.status).toBe('dati-insufficienti');
    if (r.status !== 'dati-insufficienti') return;
    expect(r.missing.join(' ')).toMatch(/giorni registrati/);
  });

  it('i giorni registrati a meta (meno di meta del basale) non contano', () => {
    const { weights, intake } = series(28, () => 75, (i) => (i >= 24 ? 600 : 2600));
    const r = weeklyCheckIn(baseInput({ weights, intake }));
    expect(r.status).toBe('dati-insufficienti');
    if (r.status !== 'dati-insufficienti') return;
    expect(r.missing.join(' ')).toMatch(/incomplet/);
  });

  it('nessun dato: dice cosa manca', () => {
    const r = weeklyCheckIn(baseInput({}));
    expect(r.status).toBe('dati-insufficienti');
    if (r.status !== 'dati-insufficienti') return;
    expect(r.reason.length).toBeGreaterThan(10);
    expect(r.missing.length).toBeGreaterThan(0);
  });
});
