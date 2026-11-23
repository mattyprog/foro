import { describe, expect, it } from 'vitest';
import type { GymSession, LoggedSet } from '../../db/types';
import {
  E1RM_MAX_RELIABLE_REPS,
  buildBaseline,
  describeRecord,
  detectRecords,
  detectSessionRecords,
  e1rm,
  e1rmSeries,
  estimateE1rm,
  historyForExercise,
  isWorkingSet,
  sessionTonnage,
  tonnage,
} from './records';

let seq = 0;
const set = (exerciseId: string, kg: number, reps: number, extra: Partial<LoggedSet> = {}): LoggedSet => ({
  exerciseId,
  setIndex: seq++ % 6,
  kg,
  reps,
  done: true,
  type: 'normale',
  ...extra,
});

function session(date: string, sets: LoggedSet[], extra: Partial<GymSession> & { modo?: string } = {}): GymSession {
  const { modo, ...rest } = extra;
  const s: GymSession = {
    date,
    startedAt: `${date}T18:00:00+01:00`,
    endedAt: `${date}T19:00:00+01:00`,
    sets,
    ...rest,
  };
  if (modo) (s as GymSession & { foro?: { v: 1; modo: string } }).foro = { v: 1, modo };
  return s;
}

describe('e1RM (Epley)', () => {
  it('calcola kg x (1 + ripetizioni/30)', () => {
    expect(e1rm(100, 5)).toBeCloseTo(116.67, 2);
    expect(e1rm(60, 8)).toBeCloseTo(76, 2);
    expect(e1rm(80, 10)).toBeCloseTo(106.67, 2);
  });

  it('con una sola ripetizione il massimale è il carico stesso', () => {
    expect(e1rm(120, 1)).toBe(120);
  });

  it('non inventa un valore senza carico o senza ripetizioni', () => {
    expect(e1rm(0, 10)).toBeUndefined();
    expect(e1rm(-5, 10)).toBeUndefined();
    expect(e1rm(100, 0)).toBeUndefined();
    expect(e1rm(Number.NaN, 5)).toBeUndefined();
  });

  it('segnala come inaffidabile oltre 12 ripetizioni', () => {
    expect(E1RM_MAX_RELIABLE_REPS).toBe(12);
    const ok = estimateE1rm(50, 12)!;
    expect(ok.reliable).toBe(true);
    expect(ok.warning).toBeUndefined();
    const stima = estimateE1rm(50, 15)!;
    expect(stima.reliable).toBe(false);
    expect(stima.value).toBeCloseTo(75, 2);
    expect(stima.warning).toMatch(/12/);
    expect(estimateE1rm(0, 15)).toBeUndefined();
  });
});

describe('tonnellaggio', () => {
  it('somma kg x ripetizioni delle serie fatte, escluso il riscaldamento', () => {
    const sets = [
      set('squat-bilanciere', 40, 10, { type: 'riscaldamento' }),
      set('squat-bilanciere', 60, 8),
      set('squat-bilanciere', 60, 8),
      set('squat-bilanciere', 60, 6, { done: false }),
      set('leg-press', 100, 10),
    ];
    expect(tonnage(sets)).toBe(60 * 8 * 2 + 100 * 10);
    expect(tonnage(sets, { includeWarmup: true })).toBe(400 + 960 + 1000);
    expect(tonnage(sets, { exerciseId: 'leg-press' })).toBe(1000);
    expect(tonnage([])).toBe(0);
  });

  it('il corpo libero senza zavorra pesa zero', () => {
    expect(tonnage([set('plank', 0, 45), set('piegamenti-braccia', 0, 12)])).toBe(0);
  });

  it('sessionTonnage legge le serie della seduta', () => {
    expect(sessionTonnage(session('2026-11-23', [set('a', 50, 10), set('a', 50, 10, { done: false })]))).toBe(500);
  });

  it('isWorkingSet esclude riscaldamento e serie non fatte', () => {
    expect(isWorkingSet(set('a', 1, 1))).toBe(true);
    expect(isWorkingSet(set('a', 1, 1, { type: 'riscaldamento' }))).toBe(false);
    expect(isWorkingSet(set('a', 1, 1, { done: false }))).toBe(false);
    expect(isWorkingSet({ done: true })).toBe(true);
  });
});

