import { describe, expect, it } from 'vitest';
import { ageOn, bmrKatchMcArdle, bmrMifflin, computeTargets, type TargetProfile } from './targets';

// Profili di prova generici (nessun dato personale reale). Valori attesi calcolati a mano.
const base: TargetProfile = {
  sex: 'M',
  birthDate: '1996-05-10',
  heightCm: 178,
  weightKg: 72,
  goal: 'massa',
  experience: 'nuovo',
  gymDaysPerWeek: 3,
  runDaysPerWeek: 2,
  dailyActivity: 'leggero',
  mealsPerDay: 5,
};
const today = '2026-11-23';

describe('formule di base', () => {
  it('eta compiuta alla data', () => {
    expect(ageOn('1996-05-10', '2026-11-23')).toBe(30);
    expect(ageOn('1996-11-24', '2026-11-23')).toBe(29);
    expect(ageOn('1996-11-23', '2026-11-23')).toBe(30);
  });

  it('Mifflin-St Jeor: uomo 72 kg, 178 cm, 30 anni = 1687,5 kcal; donna 60 kg, 165 cm, 25 anni = 1345,25', () => {
    expect(bmrMifflin({ sex: 'M', weightKg: 72, heightCm: 178, age: 30 })).toBeCloseTo(1687.5, 6);
    expect(bmrMifflin({ sex: 'F', weightKg: 60, heightCm: 165, age: 25 })).toBeCloseTo(1345.25, 6);
  });

  it('Katch-McArdle: 80 kg al 20% di grasso = 370 + 21,6 x 64 = 1752,4 kcal', () => {
    expect(bmrKatchMcArdle(80, 20)).toBeCloseTo(1752.4, 6);
  });
});

describe('computeTargets: caso completo calcolato a mano (massa, 3 palestra + 2 corse)', () => {
  const t = computeTargets(base, { today });

  it('basale, attivita, esercizio e dispendio', () => {
    expect(t.age).toBe(30);
    expect(t.bmr.formula).toBe('mifflin-st-jeor');
    expect(t.bmr.value).toBe(1688); // 1687,5
    expect(t.activityFactor.value).toBe(1.35);
    // (3 x 60 min x 4 kcal + 2 x 72 kg x 5 km) / 7 = 1440 / 7 = 205,7
    expect(t.exercise.value).toBe(206);
    // 1687,5 x 1,35 + 205,7 = 2483,8
    expect(t.tdee.value).toBe(2484);
    expect(t.tdee.measured).toBe(false);
  });

  it('surplus del 7,5% e macronutrienti', () => {
    expect(t.adjustmentPct.value).toBe(7.5);
    expect(t.average.kcal.value).toBe(2670); // 2483,8 x 1,075 = 2670,1
    expect(t.referenceWeightKg.value).toBe(72);
    expect(t.average.protein.value).toBe(130); // 1,8 x 72 = 129,6
    expect(t.average.fat.value).toBe(65); // 0,9 x 72 = 64,8
    expect(t.average.carbs.value).toBe(392); // (2670,1 - 518,4 - 583,2) / 4 = 392,1
  });

  it('tipi di giorno: proteine e grassi uguali, carboidrati che si spostano, media settimanale invariata', () => {
    const { palestra, corsa, riposo } = t.days;
    // base C = (7 x 392,13 - 2 x 90) / (3 + 2 + 2 x 0,875) = 379,99
    expect(palestra.carbs.value).toBe(380);
    expect(corsa.carbs.value).toBe(470); // + 72 kg x 5 km / 4 = 90 g
    expect(riposo.carbs.value).toBe(332); // -12,5%
    expect(palestra.kcal.value).toBe(2622);
    expect(corsa.kcal.value).toBe(2982);
    expect(riposo.kcal.value).toBe(2432);
    for (const d of [palestra, corsa, riposo]) {
      expect(d.protein.value).toBe(130);
      expect(d.fat.value).toBe(65);
    }
    const settimana = 3 * 2621.554 + 2 * 2981.554 + 2 * 2431.56;
    expect(settimana / 7).toBeCloseTo(2670.13, 1);
  });

  it('pasti all italiana: 5 pasti, quote 22,5/10/32,5/10/25 e almeno 0,4 g/kg di proteine in 4 pasti', () => {
    const meals = t.days.palestra.meals;
    expect(meals.map((m) => m.slot)).toEqual(['colazione', 'spuntino', 'pranzo', 'merenda', 'cena']);
    expect(meals.map((m) => m.share)).toEqual([0.225, 0.1, 0.325, 0.1, 0.25]);
    expect(meals.map((m) => m.kcal)).toEqual([590, 262, 852, 262, 655]);
    // 4 x 28,8 g + 14,4 g distribuiti in proporzione alle calorie
    expect(meals.map((m) => m.protein)).toEqual([32, 1, 33, 30, 32]);
    const proteici = meals.filter((m) => m.protein >= 0.4 * 72 - 0.5);
    expect(proteici.length).toBeGreaterThanOrEqual(4);
    const sum = (k: 'kcal' | 'protein' | 'carbs' | 'fat') => meals.reduce((a, m) => a + m[k], 0);
    expect(Math.abs(sum('kcal') - 2622)).toBeLessThanOrEqual(3);
    expect(Math.abs(sum('carbs') - 380)).toBeLessThanOrEqual(3);
    expect(Math.abs(sum('fat') - 65)).toBeLessThanOrEqual(3);
  });

  it('obiettivo di crescita per un principiante: 0,75% del peso al mese', () => {
    expect(t.monthlyGainKg?.value).toBeCloseTo(0.54, 2);
  });

  it('ogni numero ha una spiegazione breve in italiano, senza lineette lunghe', () => {
    const whys = [
      t.bmr.why, t.activityFactor.why, t.exercise.why, t.tdee.why, t.adjustmentPct.why, t.referenceWeightKg.why,
      t.average.kcal.why, t.average.protein.why, t.average.fat.why, t.average.carbs.why,
      ...Object.values(t.days).flatMap((d) => [d.kcal.why, d.carbs.why, ...d.meals.map((m) => m.why)]),
      ...t.notes,
    ];
    for (const w of whys) {
      expect(w.length).toBeGreaterThan(10);
      expect(/[\u2013\u2014]/.test(w), w).toBe(false);
    }
    expect(t.bmr.why).toMatch(/Mifflin/);
    expect(t.average.protein.why).toMatch(/1,8 g/);
  });
});

