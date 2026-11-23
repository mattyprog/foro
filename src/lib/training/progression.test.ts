import { describe, expect, it } from 'vitest';
import type { LoggedSet, PlannedExercise, SetType } from '../../db/types';
import { buildPlannedExercise, requireExercise } from './library';
import {
  deloadAdvice,
  evaluateExercise,
  incrementFor,
  isStalled,
  loadStep,
  reduceLoad,
  setsForMode,
  suggestNext,
} from './progression';

type Row = [kg: number, reps: number, rpe?: number];

/** Una seduta: l'elenco delle serie fatte di un esercizio. */
function seduta(exerciseId: string, rows: Row[], type: SetType = 'normale'): LoggedSet[] {
  return rows.map(([kg, reps, rpe], i) => ({ exerciseId, setIndex: i, kg, reps, rpe, type, done: true }));
}

const planOf = (id: string, opts: Parameters<typeof buildPlannedExercise>[1] = {}): PlannedExercise =>
  buildPlannedExercise(requireExercise(id), opts);

describe('passi di carico e arrotondamenti', () => {
  it('il passo di arrotondamento dipende dall\'attrezzo', () => {
    expect(loadStep(requireExercise('squat-bilanciere'), 100)).toBe(1.25);
    expect(loadStep(requireExercise('goblet-squat'), 8)).toBe(1);
    expect(loadStep(requireExercise('goblet-squat'), 20)).toBe(2);
    expect(loadStep(requireExercise('leg-press'), 100)).toBe(5);
    expect(loadStep(requireExercise('pulley-basso'), 40)).toBe(2.5);
  });

  it('reduceLoad toglie il 10% e arrotonda al disco disponibile', () => {
    const squat = requireExercise('squat-bilanciere');
    expect(reduceLoad(100, squat)).toBe(90);
    expect(reduceLoad(60, squat)).toBe(53.75);
    expect(reduceLoad(80, squat)).toBe(72.5);
    expect(reduceLoad(20, requireExercise('goblet-squat'))).toBe(18);
    expect(reduceLoad(12, requireExercise('goblet-squat'))).toBe(10);
    expect(reduceLoad(8, requireExercise('goblet-squat'))).toBe(7);
    expect(reduceLoad(100, requireExercise('leg-press'))).toBe(90);
  });

  it('reduceLoad scende almeno di un passo anche quando l\'arrotondamento non basterebbe', () => {
    // 5 kg x 0,9 = 4,5 che a passo 1 tornerebbe a 5
    expect(reduceLoad(5, requireExercise('curl-manubri'))).toBe(4);
    expect(reduceLoad(0, requireExercise('curl-manubri'))).toBe(0);
  });

  it('incrementFor usa il passo della scheda e quello più piccolo dell\'esercizio sui carichi leggeri', () => {
    const squat = requireExercise('squat-bilanciere');
    const curl = requireExercise('curl-manubri');
    const planSquat = planOf('squat-bilanciere');
    expect(incrementFor(planSquat, squat, 60)).toBe(2.5);
    expect(incrementFor({ ...planSquat, incrementKg: 5 }, squat, 60)).toBe(5);
    // senza incremento nella scheda: quello dell'esercizio
    expect(incrementFor({ ...planSquat, incrementKg: 0 }, squat, 60)).toBe(2.5);
    // manubri leggeri (< 10 kg): non più del passo dell'esercizio, anche se la scheda dice 2,5
    expect(incrementFor({ ...planOf('curl-manubri'), incrementKg: 2.5 }, curl, 8)).toBe(1);
    // manubri non leggeri: vale la scheda
    expect(incrementFor({ ...planOf('curl-manubri'), incrementKg: 2.5 }, curl, 14)).toBe(2.5);
    // sotto i 5 kg in totale vale sempre il passo dell'esercizio
    expect(incrementFor({ ...planOf('alzate-laterali-cavo'), incrementKg: 2.5 }, requireExercise('alzate-laterali-cavo'), 3.75)).toBe(1.25);
  });

  it('setsForMode riduce le serie: leggero -1/3, scarico -50%', () => {
    expect([1, 2, 3, 4, 5].map((n) => setsForMode(n, 'leggero'))).toEqual([1, 1, 2, 3, 3]);
    expect([1, 2, 3, 4, 5].map((n) => setsForMode(n, 'scarico'))).toEqual([1, 1, 2, 2, 3]);
    expect([1, 2, 3, 4].map((n) => setsForMode(n, 'normale'))).toEqual([1, 2, 3, 4]);
  });
});