describe('record rispetto allo storico', () => {
  const prima = [set('panca', 60, 8), set('panca', 60, 8), set('panca', 60, 7)];

  it('nessun record alla prima volta: manca il confronto', () => {
    expect(detectRecords('panca', [set('panca', 60, 8)], [])).toEqual([]);
  });

  it('riconosce carico, ripetizioni a parità di carico ed e1RM', () => {
    const oggi = [set('panca', 62.5, 6), set('panca', 60, 9)];
    const hits = detectRecords('panca', oggi, prima);
    const per = Object.fromEntries(hits.map((h) => [h.tipo, h]));
    expect(per.carico).toMatchObject({ kg: 62.5, reps: 6, valore: 62.5, precedente: 60 });
    expect(per.ripetizioni).toMatchObject({ kg: 60, reps: 9, valore: 9, precedente: 8 });
    expect(per.e1rm.valore).toBeCloseTo(78, 2);
    expect(per.e1rm.precedente).toBeCloseTo(76, 2);
    expect(per.e1rm).toMatchObject({ kg: 60, reps: 9 });
  });

  it('non segnala nulla se non si migliora', () => {
    expect(detectRecords('panca', [set('panca', 60, 8), set('panca', 57.5, 8)], prima)).toEqual([]);
  });

  it('ignora riscaldamento e serie non completate', () => {
    const oggi = [
      set('panca', 100, 5, { type: 'riscaldamento' }),
      set('panca', 90, 5, { done: false }),
      set('panca', 60, 8),
    ];
    expect(detectRecords('panca', oggi, prima)).toEqual([]);
  });

  it('ignora le serie di un altro esercizio', () => {
    expect(detectRecords('panca', [set('squat', 200, 5)], prima)).toEqual([]);
  });

  it('le serie oltre 12 ripetizioni non producono un record di e1RM', () => {
    const storico = [set('curl', 20, 10)];
    const hits = detectRecords('curl', [set('curl', 20, 20)], storico);
    expect(hits.map((h) => h.tipo)).toEqual(['ripetizioni']);
  });

  it('a corpo libero conta solo il record di ripetizioni', () => {
    const hits = detectRecords('piegamenti', [set('piegamenti', 0, 14)], [set('piegamenti', 0, 12)]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ tipo: 'ripetizioni', kg: 0, reps: 14, precedente: 12 });
  });

  it('con carico aggiunto per la prima volta è un record di carico', () => {
    const hits = detectRecords('dip', [set('dip', 5, 8)], [set('dip', 0, 12)]);
    expect(hits.find((h) => h.tipo === 'carico')).toMatchObject({ kg: 5 });
  });

  it('nelle macchine assistite meno aiuto è un record', () => {
    const hits = detectRecords('trazioni-assistite', [set('trazioni-assistite', 35, 8)], [set('trazioni-assistite', 40, 8)], {
      assisted: true,
    });
    expect(hits.map((h) => h.tipo)).toEqual(['carico']);
    expect(hits[0]).toMatchObject({ kg: 35, precedente: 40 });
    // più aiuto non è un record e l'e1RM non ha senso
    expect(detectRecords('trazioni-assistite', [set('trazioni-assistite', 45, 8)], [set('trazioni-assistite', 40, 8)], { assisted: true })).toEqual([]);
  });

  it('per gli esercizi a tempo i secondi sono ripetizioni e non c\'è e1RM', () => {
    const hits = detectRecords('plank', [set('plank', 0, 75)], [set('plank', 0, 60)], { timed: true });
    expect(hits).toEqual([expect.objectContaining({ tipo: 'ripetizioni', reps: 75, precedente: 60 })]);
  });

  it('accetta una base di confronto già calcolata', () => {
    const base = buildBaseline(prima);
    expect(base.bestKg).toBe(60);
    expect(base.bestRepsByKg['60']).toBe(8);
    expect(base.bestE1rm).toBeCloseTo(76, 2);
    const hits = detectRecords('panca', [set('panca', 65, 5)], base);
    expect(hits.some((h) => h.tipo === 'carico' && h.kg === 65)).toBe(true);
  });

  it('detectSessionRecords raggruppa per esercizio usando le sedute passate', () => {
    const storico = [
      session('2026-11-16', [set('panca', 60, 8), set('squat', 80, 8)]),
      session('2026-11-18', [set('panca', 60, 8), set('squat', 80, 8)]),
    ];
    const oggi = [set('panca', 62.5, 8), set('squat', 80, 8), set('curl', 15, 10)];
    const hits = detectSessionRecords(oggi, storico);
    expect(hits.filter((h) => h.exerciseId === 'panca').map((h) => h.tipo)).toContain('carico');
    expect(hits.some((h) => h.exerciseId === 'squat')).toBe(false);
    // il curl non ha storico: nessun record
    expect(hits.some((h) => h.exerciseId === 'curl')).toBe(false);
  });

  it('detectSessionRecords sa che il plank è a tempo e le trazioni assistite no', () => {
    const storico = [session('2026-11-16', [set('plank', 0, 60), set('trazioni-assistite', 40, 8)])];
    const hits = detectSessionRecords([set('plank', 0, 70), set('trazioni-assistite', 35, 8)], storico);
    expect(hits.map((h) => `${h.exerciseId}:${h.tipo}`).sort()).toEqual(['plank:ripetizioni', 'trazioni-assistite:carico']);
  });

  it('descrive i record con una riga in italiano', () => {
    expect(describeRecord({ tipo: 'carico', exerciseId: 'x', kg: 62.5, reps: 6, valore: 62.5, precedente: 60 }, 'Panca piana')).toBe(
      'Panca piana: nuovo massimo di carico, 62,5 kg (prima 60 kg)',
    );
    expect(describeRecord({ tipo: 'ripetizioni', exerciseId: 'x', kg: 60, reps: 9, valore: 9, precedente: 8 }, 'Panca piana')).toBe(
      'Panca piana: 9 ripetizioni con 60 kg (prima 8)',
    );
    expect(describeRecord({ tipo: 'e1rm', exerciseId: 'x', kg: 60, reps: 9, valore: 78, precedente: 76 }, 'Panca piana')).toBe(
      'Panca piana: 1RM stimato 78 kg (prima 76 kg)',
    );
    expect(describeRecord({ tipo: 'ripetizioni', exerciseId: 'x', kg: 0, reps: 75, valore: 75, precedente: 60 }, 'Plank', { timed: true })).toBe(
      'Plank: 75 secondi (prima 60)',
    );
    expect(describeRecord({ tipo: 'carico', exerciseId: 'x', kg: 35, reps: 8, valore: 35, precedente: 40 }, 'Trazioni assistite', { assisted: true })).toBe(
      'Trazioni assistite: meno aiuto, 35 kg (prima 40 kg)',
    );
  });
});

