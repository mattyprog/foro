import { describe, expect, it } from 'vitest';
import type { WellnessDay } from '../../db/types';
import { addDays } from '../training/dates';
import { SAFETY_MESSAGE, computeReadiness, declaredFeeling, readinessSeries } from './readiness';

const TODAY = '2026-11-23';
const WIGGLE = [0, 2, -2, 1, -1, 3, -3];
const H = 3600;

const day = (offset: number, f: Partial<WellnessDay> = {}): WellnessDay => ({
  date: addDays(TODAY, offset),
  source: 'garmin',
  ...f,
});

/** Giorni stabili dall'offset -from all'offset -to (inclusi): HRV attorno a 55 (normale 51-59), FC a riposo attorno a 52, sonno 7,5 h. */
function stable(from: number, to = 1): WellnessDay[] {
  const out: WellnessDay[] = [];
  for (let i = from; i >= to; i--) {
    out.push(day(-i, { hrvNightAvg: 55 + WIGGLE[i % 7], restingHr: 52 + [0, 1, -1, 0, 1, -1, 0][i % 7], sleepSec: 7.5 * H }));
  }
  return out;
}

/** Giorni identici: HRV 55, FC a riposo 52, sonno 7,5 h. */
function flat(from: number, to = 1): WellnessDay[] {
  const out: WellnessDay[] = [];
  for (let i = from; i >= to; i--) out.push(day(-i, { hrvNightAvg: 55, restingHr: 52, sleepSec: 7.5 * H }));
  return out;
}

const normalToday = (f: Partial<WellnessDay> = {}) => day(0, { hrvNightAvg: 56, restingHr: 52, sleepSec: 7.5 * H, ...f });

describe('imparando', () => {
  it('senza dati: sto ancora imparando i tuoi valori', () => {
    const r = computeReadiness([], TODAY);
    expect(r).toMatchObject({ livello: 'imparando', consiglio: 'normale', suggerisciDeload: false });
    expect(r.motivo).toBe('Sto ancora imparando i tuoi valori: ho 0 giorni di dati su 14.');
    expect(r.dettagli).toMatchObject({ imparando: true, giorniDati: 0, giorniNecessari: 14 });
  });

  it('prima di 14 giorni di dati non decide dai confronti personali', () => {
    const r = computeReadiness([...stable(13, 1), normalToday({ hrvNightAvg: 30, restingHr: 70 })], TODAY);
    expect(r.livello).toBe('imparando');
    expect(r.motivo).toBe('Sto ancora imparando i tuoi valori: ho 13 giorni di dati su 14.');
    expect(r.dettagli.hrv?.intervallo).toBeUndefined();
    expect(r.dettagli.fcRiposo?.media7).toBeUndefined();
  });

  it('un solo giorno: singolare', () => {
    const r = computeReadiness([day(-1, { hrvNightAvg: 55 })], TODAY);
    expect(r.motivo).toBe('Sto ancora imparando i tuoi valori: ho 1 giorno di dati su 14.');
  });

  it('a 14 giorni le basi sono pronte e il semaforo decide', () => {
    const ok = computeReadiness([...stable(14, 1), normalToday()], TODAY);
    expect(ok.livello).toBe('verde');
    expect(ok.dettagli.imparando).toBe(false);
    const low = computeReadiness([...stable(14, 1), normalToday({ hrvNightAvg: 40 })], TODAY);
    expect(low.livello).toBe('giallo');
  });

  it('il sonno sotto le 6 ore vale anche mentre impara: non ha bisogno di una base', () => {
    const r = computeReadiness([...stable(5, 1), normalToday({ sleepSec: 5 * H })], TODAY);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero' });
    expect(r.dettagli.imparando).toBe(true);
    expect(r.motivo).toBe('Hai dormito 5 h 00 min: oggi seduta leggera.');
  });

  it('anche la sensazione dichiarata vale subito', () => {
    const r = computeReadiness([day(0, { energy: 2 })], TODAY);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero' });
    expect(r.motivo).toBe('Hai segnato poca energia: oggi seduta leggera.');
  });
});