describe('prima volta', () => {
  it('senza storico non inventa il carico e dà il minimo come obiettivo', () => {
    const sug = suggestNext(planOf('panca-piana-manubri'), [], requireExercise('panca-piana-manubri'));
    expect(sug).toHaveLength(3);
    for (const s of sug) {
      expect(s.kg).toBeUndefined();
      expect(s.repsTarget).toBe(6);
      expect(s.motivo).toMatch(/^Prima volta/);
      expect(s.motivo).not.toMatch(/\n/);
    }
  });

  it('a corpo libero parte da zero kg, non da un valore mancante', () => {
    const sug = suggestNext(planOf('piegamenti-braccia', { reps: [8, 15] }), [], requireExercise('piegamenti-braccia'));
    expect(sug.every((s) => s.kg === 0 && s.repsTarget === 8)).toBe(true);
  });

  it('le serie di riscaldamento non hanno carico finché manca quello di lavoro', () => {
    const sug = suggestNext(planOf('squat-bilanciere', { warmups: 1 }), [], requireExercise('squat-bilanciere'));
    expect(sug).toHaveLength(4);
    expect(sug[0].type).toBe('riscaldamento');
    expect(sug[0].kg).toBeUndefined();
  });

  it('segnala l\'azione prima-volta', () => {
    const ev = evaluateExercise(planOf('goblet-squat'), [], requireExercise('goblet-squat'));
    expect(ev.action).toBe('prima-volta');
    expect(ev.stalled).toBe(false);
    expect(ev.sessionsConsidered).toBe(0);
  });
});