describe('computeTargets: altri casi noti', () => {
  it('Katch-McArdle con la percentuale di grasso, mantenimento', () => {
    const t = computeTargets(
      { ...base, birthDate: '1986-01-01', heightCm: 180, weightKg: 80, bodyFatPct: 20, goal: 'mantenimento',
        dailyActivity: 'moderato', gymDaysPerWeek: 4, runDaysPerWeek: 0 },
      { today },
    );
    expect(t.bmr.formula).toBe('katch-mcardle');
    expect(t.bmr.value).toBe(1752);
    expect(t.tdee.value).toBe(2766); // 1752,4 x 1,5 + 960 / 7
    expect(t.average.kcal.value).toBe(2766);
    expect(t.average.protein.value).toBe(144);
    expect(t.average.fat.value).toBe(72);
    expect(t.average.carbs.value).toBe(385);
  });

  it('BMI sopra 27 senza grasso noto: proteine e grassi sul peso di riferimento (BMI 27)', () => {
    const t = computeTargets(
      { ...base, birthDate: '1991-01-01', heightCm: 175, weightKg: 95, goal: 'definizione',
        dailyActivity: 'sedentario', gymDaysPerWeek: 3, runDaysPerWeek: 0 },
      { today },
    );
    expect(t.referenceWeightKg.value).toBe(82.7); // 27 x 1,75^2 = 82,69
    expect(t.bmr.value).toBe(1874); // Mifflin sul peso reale
    expect(t.tdee.value).toBe(2351);
    expect(t.adjustmentPct.value).toBe(-15);
    expect(t.average.kcal.value).toBe(1999);
    expect(t.average.protein.value).toBe(149);
    expect(t.average.fat.value).toBe(74);
    expect(t.average.carbs.value).toBe(183);
    expect(t.referenceWeightKg.why).toMatch(/BMI/);
  });

  it('con il grasso noto conta la percentuale, non il BMI (muscoloso con BMI 28)', () => {
    const t = computeTargets({ ...base, heightCm: 175, weightKg: 86, bodyFatPct: 14 }, { today });
    expect(t.referenceWeightKg.value).toBe(86);
  });

  it('in definizione i grassi scendono (mai sotto 0,6 g/kg) per lasciare almeno 130 g di carboidrati', () => {
    const t = computeTargets(
      { ...base, sex: 'F', birthDate: '2001-01-01', heightCm: 165, weightKg: 60, goal: 'definizione',
        dailyActivity: 'sedentario', gymDaysPerWeek: 2, runDaysPerWeek: 0 },
      { today },
    );
    expect(t.bmr.value).toBe(1345);
    expect(t.tdee.value).toBe(1683);
    expect(t.average.kcal.value).toBe(1430);
    expect(t.average.protein.value).toBe(108);
    expect(t.average.carbs.value).toBe(130);
    expect(t.average.fat.value).toBe(53); // (1430,4 - 432 - 520) / 9 = 53,2
  });

  it('se non basta, grassi a 0,6 g/kg e carboidrati il resto, con una nota', () => {
    const t = computeTargets(
      { ...base, sex: 'F', birthDate: '1976-01-01', heightCm: 155, weightKg: 50, goal: 'definizione',
        dailyActivity: 'sedentario', gymDaysPerWeek: 0, runDaysPerWeek: 0 },
      { today },
    );
    expect(t.average.kcal.value).toBe(1079);
    expect(t.average.fat.value).toBe(30);
    expect(t.average.carbs.value).toBe(112);
    expect(t.notes.join(' ')).toMatch(/0,6 g/);
  });

  it('dispendio misurato (adattamento) al posto della stima', () => {
    const t = computeTargets(base, { today, tdeeKcal: 2600 });
    expect(t.tdee.value).toBe(2600);
    expect(t.tdee.measured).toBe(true);
    expect(t.average.kcal.value).toBe(2795); // 2600 x 1,075
  });

  it('opzioni fuori intervallo vengono riportate nell intervallo con una nota', () => {
    const t = computeTargets(base, { today, proteinGPerKg: 3, adjustmentPct: 0.2 });
    expect(t.average.protein.value).toBe(158); // 2,2 x 72
    expect(t.adjustmentPct.value).toBe(10);
    expect(t.notes.length).toBeGreaterThanOrEqual(2);
  });

  it('3 pasti: colazione, pranzo e cena con almeno 0,4 g/kg ciascuno', () => {
    const t = computeTargets({ ...base, mealsPerDay: 3 }, { today });
    const meals = t.days.riposo.meals;
    expect(meals.map((m) => m.slot)).toEqual(['colazione', 'pranzo', 'cena']);
    expect(meals.reduce((a, m) => a + m.share, 0)).toBeCloseTo(1, 3);
    for (const m of meals) expect(m.protein).toBeGreaterThanOrEqual(29);
  });

  it('rifiuta profili impossibili', () => {
    expect(() => computeTargets({ ...base, weightKg: 0 }, { today })).toThrow(RangeError);
    expect(() => computeTargets({ ...base, heightCm: 20 }, { today })).toThrow(RangeError);
  });
});

describe('computeTargets: minimi per ogni tipo di giorno', () => {
  it('con tante calorie i grassi restano almeno al 20% (ISSN 20-35%)', () => {
    const t = computeTargets({ ...base, dailyActivity: 'attivo', gymDaysPerWeek: 5, runDaysPerWeek: 3 }, { today });
    for (const d of ['palestra', 'corsa', 'riposo'] as const) {
      expect((t.days[d].fat.value * 9) / t.average.kcal.value).toBeGreaterThanOrEqual(0.195);
    }
    expect(t.average.fat.why).toContain('20%');
  });

  it('in definizione con molte corse nessun giorno scende sotto il metabolismo a riposo', () => {
    const t = computeTargets({ ...base, goal: 'definizione', dailyActivity: 'sedentario', gymDaysPerWeek: 2, runDaysPerWeek: 4 }, { today });
    for (const d of ['palestra', 'corsa', 'riposo'] as const) {
      expect(t.days[d].kcal.value).toBeGreaterThanOrEqual(t.bmr.value - 1);
      if (t.average.carbs.value >= 130) expect(t.days[d].carbs.value).toBeGreaterThanOrEqual(129.5);
    }
  });
});