describe('verde', () => {
  it('tutto nella norma: allenamento come da piano', () => {
    const r = computeReadiness([...stable(21, 1), normalToday()], TODAY);
    expect(r).toMatchObject({ livello: 'verde', consiglio: 'normale', suggerisciDeload: false });
    expect(r.motivo).toBe('Sonno, HRV e FC a riposo nella norma: allenamento come da piano.');
    expect(r.dettagli.segnali).toEqual([]);
    expect(r.dettagli.mancanti).toEqual([]);
    expect(r.dettagli.giorniGialli).toBe(0);
  });

  it('una piccola variazione dell\'HRV dentro l\'intervallo non allarma', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ hrvNightAvg: 52 })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.hrv).toMatchObject({ valore: 52, sotto: false, giorniSotto: 0 });
    expect(r.dettagli.hrv?.intervallo).toEqual({ min: 51, max: 59, centro: 55 });
  });

  it('un valore alto non è un problema: contano solo i valori sotto l\'intervallo', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ hrvNightAvg: 80 })], TODAY);
    expect(r.livello).toBe('verde');
  });
});

describe('sonno', () => {
  it('sotto le 6 ore: seduta leggera', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ sleepSec: 5.5 * H })], TODAY);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero', suggerisciDeload: false });
    expect(r.motivo).toBe('Hai dormito 5 h 30 min: oggi seduta leggera.');
    expect(r.dettagli.sonno).toEqual({ ore: 5.5, sogliaOre: 6, sotto: true });
    expect(r.dettagli.segnali).toEqual([{ id: 'sonno', testo: 'Hai dormito 5 h 30 min' }]);
  });

  it('esattamente 6 ore va bene, 5 ore e 59 minuti no (e si scrive 5 h 59 min, non 6 h 00)', () => {
    expect(computeReadiness([...stable(21, 1), normalToday({ sleepSec: 6 * H })], TODAY).livello).toBe('verde');
    const r = computeReadiness([...stable(21, 1), normalToday({ sleepSec: 6 * H - 1 })], TODAY);
    expect(r.livello).toBe('giallo');
    expect(r.motivo).toBe('Hai dormito 5 h 59 min: oggi seduta leggera.');
  });

  it('la soglia si può cambiare', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ sleepSec: 6.5 * H })], TODAY, { sleepMinHours: 7 });
    expect(r.livello).toBe('giallo');
  });

  it('sonno mancante: non conta e non viene inventato', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ sleepSec: undefined })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.sonno).toBeUndefined();
    expect(r.dettagli.mancanti).toEqual(['sonno']);
    expect(r.motivo).toBe('HRV e FC a riposo nella norma: allenamento come da piano.');
  });
});