describe('doppia progressione: ripetizioni', () => {
  const ex = requireExercise('panca-piana-manubri');
  const plan = planOf('panca-piana-manubri'); // 3 x 6-10

  it('stesso carico e una ripetizione in più per serie, fino al massimo', () => {
    const sug = suggestNext(plan, [seduta('panca-piana-manubri', [[24, 8, 7], [24, 8, 8], [24, 7, 8]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([24, 24, 24]);
    expect(sug.map((s) => s.repsTarget)).toEqual([9, 9, 8]);
    expect(sug[0].motivo).toMatch(/24 kg × 8/);
    expect(sug[0].motivo).toMatch(/9/);
  });

  it('una serie già al massimo resta al massimo mentre le altre salgono', () => {
    const sug = suggestNext(plan, [seduta('panca-piana-manubri', [[24, 10, 8], [24, 9, 8], [24, 8, 8]])], ex);
    expect(sug.map((s) => s.repsTarget)).toEqual([10, 10, 9]);
    expect(evaluateExercise(plan, [seduta('panca-piana-manubri', [[24, 10, 8], [24, 9, 8], [24, 8, 8]])], ex).action).toBe(
      'aumenta-ripetizioni',
    );
  });

  it('se l\'ultima serie era al limite (RPE 10) ripete le stesse ripetizioni', () => {
    const sug = suggestNext(plan, [seduta('panca-piana-manubri', [[24, 8, 8], [24, 8, 9], [24, 7, 10]])], ex);
    expect(sug.map((s) => s.repsTarget)).toEqual([9, 9, 7]);
    expect(sug[2].motivo).toMatch(/limite/);
  });

  it('sotto il minimo una volta sola: stesso carico e obiettivo il minimo', () => {
    const sug = suggestNext(plan, [seduta('panca-piana-manubri', [[24, 6, 8], [24, 5, 9], [24, 4, 10]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([24, 24, 24]);
    expect(sug.map((s) => s.repsTarget)).toEqual([7, 6, 6]);
    expect(sug[1].motivo).toMatch(/sotto le 6/);
  });

  it('ignora riscaldamento e serie non fatte nello storico', () => {
    const storico = [
      ...seduta('panca-piana-manubri', [[10, 10]], 'riscaldamento'),
      ...seduta('panca-piana-manubri', [[24, 8], [24, 8], [24, 8]]),
      { exerciseId: 'panca-piana-manubri', setIndex: 9, kg: 30, reps: 12, done: false, type: 'normale' as const },
    ];
    const sug = suggestNext(plan, [storico], ex);
    expect(sug.map((s) => s.kg)).toEqual([24, 24, 24]);
    expect(sug.map((s) => s.repsTarget)).toEqual([9, 9, 9]);
  });

  it('se l\'ultima volta le serie erano meno di quelle previste, la serie in più parte dall\'ultima registrata', () => {
    const sug = suggestNext(plan, [seduta('panca-piana-manubri', [[24, 8], [24, 7]])], ex);
    expect(sug).toHaveLength(3);
    expect(sug[2].kg).toBe(24);
    expect(sug[2].repsTarget).toBe(8);
  });
});

describe('doppia progressione: aumento di carico e ripartenza dal minimo', () => {
  const ex = requireExercise('squat-bilanciere');
  const plan = planOf('squat-bilanciere'); // 3 x 6-10, incremento 2,5

  it('tutte le serie al massimo con RPE 8 o meno: +2,5 kg e si riparte dal minimo', () => {
    const ev = evaluateExercise(plan, [seduta('squat-bilanciere', [[60, 10, 8], [60, 10, 7.5], [60, 10, 8]])], ex);
    expect(ev.action).toBe('sali-carico');
    expect(ev.suggestions.map((s) => s.kg)).toEqual([62.5, 62.5, 62.5]);
    expect(ev.suggestions.map((s) => s.repsTarget)).toEqual([6, 6, 6]);
    expect(ev.suggestions[0].motivo).toMatch(/62,5 kg/);
    expect(ev.suggestions[0].motivo).toMatch(/riparti da 6/);
    expect(ev.motivo).toMatch(/62,5 kg/);
  });

  it('un RPE sopra l\'8 su una serie blocca l\'aumento', () => {
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 10, 8], [60, 10, 9], [60, 10, 8]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([60, 60, 60]);
    expect(sug.map((s) => s.repsTarget)).toEqual([10, 10, 10]);
  });

  it('un RPE non registrato non blocca l\'aumento', () => {
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 10], [60, 10], [60, 10]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([62.5, 62.5, 62.5]);
  });

  it('con una serie in meno del previsto non sale', () => {
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 10, 7], [60, 10, 8]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([60, 60, 60]);
  });

  it('se una serie è sotto il massimo non sale', () => {
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 10, 7], [60, 10, 8], [60, 9, 8]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([60, 60, 60]);
    expect(sug.map((s) => s.repsTarget)).toEqual([10, 10, 10]);
  });

  it('ogni serie sale dal proprio carico', () => {
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 10, 8], [60, 10, 8], [57.5, 10, 8]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([62.5, 62.5, 60]);
  });

  it('usa l\'incremento della scheda', () => {
    const sug = suggestNext({ ...plan, incrementKg: 5 }, [seduta('squat-bilanciere', [[60, 10], [60, 10], [60, 10]])], ex);
    expect(sug[0].kg).toBe(65);
  });

  it('sui manubri leggeri usa il passo piccolo dell\'esercizio', () => {
    const curl = requireExercise('curl-manubri');
    const p = planOf('curl-manubri', { incrementKg: 2.5, sets: 2 });
    const sug = suggestNext(p, [seduta('curl-manubri', [[8, 15, 8], [8, 15, 8]])], curl);
    expect(sug.map((s) => s.kg)).toEqual([9, 9]);
    expect(sug.map((s) => s.repsTarget)).toEqual([10, 10]);
  });

  it('il riscaldamento segue il nuovo carico di lavoro', () => {
    const p = planOf('squat-bilanciere', { warmups: 1 });
    const sug = suggestNext(p, [seduta('squat-bilanciere', [[60, 10], [60, 10], [60, 10]])], ex);
    expect(sug[0]).toMatchObject({ type: 'riscaldamento', kg: 31.25, repsTarget: 8 });
    expect(sug.slice(1).map((s) => s.kg)).toEqual([62.5, 62.5, 62.5]);
  });

  it('a corpo libero al massimo senza zavorra non inventa un carico', () => {
    const p = planOf('piegamenti-braccia', { reps: [8, 15] });
    const ev = evaluateExercise(p, [seduta('piegamenti-braccia', [[0, 15, 8], [0, 15, 8], [0, 15, 8]])], requireExercise('piegamenti-braccia'));
    expect(ev.action).toBe('massimo-raggiunto');
    expect(ev.suggestions.every((s) => s.kg === 0 && s.repsTarget === 15)).toBe(true);
    expect(ev.suggestions[0].motivo).toMatch(/variante più difficile/);
  });

  it('a corpo libero con zavorra già in uso l\'aumento funziona come al solito', () => {
    const p = planOf('piegamenti-braccia', { reps: [8, 15] });
    const sug = suggestNext(p, [seduta('piegamenti-braccia', [[5, 15], [5, 15], [5, 15]])], requireExercise('piegamenti-braccia'));
    expect(sug[0]).toMatchObject({ kg: 7.5, repsTarget: 8 });
  });
});

describe('due sedute sotto il minimo: carico -10%', () => {
  const ex = requireExercise('squat-bilanciere');
  const plan = planOf('squat-bilanciere');
  const sotto = (kg: number) => seduta('squat-bilanciere', [[kg, 6], [kg, 5], [kg, 5]]);
  const ok = (kg: number) => seduta('squat-bilanciere', [[kg, 8], [kg, 8], [kg, 7]]);

  it('dopo due sedute di fila sotto il minimo scende del 10% e riparte dal minimo', () => {
    const ev = evaluateExercise(plan, [sotto(100), sotto(100)], ex);
    expect(ev.action).toBe('riduci-carico');
    expect(ev.consecutiveMisses).toBe(2);
    expect(ev.suggestions.map((s) => s.kg)).toEqual([90, 90, 90]);
    expect(ev.suggestions.map((s) => s.repsTarget)).toEqual([6, 6, 6]);
    expect(ev.suggestions[0].motivo).toMatch(/Due sedute/);
    expect(ev.suggestions[0].motivo).toMatch(/90 kg/);
  });

  it('arrotonda al disco da 1,25 kg', () => {
    expect(suggestNext(plan, [sotto(60), sotto(60)], ex).map((s) => s.kg)).toEqual([53.75, 53.75, 53.75]);
  });

  it('una sola seduta sotto il minimo non basta', () => {
    const ev = evaluateExercise(plan, [sotto(100), ok(100)], ex);
    expect(ev.action).not.toBe('riduci-carico');
    expect(ev.consecutiveMisses).toBe(1);
    expect(ev.suggestions.map((s) => s.kg)).toEqual([100, 100, 100]);
  });

  it('le sedute sotto il minimo devono essere consecutive', () => {
    const ev = evaluateExercise(plan, [sotto(100), ok(100), sotto(100)], ex);
    expect(ev.consecutiveMisses).toBe(1);
    expect(ev.suggestions[0].kg).toBe(100);
  });

  it('le serie non fatte non contano come mancate', () => {
    const a = seduta('squat-bilanciere', [[100, 8], [100, 8]]);
    const ev = evaluateExercise(plan, [a, a], ex);
    expect(ev.consecutiveMisses).toBe(0);
  });

  it('con una macchina assistita il 10% in più di aiuto', () => {
    const ass = requireExercise('trazioni-assistite');
    const p = planOf('trazioni-assistite');
    const sotto2 = seduta('trazioni-assistite', [[40, 5], [40, 4], [40, 4]]);
    const sug = suggestNext(p, [sotto2, sotto2], ass);
    expect(sug.map((s) => s.kg)).toEqual([45, 45, 45]);
    expect(sug[0].motivo).toMatch(/aiuto/);
  });
});

describe('stallo', () => {
  it('3 sedute senza migliorare né carico né ripetizioni totali: fermo', () => {
    const s = seduta('panca-piana-manubri', [[24, 8], [24, 8], [24, 8]]);
    expect(isStalled([s, s, s])).toBe(true);
  });

  it('una ripetizione in più basta per non essere fermo', () => {
    const a = seduta('panca-piana-manubri', [[24, 9], [24, 8], [24, 8]]);
    const b = seduta('panca-piana-manubri', [[24, 8], [24, 8], [24, 8]]);
    const c = seduta('panca-piana-manubri', [[24, 8], [24, 8], [24, 7]]);
    expect(isStalled([a, b, c])).toBe(false);
  });

  it('un aumento di carico conta come progresso anche se le ripetizioni calano', () => {
    const a = seduta('squat-bilanciere', [[62.5, 6], [62.5, 6], [62.5, 6]]);
    const b = seduta('squat-bilanciere', [[60, 10], [60, 10], [60, 10]]);
    const c = seduta('squat-bilanciere', [[60, 9], [60, 9], [60, 9]]);
    expect(isStalled([a, b, c])).toBe(false);
  });

  it('serve almeno 3 sedute di storico', () => {
    const s = seduta('panca-piana-manubri', [[24, 8], [24, 8], [24, 8]]);
    expect(isStalled([s, s])).toBe(false);
    expect(isStalled([])).toBe(false);
  });

  it('evaluateExercise riporta lo stallo senza cambiare i suggerimenti di base', () => {
    const ex = requireExercise('panca-piana-manubri');
    const s = seduta('panca-piana-manubri', [[24, 8], [24, 8], [24, 8]]);
    const ev = evaluateExercise(planOf('panca-piana-manubri'), [s, s, s], ex);
    expect(ev.stalled).toBe(true);
    expect(ev.suggestions.map((x) => x.repsTarget)).toEqual([9, 9, 9]);
    expect(ev.motivo).toMatch(/fermo/i);
  });

  it('dopo una riduzione di carico seguita da progressi non è fermo', () => {
    const a = seduta('squat-bilanciere', [[90, 8], [90, 8], [90, 8]]);
    const b = seduta('squat-bilanciere', [[90, 7], [90, 7], [90, 7]]);
    const c = seduta('squat-bilanciere', [[100, 5], [100, 5], [100, 5]]);
    expect(isStalled([a, b, c])).toBe(false);
  });
});

describe('progressione lineare', () => {
  const ex = requireExercise('squat-bilanciere');
  const plan: PlannedExercise = { ...planOf('squat-bilanciere', { reps: [5, 5] }), progression: 'lineare' };

  it('aggiunge il carico a ogni seduta completata', () => {
    const ev = evaluateExercise(plan, [seduta('squat-bilanciere', [[100, 5], [100, 5], [100, 5]])], ex);
    expect(ev.action).toBe('sali-carico');
    expect(ev.suggestions.map((s) => [s.kg, s.repsTarget])).toEqual([[102.5, 5], [102.5, 5], [102.5, 5]]);
  });

  it('se non completa tutte le ripetizioni ripete lo stesso carico', () => {
    const ev = evaluateExercise(plan, [seduta('squat-bilanciere', [[100, 5], [100, 5], [100, 4]])], ex);
    expect(ev.action).toBe('mantieni');
    expect(ev.suggestions.map((s) => s.kg)).toEqual([100, 100, 100]);
  });

  it('dopo due sedute mancate scende del 10%', () => {
    const miss = seduta('squat-bilanciere', [[100, 5], [100, 4], [100, 4]]);
    const ev = evaluateExercise(plan, [miss, miss], ex);
    expect(ev.action).toBe('riduci-carico');
    expect(ev.suggestions[0].kg).toBe(90);
  });
});

describe('progressione a RPE', () => {
  const ex = requireExercise('squat-bilanciere');
  const plan: PlannedExercise = { ...planOf('squat-bilanciere'), progression: 'rpe' }; // RPE obiettivo 7

  it('troppo facile (RPE almeno 1 sotto l\'obiettivo): sale di carico', () => {
    const ev = evaluateExercise(plan, [seduta('squat-bilanciere', [[60, 8, 6], [60, 8, 6], [60, 8, 5.5]])], ex);
    expect(ev.action).toBe('sali-carico');
    expect(ev.suggestions.map((s) => s.kg)).toEqual([62.5, 62.5, 62.5]);
    expect(ev.suggestions.map((s) => s.repsTarget)).toEqual([8, 8, 8]);
  });

  it('troppo duro (RPE almeno 1 sopra): scende di un passo', () => {
    const ev = evaluateExercise(plan, [seduta('squat-bilanciere', [[60, 7, 8.5], [60, 7, 8.5], [60, 6, 9]])], ex);
    expect(ev.action).toBe('scendi-leggero');
    expect(ev.suggestions.map((s) => s.kg)).toEqual([57.5, 57.5, 57.5]);
    expect(ev.suggestions[0].motivo).toMatch(/RPE/);
  });

  it('in linea con l\'obiettivo: come la doppia progressione', () => {
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 8, 7], [60, 8, 7], [60, 7, 7.5]])], ex);
    expect(sug.map((s) => s.kg)).toEqual([60, 60, 60]);
    expect(sug.map((s) => s.repsTarget)).toEqual([9, 9, 8]);
  });

  it('senza RPE registrato ripiega sulla doppia progressione e lo dice', () => {
    const ev = evaluateExercise(plan, [seduta('squat-bilanciere', [[60, 8], [60, 8], [60, 8]])], ex);
    expect(ev.suggestions.map((s) => s.repsTarget)).toEqual([9, 9, 9]);
    expect(ev.suggestions[0].motivo).toMatch(/RPE/);
  });
});

