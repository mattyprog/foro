import { describe, expect, it } from 'vitest';
import { Profile } from '@garmin/fitsdk';
import raw from '../../data/esercizi.json';
import {
  COMPOUND_PATTERNS,
  EQUIPMENT,
  EXERCISES,
  MUSCLES,
  PATTERNS,
  buildPlannedExercise,
  defaultRepRange,
  defaultRestSec,
  findByGarmin,
  getExercise,
  isCompound,
  requireExercise,
  searchExercises,
  substitutesFor,
} from './library';

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** Categorie e nomi del profilo FIT di Garmin, nella forma 'CATEGORIA' -> {NOMI}. */
function fitCatalog(): Map<string, Set<string>> {
  const types = Profile.types;
  const out = new Map<string, Set<string>>();
  for (const cat of Object.values(types['exerciseCategory'])) {
    const names = types[`${cat}ExerciseName`];
    out.set(snake(cat), new Set(names ? Object.values(names).map(snake) : []));
  }
  return out;
}

describe('esercizi.json', () => {
  const list = raw as unknown as Array<Record<string, unknown>>;

  it('ha tra 100 e 130 esercizi', () => {
    expect(list.length).toBeGreaterThanOrEqual(100);
    expect(list.length).toBeLessThanOrEqual(130);
  });

  it('ha id unici, stabili, in kebab-case ASCII', () => {
    const ids = list.map((e) => e.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('ogni esercizio ha un nome e un muscolo primario', () => {
    for (const e of list) {
      expect(typeof e.name, String(e.id)).toBe('string');
      expect((e.name as string).length, String(e.id)).toBeGreaterThan(2);
      expect(Array.isArray(e.primary), String(e.id)).toBe(true);
      expect((e.primary as string[]).length, `${e.id} senza primary`).toBeGreaterThan(0);
    }
  });

  it('usa solo muscoli, attrezzi e schemi motori dell\'insieme chiuso', () => {
    for (const e of EXERCISES) {
      for (const m of [...e.primary, ...e.secondary]) expect(MUSCLES, `${e.id}: ${m}`).toContain(m);
      expect(EQUIPMENT, `${e.id}: ${e.equipment}`).toContain(e.equipment);
      expect(PATTERNS, `${e.id}: ${e.pattern}`).toContain(e.pattern);
      expect(e.primary.filter((m) => e.secondary.includes(m)), `${e.id}: muscolo doppio`).toEqual([]);
    }
  });

  it('gli schemi isolamento-<muscolo> riguardano un muscolo primario dell\'esercizio', () => {
    for (const e of EXERCISES) {
      if (!e.pattern.startsWith('isolamento-')) continue;
      const muscle = e.pattern.slice('isolamento-'.length);
      expect(e.primary, `${e.id}: ${e.pattern}`).toContain(muscle);
    }
  });

  it('ha un cue di una riga senza lineette lunghe e un incremento di carico valido', () => {
    for (const e of EXERCISES) {
      expect(e.cue, e.id).toBeTruthy();
      expect(e.cue, e.id).not.toMatch(/[\n\u2013\u2014]/);
      expect(e.name, e.id).not.toMatch(/[\u2013\u2014]/);
      expect(Number.isFinite(e.defaultIncrementKg), e.id).toBe(true);
      expect(e.defaultIncrementKg as number, e.id).toBeGreaterThanOrEqual(0);
      expect(typeof e.unilateral, e.id).toBe('boolean');
    }
  });

  it('le chiavi Garmin esistono nel profilo FIT (categoria o categoria/nome)', () => {
    const catalog = fitCatalog();
    let withKeys = 0;
    for (const e of EXERCISES) {
      for (const key of e.garminKeys ?? []) {
        const [cat, name] = key.split('/');
        expect(catalog.has(cat), `${e.id}: categoria ${cat}`).toBe(true);
        if (name) expect(catalog.get(cat)!.has(name), `${e.id}: nome ${key}`).toBe(true);
      }
      if (e.garminKeys?.length) withKeys++;
    }
    // quasi tutti gli esercizi hanno almeno una chiave
    expect(withKeys).toBeGreaterThanOrEqual(EXERCISES.length - 6);
  });

  it('contiene gli esercizi con i nomi usati nelle palestre italiane', () => {
    const attesi = [
      'Panca piana con bilanciere', 'Panca inclinata con manubri', 'Croci ai cavi', 'Chest press',
      'Lat machine', 'Pulley basso', 'Rematore con bilanciere', 'Rematore con manubrio',
      'Trazioni alla sbarra', 'Trazioni assistite', 'Squat con bilanciere', 'Goblet squat', 'Leg press',
      'Affondi', 'Bulgarian split squat', 'Stacco rumeno', 'Stacco da terra', 'Hip thrust', 'Leg curl',
      'Leg extension', 'Calf in piedi', 'Military press', 'Lento avanti con manubri', 'Alzate laterali',
      'Face pull', 'Alzate posteriori', 'Curl con bilanciere', 'Curl con manubri', 'Curl a martello',
      'French press', 'Push down ai cavi', 'Dip alle parallele', 'Crunch', 'Plank', 'Ab wheel',
    ];
    for (const nome of attesi) {
      expect(searchExercises(nome).length, nome).toBeGreaterThan(0);
    }
  });

  it('marca a tempo il plank e assistite le trazioni alla macchina', () => {
    expect(requireExercise('plank').timed).toBe(true);
    expect(requireExercise('trazioni-assistite').assisted).toBe(true);
    expect(requireExercise('panca-piana-bilanciere').timed).toBeUndefined();
  });
});

describe('libreria', () => {
  it('getExercise e requireExercise', () => {
    expect(getExercise('squat-bilanciere')?.name).toBe('Squat con bilanciere');
    expect(getExercise('non-esiste')).toBeUndefined();
    expect(() => requireExercise('non-esiste')).toThrow(/non-esiste/);
  });

  it('classifica multiarticolari e complementari dallo schema motorio', () => {
    expect(COMPOUND_PATTERNS).toContain('squat');
    expect(isCompound(requireExercise('squat-bilanciere'))).toBe(true);
    expect(isCompound(requireExercise('stacco-rumeno-bilanciere'))).toBe(true);
    expect(isCompound(requireExercise('curl-bilanciere'))).toBe(false);
    expect(isCompound(requireExercise('face-pull'))).toBe(false);
    expect(isCompound(requireExercise('plank'))).toBe(false);
  });

  it('intervalli e recuperi di default seguono il metodo', () => {
    const squat = requireExercise('squat-bilanciere');
    const curl = requireExercise('curl-manubri');
    expect(defaultRepRange(squat)).toEqual([6, 10]);
    expect(defaultRepRange(curl)).toEqual([10, 15]);
    expect(defaultRestSec(squat)).toBeGreaterThanOrEqual(120);
    expect(defaultRestSec(squat)).toBeLessThanOrEqual(180);
    expect(defaultRestSec(curl)).toBeGreaterThanOrEqual(60);
    expect(defaultRestSec(curl)).toBeLessThanOrEqual(90);
    expect(defaultRepRange(requireExercise('plank'))).toEqual([30, 60]);
  });

  it('buildPlannedExercise crea serie coerenti col metodo', () => {
    const p = buildPlannedExercise(requireExercise('panca-piana-bilanciere'), { sets: 3, warmups: 1 });
    expect(p.exerciseId).toBe('panca-piana-bilanciere');
    expect(p.progression).toBe('doppia');
    expect(p.incrementKg).toBe(2.5);
    expect(p.sets).toHaveLength(4);
    expect(p.sets[0].type).toBe('riscaldamento');
    expect(p.sets.slice(1).every((s) => s.type === 'normale' && s.reps[0] === 6 && s.reps[1] === 10)).toBe(true);
    expect(p.sets[1].rpe).toBe(7);
    const c = buildPlannedExercise(requireExercise('curl-manubri'), { sets: 2 });
    expect(c.sets).toHaveLength(2);
    expect(c.sets[0].reps).toEqual([10, 15]);
    expect(c.sets[0].rpe).toBe(8);
  });

  it('substitutesFor propone solo esercizi dello stesso schema motorio', () => {
    const squat = requireExercise('squat-bilanciere');
    const subs = substitutesFor(squat);
    expect(subs.length).toBeGreaterThanOrEqual(4);
    expect(subs.every((s) => s.pattern === 'squat' && s.id !== squat.id)).toBe(true);
    expect(subs.map((s) => s.id)).toContain('goblet-squat');
    expect(subs.map((s) => s.id)).toContain('leg-press');
    // le alternative con lo stesso attrezzo o lo stesso muscolo vengono prima
    const bench = substitutesFor('panca-piana-bilanciere');
    expect(bench.every((s) => s.pattern === 'spinta-orizzontale')).toBe(true);
    expect(bench[0].primary).toContain('petto');
  });

  it('substitutesFor può filtrare per attrezzo', () => {
    const solo = substitutesFor('squat-bilanciere', { equipment: ['macchina'] });
    expect(solo.length).toBeGreaterThan(0);
    expect(solo.every((s) => s.equipment === 'macchina')).toBe(true);
  });

  it('searchExercises ignora maiuscole e accenti e cerca anche negli alias', () => {
    expect(searchExercises('LAT MACHINE')[0].id).toBe('lat-machine-presa-larga');
    expect(searchExercises('flessioni').map((e) => e.id)).toContain('piegamenti-braccia');
    expect(searchExercises('rdl')[0].id).toMatch(/^stacco-rumeno/);
    expect(searchExercises('farmer').map((e) => e.id)).toContain('farmer-walk');
    expect(searchExercises('')).toHaveLength(EXERCISES.length);
    expect(searchExercises('zzzzzz')).toEqual([]);
  });

  it('searchExercises filtra per muscolo e attrezzo', () => {
    const r = searchExercises('', { muscle: 'bicipiti', equipment: 'manubri' });
    expect(r.length).toBeGreaterThan(2);
    expect(r.every((e) => e.primary.includes('bicipiti') && e.equipment === 'manubri')).toBe(true);
  });

  it('findByGarmin riconosce categoria/nome e ripiega sulla sola categoria', () => {
    expect(findByGarmin('BENCH_PRESS', 'BARBELL_BENCH_PRESS')?.id).toBe('panca-piana-bilanciere');
    expect(findByGarmin('bench press', 'barbell bench press')?.id).toBe('panca-piana-bilanciere');
    expect(findByGarmin('PLANK', 'PLANK')?.id).toBe('plank');
    // nome sconosciuto ma categoria nota: un esercizio che dichiara la sola categoria
    expect(findByGarmin('BENCH_PRESS', 'CHEST_PRESS_MACHINE_XYZ')?.id).toBe('chest-press-macchina');
    expect(findByGarmin('INDOOR_ROW', 'INDOOR_ROW')).toBeUndefined();
  });
});