describe('HRV', () => {
  it('sotto il proprio intervallo normale: seduta leggera, senza scarico al primo giorno', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ hrvNightAvg: 44 })], TODAY);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero', suggerisciDeload: false });
    expect(r.motivo).toBe("L'HRV (44 ms) è sotto il tuo intervallo di 51-59 ms: oggi seduta leggera.");
    expect(r.dettagli.hrv).toMatchObject({ valore: 44, sotto: true, giorniSotto: 1 });
  });

  function lowFor(days: number, extra: Partial<WellnessDay> = {}): WellnessDay[] {
    const lows = [46, 45, 44, 43, 44];
    const out = stable(21, days);
    for (let k = days - 1; k >= 1; k--) out.push(day(-k, { hrvNightAvg: lows[k], restingHr: 52, sleepSec: 7.5 * H }));
    out.push(normalToday({ hrvNightAvg: 44, ...extra }));
    return out;
  }

  it('due giorni sotto: ancora solo leggero', () => {
    const r = computeReadiness(lowFor(2), TODAY);
    expect(r.dettagli.hrv?.giorniSotto).toBe(2);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero', suggerisciDeload: false });
  });

  it('da 3 giorni o più si propone la settimana di scarico', () => {
    const r = computeReadiness(lowFor(3), TODAY);
    expect(r.dettagli.hrv?.giorniSotto).toBe(3);
    expect(r.suggerisciDeload).toBe(true);
    expect(r.livello).toBe('giallo');
    expect(r.consiglio).toBe('leggero');
    expect(r.motivo).toBe("L'HRV è sotto il tuo intervallo da 3 giorni: oggi seduta leggera. Ti propongo una settimana di scarico.");
    const longer = computeReadiness(lowFor(5), TODAY);
    expect(longer.dettagli.hrv?.giorniSotto).toBe(5);
    expect(longer.suggerisciDeload).toBe(true);
  });

  it('un giorno normale in mezzo interrompe la serie', () => {
    const days = [
      ...stable(21, 4),
      day(-3, { hrvNightAvg: 44, restingHr: 52, sleepSec: 7.5 * H }),
      day(-2, { hrvNightAvg: 56, restingHr: 52, sleepSec: 7.5 * H }),
      day(-1, { hrvNightAvg: 44, restingHr: 52, sleepSec: 7.5 * H }),
      normalToday({ hrvNightAvg: 44 }),
    ];
    const r = computeReadiness(days, TODAY);
    expect(r.dettagli.hrv?.giorniSotto).toBe(2);
    expect(r.suggerisciDeload).toBe(false);
  });

  it('un giorno senza HRV interrompe la serie: il dato che manca non conta come "sotto"', () => {
    const days = [
      ...stable(21, 4),
      day(-3, { hrvNightAvg: 44, restingHr: 52, sleepSec: 7.5 * H }),
      day(-2, { restingHr: 52, sleepSec: 7.5 * H }),
      day(-1, { hrvNightAvg: 44, restingHr: 52, sleepSec: 7.5 * H }),
      normalToday({ hrvNightAvg: 44 }),
    ];
    expect(computeReadiness(days, TODAY).dettagli.hrv?.giorniSotto).toBe(2);
  });

  it('HRV di oggi mancante: la regola non scatta', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ hrvNightAvg: undefined })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.mancanti).toEqual(['HRV']);
    expect(r.dettagli.hrv).toBeUndefined();
  });

  it('con meno di 10 valori di HRV nei 21 giorni non c\'è un intervallo e non si giudica', () => {
    const sparse = stable(21, 1).map((d, i) => (i % 3 === 0 ? d : { ...d, hrvNightAvg: undefined }));
    const r = computeReadiness([...sparse, normalToday({ hrvNightAvg: 30 })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.hrv).toMatchObject({ valore: 30, sotto: false });
    expect(r.dettagli.hrv?.intervallo).toBeUndefined();
  });
});

describe('FC a riposo', () => {
  it('oltre 5 battiti sopra la media dei 7 giorni per 2 giorni: seduta leggera e si chiede come ti senti', () => {
    const days = [...flat(21, 2), day(-1, { hrvNightAvg: 55, restingHr: 58, sleepSec: 7.5 * H }), normalToday({ hrvNightAvg: 55, restingHr: 59 })];
    const r = computeReadiness(days, TODAY);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero', suggerisciDeload: false });
    expect(r.motivo).toBe('La FC a riposo è 7 battiti sopra la tua media da 2 giorni: oggi seduta leggera. Come ti senti?');
    expect(r.dettagli.domanda).toBe('Come ti senti oggi?');
    expect(r.dettagli.fcRiposo).toEqual({ oggi: 59, ieri: 58, media7: 52, sopraOggi: 7, sopraIeri: 6, elevata: true });
  });

  it('se hai già detto come ti senti non si chiede di nuovo', () => {
    const days = [...flat(21, 2), day(-1, { hrvNightAvg: 55, restingHr: 58, sleepSec: 7.5 * H }), normalToday({ hrvNightAvg: 55, restingHr: 59, energy: 3 })];
    const r = computeReadiness(days, TODAY);
    expect(r.livello).toBe('giallo');
    expect(r.dettagli.domanda).toBeUndefined();
    expect(r.motivo).not.toMatch(/Come ti senti/);
  });

  it('esattamente 5 battiti sopra non basta: serve oltre', () => {
    const days = [...flat(21, 2), day(-1, { hrvNightAvg: 55, restingHr: 57, sleepSec: 7.5 * H }), normalToday({ hrvNightAvg: 55, restingHr: 57 })];
    const r = computeReadiness(days, TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.fcRiposo).toMatchObject({ elevata: false, sopraOggi: 5, sopraIeri: 5 });
  });

  it('un solo giorno alto non basta', () => {
    const days = [...flat(21, 2), day(-1, { hrvNightAvg: 55, restingHr: 52, sleepSec: 7.5 * H }), normalToday({ hrvNightAvg: 55, restingHr: 62 })];
    expect(computeReadiness(days, TODAY).livello).toBe('verde');
  });

  it('se ieri manca il dato, non si può dire "da 2 giorni": la regola non scatta', () => {
    const days = [...flat(21, 2), day(-1, { hrvNightAvg: 55, sleepSec: 7.5 * H }), normalToday({ hrvNightAvg: 55, restingHr: 62 })];
    const r = computeReadiness(days, TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.fcRiposo?.ieri).toBeUndefined();
  });

  it('senza abbastanza giorni di riferimento (meno di 4 su 7) non si confronta', () => {
    const sparse = flat(21, 2).map((d, i, all) => (all.length - i <= 7 && i % 3 !== 0 ? { ...d, restingHr: undefined } : d));
    const days = [...sparse, day(-1, { hrvNightAvg: 55, restingHr: 60, sleepSec: 7.5 * H }), normalToday({ hrvNightAvg: 55, restingHr: 60 })];
    const r = computeReadiness(days, TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.fcRiposo?.media7).toBeUndefined();
  });

  it('la FC di oggi mancante: non conta', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ restingHr: undefined })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.mancanti).toEqual(['FC a riposo']);
  });
});