describe('nessuna progressione', () => {
  it('ripete i valori dell\'ultima volta', () => {
    const plan: PlannedExercise = { ...planOf('squat-bilanciere'), progression: 'nessuna' };
    const sug = suggestNext(plan, [seduta('squat-bilanciere', [[60, 10, 6], [60, 10, 6], [60, 9, 7]])], requireExercise('squat-bilanciere'));
    expect(sug.map((s) => [s.kg, s.repsTarget])).toEqual([[60, 10], [60, 10], [60, 9]]);
    expect(sug[0].motivo).toMatch(/Nessuna progressione/);
  });
});

describe('macchine assistite', () => {
  const ex = requireExercise('trazioni-assistite');
  const plan = planOf('trazioni-assistite');

  it('al massimo di tutte le serie riduce l\'aiuto', () => {
    const ev = evaluateExercise(plan, [seduta('trazioni-assistite', [[40, 10, 8], [40, 10, 8], [40, 10, 8]])], ex);
    expect(ev.action).toBe('sali-carico');
    expect(ev.suggestions.map((s) => [s.kg, s.repsTarget])).toEqual([[37.5, 6], [37.5, 6], [37.5, 6]]);
    expect(ev.suggestions[0].motivo).toMatch(/aiuto/);
  });

  it('senza più aiuto resta a zero e propone di continuare a salire di ripetizioni', () => {
    const ev = evaluateExercise(plan, [seduta('trazioni-assistite', [[0, 10, 8], [0, 10, 8], [0, 10, 8]])], ex);
    expect(ev.suggestions.every((s) => s.kg === 0)).toBe(true);
    expect(ev.action).toBe('massimo-raggiunto');
  });

  it('non scende sotto zero di aiuto', () => {
    const sug = suggestNext(plan, [seduta('trazioni-assistite', [[2, 10], [2, 10], [2, 10]])], ex);
    expect(sug[0].kg).toBe(0);
  });

  it('la prima volta non conosce l\'aiuto', () => {
    const sug = suggestNext(plan, [], ex);
    expect(sug[0].kg).toBeUndefined();
    expect(sug[0].motivo).toMatch(/aiuto/);
  });
});