describe('storico per esercizio', () => {
  const s1 = session('2026-11-09', [set('panca', 60, 8)]);
  const s2 = session('2026-11-11', [set('panca', 60, 9), set('squat', 80, 8)]);
  const s3 = session('2026-11-13', [set('panca', 62.5, 6)], { modo: 'scarico' });
  const s4 = session('2026-11-16', [set('panca', 62.5, 8), set('panca', 40, 10, { type: 'riscaldamento' })]);
  const aperta = session('2026-11-18', [set('panca', 65, 5)], { endedAt: undefined });
  const soloRiscaldamento = session('2026-11-17', [set('panca', 30, 10, { type: 'riscaldamento' })]);

  it('restituisce le sedute dalla più recente, solo concluse e senza scarico', () => {
    const h = historyForExercise([s2, s4, s1, s3, aperta, soloRiscaldamento], 'panca');
    expect(h).toHaveLength(3);
    expect(h[0].map((x) => x.kg)).toEqual([62.5, 40]);
    expect(h[1][0].reps).toBe(9);
    expect(h[2][0].reps).toBe(8);
  });

  it('rispetta il limite e può includere scarico e sedute aperte', () => {
    expect(historyForExercise([s1, s2, s4], 'panca', { limit: 2 })).toHaveLength(2);
    expect(historyForExercise([s1, s3, s4], 'panca', { excludeModes: [] })).toHaveLength(3);
    expect(historyForExercise([s1, aperta], 'panca', { includeUnfinished: true })[0][0].kg).toBe(65);
  });

  it('tiene solo le serie fatte di quell\'esercizio', () => {
    const mista = session('2026-11-20', [set('panca', 70, 5, { done: false }), set('panca', 65, 6), set('squat', 90, 5)]);
    const h = historyForExercise([mista], 'panca');
    expect(h[0]).toHaveLength(1);
    expect(h[0][0].kg).toBe(65);
  });
});