describe('più segnali insieme', () => {
  it('sonno corto e HRV bassa: giallo, con tutti i motivi in una riga', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ sleepSec: 5 * H, hrvNightAvg: 44 })], TODAY);
    expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero' });
    expect(r.motivo).toBe("Hai dormito 5 h 00 min e l'HRV (44 ms) è sotto il tuo intervallo di 51-59 ms: oggi seduta leggera.");
    expect(r.dettagli.segnali.map((s) => s.id)).toEqual(['sonno', 'hrv']);
  });

  it('HRV bassa da 3 giorni vale due punti: con il sonno corto è rosso; da 2 giorni resta giallo', () => {
    const lows = (n: number): WellnessDay[] => {
      const out = stable(21, n);
      for (let k = n - 1; k >= 1; k--) out.push(day(-k, { hrvNightAvg: 44 + k, restingHr: 52, sleepSec: 7.5 * H }));
      out.push(normalToday({ hrvNightAvg: 44, sleepSec: 5 * H }));
      return out;
    };
    const three = computeReadiness(lows(3), TODAY);
    expect(three).toMatchObject({ livello: 'rosso', consiglio: 'riposo', suggerisciDeload: true });
    expect(three.motivo).toBe(
      "Hai dormito 5 h 00 min e l'HRV è sotto il tuo intervallo da 3 giorni: oggi riposo o una passeggiata. Ti propongo una settimana di scarico.",
    );
    const two = computeReadiness(lows(2), TODAY);
    expect(two).toMatchObject({ livello: 'giallo', consiglio: 'leggero', suggerisciDeload: false });
  });

  it('sonno corto, HRV bassa da 3 giorni e FC a riposo alta: rosso, riposo', () => {
    const days = [
      ...stable(21, 3),
      day(-2, { hrvNightAvg: 44, restingHr: 58, sleepSec: 7.5 * H }),
      day(-1, { hrvNightAvg: 45, restingHr: 59, sleepSec: 7.5 * H }),
      normalToday({ hrvNightAvg: 46, restingHr: 60, sleepSec: 5 * H }),
    ];
    const r = computeReadiness(days, TODAY);
    expect(r).toMatchObject({ livello: 'rosso', consiglio: 'riposo', suggerisciDeload: true });
    expect(r.motivo).toMatch(/^Hai dormito 5 h 00 min, l'HRV è sotto il tuo intervallo da 3 giorni e la FC a riposo è \d+ battiti sopra la tua media da 2 giorni: oggi riposo o una passeggiata\./);
    expect(r.motivo).toMatch(/Ti propongo una settimana di scarico\. Come ti senti\?$/);
    expect(r.dettagli.segnali.map((s) => s.id)).toEqual(['sonno', 'hrv', 'fc-riposo']);
  });
});