describe('esercizi a tempo', () => {
  const ex = requireExercise('plank');
  const plan = planOf('plank', { sets: 2 }); // 30-60 s

  it('sale di 5 secondi alla volta', () => {
    const sug = suggestNext(plan, [seduta('plank', [[0, 40], [0, 35]])], ex);
    expect(sug.map((s) => s.repsTarget)).toEqual([45, 40]);
    expect(sug[0].motivo).toMatch(/secondi/);
  });

  it('al massimo non aggiunge carico: ha raggiunto l\'obiettivo', () => {
    const ev = evaluateExercise(plan, [seduta('plank', [[0, 60], [0, 60]])], ex);
    expect(ev.action).toBe('massimo-raggiunto');
    expect(ev.suggestions.every((s) => s.kg === 0 && s.repsTarget === 60)).toBe(true);
  });

  it('non supera il massimo dell\'intervallo', () => {
    const sug = suggestNext(plan, [seduta('plank', [[0, 58], [0, 57]])], ex);
    expect(sug.map((s) => s.repsTarget)).toEqual([60, 60]);
  });
});

describe('seduta leggera e settimana di scarico', () => {
  const ex = requireExercise('squat-bilanciere');
  const plan = planOf('squat-bilanciere', { warmups: 1 });
  const piena = seduta('squat-bilanciere', [[60, 10, 7], [60, 10, 8], [60, 10, 8]]);

  it('scarico: metà delle serie allenanti e carico -10%', () => {
    const ev = evaluateExercise(plan, [piena], ex, { mode: 'scarico' });
    const lavoro = ev.suggestions.filter((s) => s.type !== 'riscaldamento');
    expect(lavoro).toHaveLength(2);
    expect(lavoro.map((s) => s.kg)).toEqual([53.75, 53.75]);
    expect(ev.suggestions[0].type).toBe('riscaldamento');
    expect(ev.action).toBe('scarico');
    expect(lavoro[0].motivo).toMatch(/scarico/i);
  });

  it('scarico: parte dall\'ultimo carico svolto, non da quello che sarebbe salito', () => {
    // in normale salirebbe a 62,5: nello scarico si scende da 60
    const ev = evaluateExercise(plan, [piena], ex, { mode: 'scarico' });
    expect(ev.suggestions.filter((s) => s.type !== 'riscaldamento')[0].kg).toBe(53.75);
  });

  it('leggero: un terzo di serie in meno, carico invariato e nessun aumento', () => {
    const ev = evaluateExercise(plan, [piena], ex, { mode: 'leggero' });
    const lavoro = ev.suggestions.filter((s) => s.type !== 'riscaldamento');
    expect(lavoro).toHaveLength(2);
    expect(lavoro.map((s) => s.kg)).toEqual([60, 60]);
    expect(lavoro.map((s) => s.repsTarget)).toEqual([10, 10]);
    expect(lavoro[0].motivo).toMatch(/leggera/i);
  });

  it('leggero: senza storico resta una seduta ridotta', () => {
    const ev = evaluateExercise(planOf('goblet-squat', { sets: 3 }), [], requireExercise('goblet-squat'), { mode: 'leggero' });
    expect(ev.suggestions).toHaveLength(2);
  });

  it('ogni suggerimento indica a quale serie della scheda si riferisce', () => {
    const ev = evaluateExercise(plan, [piena], ex, { mode: 'scarico' });
    expect(ev.suggestions.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

describe('quando proporre lo scarico', () => {
  it('due o più esercizi fermi', () => {
    const a = deloadAdvice({ stalledExercises: 2 });
    expect(a.suggest).toBe(true);
    expect(a.reasons).toHaveLength(1);
    expect(a.motivo).toMatch(/fermi/);
    expect(deloadAdvice({ stalledExercises: 1 }).suggest).toBe(false);
  });

  it('dopo il numero di settimane previsto (default 8, la scheda può dire 6)', () => {
    expect(deloadAdvice({ weeksSinceDeload: 6, deloadEvery: 6 }).suggest).toBe(true);
    expect(deloadAdvice({ weeksSinceDeload: 5, deloadEvery: 6 }).suggest).toBe(false);
    expect(deloadAdvice({ weeksSinceDeload: 8 }).suggest).toBe(true);
    expect(deloadAdvice({ weeksSinceDeload: 7 }).suggest).toBe(false);
  });

  it('semaforo giallo per una settimana o HRV basso per 3 giorni', () => {
    expect(deloadAdvice({ yellowDays: 7 }).suggest).toBe(true);
    expect(deloadAdvice({ yellowDays: 6 }).suggest).toBe(false);
    expect(deloadAdvice({ hrvLowDays: 3 }).suggest).toBe(true);
    expect(deloadAdvice({ hrvLowDays: 2 }).suggest).toBe(false);
  });

  it('senza segnali non propone nulla e unisce i motivi se sono più d\'uno', () => {
    const none = deloadAdvice({});
    expect(none.suggest).toBe(false);
    expect(none.motivo).toBe('');
    const due = deloadAdvice({ stalledExercises: 3, yellowDays: 7 });
    expect(due.reasons).toHaveLength(2);
    expect(due.motivo).not.toMatch(/\n/);
  });
});

describe('testi', () => {
  it('i motivi sono una riga sola, in italiano, senza lineette lunghe', () => {
    const ex = requireExercise('squat-bilanciere');
    const casi: LoggedSet[][][] = [
      [],
      [seduta('squat-bilanciere', [[60, 10, 7], [60, 10, 7], [60, 10, 7]])],
      [seduta('squat-bilanciere', [[60, 5], [60, 5], [60, 5]]), seduta('squat-bilanciere', [[60, 5], [60, 5], [60, 5]])],
      [seduta('squat-bilanciere', [[60, 8], [60, 7], [60, 6]])],
    ];
    for (const h of casi) {
      for (const mode of ['normale', 'leggero', 'scarico'] as const) {
        const ev = evaluateExercise(planOf('squat-bilanciere'), h, ex, { mode });
        for (const s of [...ev.suggestions, { motivo: ev.motivo }]) {
          expect(s.motivo).toBeTruthy();
          expect(s.motivo).not.toMatch(/[\n\u2013\u2014]/);
        }
      }
    }
  });
});