describe('serie del miglior e1RM per seduta (grafico a gradini)', () => {
  const sessioni = [
    session('2026-11-09', [set('panca', 60, 8), set('panca', 60, 6)]),
    session('2026-11-11', [set('panca', 60, 7)]),
    session('2026-11-13', [set('panca', 62.5, 8), set('panca', 50, 20)]),
    session('2026-11-16', [set('panca', 40, 25)]),
    session('2026-11-18', [set('squat', 80, 8)]),
  ];

  it('una riga per seduta in ordine di data, con il massimo progressivo', () => {
    const serie = e1rmSeries([...sessioni].reverse(), 'panca');
    expect(serie.map((p) => p.date)).toEqual(['2026-11-09', '2026-11-11', '2026-11-13', '2026-11-16']);
    expect(serie[0]).toMatchObject({ kg: 60, reps: 8, reliable: true });
    expect(serie[0].e1rm).toBeCloseTo(76, 2);
    expect(serie[0].isRecord).toBe(false);
    // 60 x 7 = 74: meno di 76, il massimo progressivo resta 76
    expect(serie[1].e1rm).toBeCloseTo(74, 2);
    expect(serie[1].best).toBeCloseTo(76, 2);
    expect(serie[1].isRecord).toBe(false);
    // 62,5 x 8 = 79,17 è un nuovo massimo
    expect(serie[2].e1rm).toBeCloseTo(79.17, 2);
    expect(serie[2].isRecord).toBe(true);
    expect(serie[2].best).toBeCloseTo(79.17, 2);
  });

  it('una seduta con sole serie oltre 12 ripetizioni è segnalata e non sposta il massimo', () => {
    const serie = e1rmSeries(sessioni, 'panca');
    const ultima = serie[3];
    expect(ultima.reliable).toBe(false);
    expect(ultima.best).toBeCloseTo(79.17, 2);
    expect(ultima.isRecord).toBe(false);
  });

  it('in una seduta preferisce le serie affidabili anche se l\'e1RM è più basso', () => {
    const serie = e1rmSeries(sessioni, 'panca');
    // 50 x 20 darebbe 83,3 ma è inaffidabile: vale 62,5 x 8
    expect(serie[2]).toMatchObject({ kg: 62.5, reps: 8, reliable: true });
  });

  it('ignora esercizi senza carico e sedute senza quell\'esercizio', () => {
    expect(e1rmSeries(sessioni, 'plank')).toEqual([]);
    expect(e1rmSeries([session('2026-11-20', [set('piegamenti', 0, 12)])], 'piegamenti')).toEqual([]);
  });
});