describe('la sensazione dichiarata vince sui numeri', () => {
  it('declaredFeeling: classi e dati fuori scala', () => {
    const f = (x: Partial<WellnessDay>) => declaredFeeling(day(0, x));
    expect(declaredFeeling(undefined)).toBeUndefined();
    expect(f({})).toBeUndefined();
    expect(f({ energy: 0, mood: 7, soreness: 9 })).toBeUndefined(); // fuori da 1-5: ignorati
    expect(f({ energy: 5 })).toBe('bene');
    expect(f({ mood: 4 })).toBe('bene');
    expect(f({ energy: 4, mood: 4, soreness: 2 })).toBe('bene');
    expect(f({ energy: 3, mood: 3, soreness: 2 })).toBe('normale');
    expect(f({ soreness: 1 })).toBe('normale'); // il solo indolenzimento basso non dice che stai bene
    expect(f({ energy: 2 })).toBe('male');
    expect(f({ soreness: 4 })).toBe('male');
    expect(f({ mood: 2 })).toBe('male');
    expect(f({ energy: 5, soreness: 4 })).toBe('male'); // se qualcosa va male, non è "bene"
    expect(f({ energy: 1 })).toBe('molto-male');
    expect(f({ soreness: 5 })).toBe('molto-male');
    expect(f({ energy: 2, mood: 2 })).toBe('molto-male');
  });

  it('stai bene: verde anche con sonno corto e HRV bassa, e niente scarico', () => {
    const days = [
      ...stable(21, 3),
      day(-2, { hrvNightAvg: 44, restingHr: 52, sleepSec: 7.5 * H }),
      day(-1, { hrvNightAvg: 45, restingHr: 52, sleepSec: 7.5 * H }),
      normalToday({ hrvNightAvg: 46, sleepSec: 4 * H, energy: 5, mood: 4, soreness: 1 }),
    ];
    const r = computeReadiness(days, TODAY);
    expect(r).toMatchObject({ livello: 'verde', consiglio: 'normale', suggerisciDeload: false });
    expect(r.dettagli.sensazione).toBe('bene');
    expect(r.motivo).toBe("Ti senti bene, quindi vai col piano, anche se hai dormito 4 h 00 min e l'HRV è sotto il tuo intervallo da 3 giorni.");
  });

  it('stai bene e i numeri sono a posto', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ energy: 4 })], TODAY);
    expect(r).toMatchObject({ livello: 'verde', consiglio: 'normale' });
    expect(r.motivo).toBe('Ti senti bene e i dati sono nella norma: allenamento come da piano.');
  });

  it('stai bene senza altri dati (anche mentre impara)', () => {
    const r = computeReadiness([day(0, { mood: 5 })], TODAY);
    expect(r).toMatchObject({ livello: 'verde', consiglio: 'normale' });
    expect(r.motivo).toBe('Ti senti bene: allenamento come da piano.');
  });

  it('stai male con numeri perfetti: almeno giallo', () => {
    for (const feeling of [{ energy: 2 }, { soreness: 4 }, { mood: 2 }]) {
      const r = computeReadiness([...stable(21, 1), normalToday(feeling)], TODAY);
      expect(r).toMatchObject({ livello: 'giallo', consiglio: 'leggero' });
      expect(r.dettagli.segnali.map((s) => s.id)).toEqual(['sensazione']);
    }
    expect(computeReadiness([...stable(21, 1), normalToday({ energy: 2 })], TODAY).motivo).toBe('Hai segnato poca energia: oggi seduta leggera.');
    expect(computeReadiness([...stable(21, 1), normalToday({ soreness: 4 })], TODAY).motivo).toBe('Hai segnato i muscoli molto indolenziti: oggi seduta leggera.');
    expect(computeReadiness([...stable(21, 1), normalToday({ mood: 2 })], TODAY).motivo).toBe("Hai segnato l'umore basso: oggi seduta leggera.");
  });

  it('stai molto male: rosso, riposo o una passeggiata', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ energy: 1 })], TODAY);
    expect(r).toMatchObject({ livello: 'rosso', consiglio: 'riposo' });
    expect(r.motivo).toBe('Hai segnato molta stanchezza: oggi riposo o una passeggiata.');
    expect(computeReadiness([...stable(21, 1), normalToday({ soreness: 5 })], TODAY).motivo).toBe(
      'Hai segnato i muscoli molto indolenziti: oggi riposo o una passeggiata.',
    );
  });

  it('stai male e anche i numeri lo dicono: resta il livello più alto dei numeri', () => {
    const days = [
      ...stable(21, 3),
      day(-2, { hrvNightAvg: 44, restingHr: 58, sleepSec: 7.5 * H }),
      day(-1, { hrvNightAvg: 45, restingHr: 59, sleepSec: 7.5 * H }),
      normalToday({ hrvNightAvg: 46, restingHr: 60, sleepSec: 5 * H, energy: 2 }),
    ];
    const r = computeReadiness(days, TODAY);
    expect(r.livello).toBe('rosso');
    expect(r.dettagli.domanda).toBeUndefined();
    expect(r.motivo).toMatch(/^Hai segnato poca energia, hai dormito 5 h 00 min, l'HRV è sotto/);
  });
});

