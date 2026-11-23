import { describe, expect, it } from 'vitest';
import { loadBaseFoods } from './foodDb';
import { isInSeason, monthOf, seasonalFoods, seasonalProduce, seasonMonths, SEASON_SOURCE } from './season';
import { stem, tokenize } from './search';

describe('stagionalita del Lazio', async () => {
  const foods = await loadBaseFoods();
  const byId = new Map(foods.map((f) => [f.id, f]));
  const food = (id: string) => {
    const f = byId.get(id);
    if (!f) throw new Error(`manca ${id}`);
    return f;
  };

  it('ha 12 mesi con verdura e frutta e cita la fonte', () => {
    for (let m = 1; m <= 12; m++) {
      const s = seasonalProduce(m);
      expect(s.verdura.length, `mese ${m}`).toBeGreaterThan(3);
      expect(s.frutta.length, `mese ${m}`).toBeGreaterThan(1);
    }
    expect(SEASON_SOURCE).toMatch(/ARSIAL/);
    expect(() => seasonalProduce(13)).toThrow(RangeError);
  });

  it('carciofi e puntarelle d inverno, pomodori d estate', () => {
    expect(isInSeason(food('carciofi-crudi'), 11)).toBe(true);
    expect(isInSeason(food('carciofi-crudi'), 7)).toBe(false);
    expect(isInSeason(food('puntarelle-crude'), 2)).toBe(true);
    expect(isInSeason(food('puntarelle-crude'), 8)).toBe(false);
    expect(isInSeason(food('pomodori-crudi'), 7)).toBe(true);
    expect(isInSeason(food('pomodori-crudi'), 1)).toBe(false);
    expect(seasonMonths(food('fragole-crude'))).toEqual([3, 4, 5]);
  });

  it('le versioni cotte valgono, quelle conservate no', () => {
    expect(isInSeason(food('zucchine-lessate'), 6)).toBe(true);
    expect(seasonMonths(food('fagioli-borlotti-secchi'))).toEqual([]);
    expect(seasonMonths(food('fichi-secchi'))).toEqual([]);
    expect(seasonMonths(food('spinaci-surgelati-crudi'))).toEqual([]);
  });

  it('non confonde prodotti con parole in comune', () => {
    expect(seasonMonths(food('fiori-di-zucca-crudi'))).toEqual([6]);
    expect(isInSeason(food('broccoli-crudi'), 9)).toBe(false); // a settembre ci sono i broccoletti
    expect(isInSeason(food('broccoletti-cime-di-rapa-crudi'), 9)).toBe(true);
    expect(isInSeason({ name: 'Succo d arancia', category: 'Bevande' }, 1)).toBe(false);
  });

  it('ogni prodotto del calendario corrisponde ad almeno un alimento del database', () => {
    const misses: string[] = [];
    for (let m = 1; m <= 12; m++) {
      const s = seasonalProduce(m);
      for (const it of [...s.verdura, ...s.frutta]) {
        const k = tokenize(it.chiave ?? it.nome).map(stem);
        const ok = seasonalFoods(foods, m).some((f) => {
          const st = [f.name, ...(f.aliases ?? [])].map((n) => tokenize(n).map(stem));
          return st.some((x) => x[0] === k[0] && k.every((y) => x.includes(y)));
        });
        if (!ok && !misses.includes(it.nome)) misses.push(it.nome);
      }
    }
    // i cipollotti non sono nel database (CIQUAL ha solo la cipolla)
    expect(misses).toEqual(['cipollotti']);
  });

  it('mese di una data', () => {
    expect(monthOf('2026-11-23')).toBe(11);
    expect(monthOf(new Date(2026, 0, 15))).toBe(1);
  });
});