describe('contesto: Body Battery e stress non decidono', () => {
  it('compaiono nei dettagli e non cambiano il livello', () => {
    const r = computeReadiness([...stable(21, 1), normalToday({ bodyBatteryLow: 5, bodyBatteryHigh: 30, stressAvg: 80 })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.dettagli.contesto).toEqual(['Body Battery da 5 a 30', 'Stress medio 80']);
  });

  it('nemmeno insieme a un segnale vero cambiano il livello', () => {
    const base = computeReadiness([...stable(21, 1), normalToday({ sleepSec: 5 * H })], TODAY);
    const withContext = computeReadiness([...stable(21, 1), normalToday({ sleepSec: 5 * H, bodyBatteryHigh: 95, stressAvg: 10 })], TODAY);
    expect(withContext.livello).toBe(base.livello);
    expect(withContext.motivo).toBe(base.motivo);
    expect(withContext.dettagli.contesto).toEqual(['Body Battery massimo 95', 'Stress medio 10']);
  });

  it('senza dati niente contesto', () => {
    expect(computeReadiness([...stable(21, 1), normalToday()], TODAY).dettagli.contesto).toEqual([]);
  });
});

describe('dati mancanti', () => {
  it('niente dati di oggi con le basi pronte: verde, e lo dice', () => {
    const r = computeReadiness(stable(21, 1), TODAY);
    expect(r).toMatchObject({ livello: 'verde', consiglio: 'normale', suggerisciDeload: false });
    expect(r.motivo).toBe('Mancano i dati di oggi: vai con il piano e ascolta come ti senti.');
    expect(r.dettagli.mancanti).toEqual(['sonno', 'HRV', 'FC a riposo']);
  });

  it('dati parziali: si valutano solo quelli che ci sono', () => {
    const r = computeReadiness([...stable(21, 1), day(0, { sleepSec: 7 * H })], TODAY);
    expect(r.livello).toBe('verde');
    expect(r.motivo).toBe('Sonno nella norma: allenamento come da piano.');
    expect(r.dettagli.mancanti).toEqual(['HRV', 'FC a riposo']);
  });

  it('un giorno con HRV ma senza intervallo calcolabile non produce frasi false', () => {
    const r = computeReadiness([...stable(21, 1).map((d) => ({ ...d, hrvNightAvg: undefined })), day(0, { hrvNightAvg: 50 })], TODAY);
    expect(r.motivo).toBe('Nessun segnale di stanchezza nei dati che ho: allenamento come da piano.');
  });

  it('i giorni futuri e i duplicati non rompono nulla', () => {
    const days = [
      ...stable(21, 1),
      day(1, { sleepSec: 3 * H }),
      day(5, { hrvNightAvg: 10 }),
      normalToday({ sleepSec: undefined }),
      { date: TODAY, source: 'manuale' as const, sleepSec: 5 * H, energy: 2 },
    ];
    const r = computeReadiness(days, TODAY);
    expect(r.dettagli.sonno?.ore).toBe(5);
    expect(r.dettagli.sensazione).toBe('male');
    expect(r.livello).toBe('giallo');
  });

  it('l\'ordine dei giorni in ingresso non conta', () => {
    const days = [...stable(21, 1), normalToday({ sleepSec: 5 * H })];
    const a = computeReadiness(days, TODAY);
    const b = computeReadiness([...days].reverse(), TODAY);
    expect(b).toEqual(a);
  });
});

describe('scarico per semaforo giallo prolungato', () => {
  function yellowRun(count: number): WellnessDay[] {
    const days = stable(21, count);
    for (let k = count - 1; k >= 1; k--) days.push(day(-k, { hrvNightAvg: 55, restingHr: 52, sleepSec: 5 * H }));
    days.push(normalToday({ sleepSec: 5 * H }));
    return days;
  }

  it('sette giorni di fila gialli: si propone lo scarico', () => {
    const r = computeReadiness(yellowRun(7), TODAY);
    expect(r.dettagli.giorniGialli).toBe(7);
    expect(r.suggerisciDeload).toBe(true);
    expect(r.motivo).toBe('Hai dormito 5 h 00 min: oggi seduta leggera. Ti propongo una settimana di scarico.');
  });

  it('sei giorni non bastano', () => {
    const r = computeReadiness(yellowRun(6), TODAY);
    expect(r.dettagli.giorniGialli).toBe(6);
    expect(r.suggerisciDeload).toBe(false);
  });

  it('un giorno verde interrompe la serie', () => {
    const days = yellowRun(7).map((d) => (d.date === addDays(TODAY, -3) ? { ...d, sleepSec: 8 * H } : d));
    const r = computeReadiness(days, TODAY);
    expect(r.dettagli.giorniGialli).toBe(3);
    expect(r.suggerisciDeload).toBe(false);
  });

  it('la serie si può cambiare', () => {
    expect(computeReadiness(yellowRun(4), TODAY, { yellowDeloadDays: 4 }).suggerisciDeload).toBe(true);
  });
});

describe('readinessSeries', () => {
  it('il semaforo degli ultimi giorni, dal più vecchio a oggi', () => {
    const days = [...stable(21, 3), day(-2, { hrvNightAvg: 55, restingHr: 52, sleepSec: 5 * H }), day(-1, { hrvNightAvg: 55, restingHr: 52, sleepSec: 7.5 * H }), normalToday({ energy: 1 })];
    const s = readinessSeries(days, TODAY, 4);
    expect(s.map((x) => x.date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
    expect(s.map((x) => x.livello)).toEqual(['verde', 'giallo', 'verde', 'rosso']);
    expect(s.map((x) => x.consiglio)).toEqual(['normale', 'leggero', 'normale', 'riposo']);
    expect(readinessSeries(days, TODAY)).toHaveLength(7);
  });
});

describe('testi: una riga, in italiano, senza diagnosi né rimproveri', () => {
  it('in tutte le situazioni', () => {
    const scenarios: WellnessDay[][] = [
      [],
      stable(21, 1),
      [...stable(21, 1), normalToday()],
      [...stable(21, 1), normalToday({ sleepSec: 5 * H })],
      [...stable(21, 1), normalToday({ hrvNightAvg: 40 })],
      [...stable(21, 1), normalToday({ energy: 1 })],
      [...stable(21, 1), normalToday({ soreness: 4 })],
      [...stable(21, 1), normalToday({ sleepSec: 4 * H, hrvNightAvg: 40, energy: 5 })],
      [...flat(21, 2), day(-1, { hrvNightAvg: 55, restingHr: 60, sleepSec: 7.5 * H }), normalToday({ restingHr: 61 })],
      [...stable(5, 1), normalToday({ sleepSec: 5 * H })],
    ];
    for (const days of scenarios) {
      const r = computeReadiness(days, TODAY);
      expect(r.motivo.length).toBeGreaterThan(10);
      expect(r.motivo.length).toBeLessThan(260);
      expect(r.motivo).not.toMatch(/\n/);
      expect(r.motivo).not.toMatch(/[—–]/);
      expect(r.motivo).not.toMatch(/aritmi|apnea|malattia|diagnos|farmac|medicin|infarto|colpa|dovresti|\bdevi\b|pigr|punizione/i);
      for (const s of r.dettagli.segnali) expect(s.testo).not.toMatch(/[—–\n]/);
    }
  });

  it('il messaggio fisso di sicurezza è breve e rimanda a un medico', () => {
    expect(SAFETY_MESSAGE).toMatch(/medico/);
    expect(SAFETY_MESSAGE).not.toMatch(/[—–\n]/);
  });
});
