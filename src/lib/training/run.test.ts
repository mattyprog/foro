import { describe, expect, it } from 'vitest';
import type { Activity } from '../../db/types';
import {
  DEFAULT_START_MINUTES,
  MAX_WEEKLY_INCREASE,
  ageOn,
  analyzeRun,
  buildRunPlan,
  describeZone,
  fmtDuration,
  fmtHms,
  fmtKm,
  fmtPace,
  fmtSpeed,
  hrZonesFromBounds,
  hrZonesFromMax,
  isProgressionSafe,
  maxNextWeekMinutes,
  paceFromSpeed,
  paceSecPerKm,
  recentWeeklyRunMinutes,
  resolveHrZones,
  speedKmh,
  suggestStartMinutes,
  tanakaMaxHr,
  weeklyRunMinutes,
  zoneOfHr,
} from './run';

describe('zone cardiache', () => {
  it('età in anni compiuti', () => {
    expect(ageOn('1996-05-10', '2026-11-23')).toBe(30);
    expect(ageOn('1996-12-01', '2026-11-23')).toBe(29);
    expect(ageOn('1996-11-23', '2026-11-23')).toBe(30);
  });

  it('FC massima con Tanaka: 208 - 0,7 x età', () => {
    expect(tanakaMaxHr(30)).toBe(187);
    expect(tanakaMaxHr(40)).toBe(180);
    expect(tanakaMaxHr(25)).toBe(191); // 190,5 arrotondato
  });

  it('cinque zone come percentuali della FC massima, senza buchi né sovrapposizioni', () => {
    const z = hrZonesFromMax(190);
    expect(z.map((x) => [x.zone, x.minBpm, x.maxBpm])).toEqual([
      [1, 95, 113],
      [2, 114, 132],
      [3, 133, 151],
      [4, 152, 170],
      [5, 171, 190],
    ]);
    expect(z.map((x) => x.nome)).toEqual(['Recupero', 'Facile', 'Moderata', 'Intensa', 'Massimale']);
    for (let i = 1; i < 5; i++) expect(z[i].minBpm).toBe(z[i - 1].maxBpm + 1);
    expect(() => hrZonesFromMax(0)).toThrow();
  });

  it('zone da limiti forniti: sei numeri crescenti', () => {
    const z = hrZonesFromBounds([100, 120, 140, 155, 170, 185]);
    expect(z.map((x) => [x.minBpm, x.maxBpm])).toEqual([
      [100, 119],
      [120, 139],
      [140, 154],
      [155, 169],
      [170, 185],
    ]);
    expect(() => hrZonesFromBounds([100, 120, 140])).toThrow();
    expect(() => hrZonesFromBounds([100, 120, 120, 155, 170, 185])).toThrow();
    expect(() => hrZonesFromBounds([100, 120, 140, 155, 170, Number.NaN])).toThrow();
  });

  it('zoneOfHr: la zona più alta raggiunta; sotto la zona 1 resta la 1', () => {
    const z = hrZonesFromMax(190);
    expect(zoneOfHr(z, 60)).toBe(1);
    expect(zoneOfHr(z, 100)).toBe(1);
    expect(zoneOfHr(z, 114)).toBe(2);
    expect(zoneOfHr(z, 132)).toBe(2);
    expect(zoneOfHr(z, 133)).toBe(3);
    expect(zoneOfHr(z, 190)).toBe(5);
    expect(zoneOfHr(z, 205)).toBe(5);
  });

  it('describeZone scrive i battiti in italiano', () => {
    expect(describeZone(hrZonesFromMax(190)[1])).toBe('Zona 2 (facile): da 114 a 132 battiti al minuto');
  });

  it('resolveHrZones: zone fornite, poi limiti, poi FC massima, poi Tanaka', () => {
    const given = hrZonesFromBounds([100, 120, 140, 155, 170, 185]);
    expect(resolveHrZones({ zones: given, maxHr: 200 })).toMatchObject({ source: 'fornite', maxHr: 185 });
    expect(resolveHrZones({ bounds: [100, 120, 140, 155, 170, 185], maxHr: 200 })).toMatchObject({ source: 'fornite', maxHr: 185 });
    expect(resolveHrZones({ maxHr: 190, birthDate: '1996-05-10', onDate: '2026-11-23' })).toMatchObject({ source: 'fc-massima', maxHr: 190 });
    const t = resolveHrZones({ birthDate: '1996-05-10', onDate: '2026-11-23' })!;
    expect(t).toMatchObject({ source: 'tanaka', maxHr: 187 });
    expect(t.zones[4].maxBpm).toBe(187);
  });

  it('limiti non validi non bloccano: si passa alla fonte successiva; senza nulla, undefined', () => {
    expect(resolveHrZones({ bounds: [10, 5], maxHr: 180 })).toMatchObject({ source: 'fc-massima', maxHr: 180 });
    expect(resolveHrZones({})).toBeUndefined();
    expect(resolveHrZones({ birthDate: '1996-05-10' })).toBeUndefined();
    expect(resolveHrZones({ birthDate: '2040-01-01', onDate: '2026-11-23' })).toBeUndefined();
    expect(resolveHrZones({ zones: [{ zone: 1, minBpm: 100, maxBpm: 110, nome: 'x' }] })).toBeUndefined();
  });
});

describe('passo, velocità, distanza, durata', () => {
  it('passo in min:ss /km', () => {
    expect(fmtPace(330)).toBe('5:30 /km');
    expect(fmtPace(359.6)).toBe('6:00 /km');
    expect(fmtPace(305)).toBe('5:05 /km');
    expect(fmtPace(0)).toBe('-');
    expect(fmtPace(undefined)).toBe('-');
    expect(fmtPace(Number.NaN)).toBe('-');
  });

  it('passo e velocità si convertono', () => {
    expect(paceSecPerKm(5000, 1650)).toBe(330);
    expect(paceSecPerKm(0, 1650)).toBeUndefined();
    expect(paceSecPerKm(5000, 0)).toBeUndefined();
    expect(speedKmh(360)).toBe(10);
    expect(paceFromSpeed(12)).toBe(300);
    expect(fmtSpeed(10.94)).toBe('10,9 km/h');
    expect(fmtSpeed(undefined)).toBe('-');
  });

  it('distanza con la virgola', () => {
    expect(fmtKm(5421)).toBe('5,42 km');
    expect(fmtKm(10000)).toBe('10 km');
    expect(fmtKm(800, 1)).toBe('0,8 km');
    expect(fmtKm(undefined)).toBe('-');
  });

  it('durata a parole e a orologio', () => {
    expect(fmtDuration(45)).toBe('45 s');
    expect(fmtDuration(1500)).toBe('25 min');
    expect(fmtDuration(3725)).toBe('1 h 02 min');
    expect(fmtDuration(3599)).toBe('1 h 00 min');
    expect(fmtHms(3725)).toBe('1:02:05');
    expect(fmtHms(1930)).toBe('32:10');
    expect(fmtHms(59.6)).toBe('1:00');
  });
});

describe('piano corsa progressivo', () => {
  const totals = (p: ReturnType<typeof buildRunPlan>) => p.weeks.map((w) => w.totalMinutes);

  it('otto settimane da 45 minuti: +10% al massimo, con assestamento ogni quattro', () => {
    const p = buildRunPlan();
    expect(p.weeks).toHaveLength(8);
    expect(totals(p)).toEqual([45, 49, 53, 53, 58, 63, 69, 69]);
    expect(p.startWeeklyMinutes).toBe(DEFAULT_START_MINUTES);
    expect(p.weeks.map((w) => w.consolidation)).toEqual([false, false, false, true, false, false, false, true]);
    expect(p.weeks[3].changePct).toBe(0);
    expect(p.weeks[0].changePct).toBeNull();
    expect(p.maxWeeklyIncreasePct).toBeLessThanOrEqual(10);
    expect(p.maxWeeklyIncreasePct).toBeGreaterThan(0);
  });

  it('il tempo di una settimana non supera mai il +10% della precedente, comunque si parta', () => {
    for (const start of [20, 30, 45, 60, 90, 150, 400]) {
      for (const runs of [1, 2, 3, 4]) {
        for (const weeks of [4, 8, 16, 26]) {
          const p = buildRunPlan({ startWeeklyMinutes: start, runsPerWeek: runs, weeks });
          const t = totals(p);
          expect(t).toHaveLength(weeks);
          expect(isProgressionSafe(t)).toBe(true);
          t.forEach((m, i) => {
            if (i > 0) expect(m / t[i - 1]).toBeLessThanOrEqual(1 + MAX_WEEKLY_INCREASE + 1e-9);
          });
          for (const w of p.weeks) expect(w.sessions.reduce((a, s) => a + s.minutes, 0)).toBe(w.totalMinutes);
        }
      }
    }
  });

  it('non si può chiedere un aumento più grande del 10%', () => {
    const p = buildRunPlan({ maxIncrease: 0.5 });
    expect(isProgressionSafe(totals(p))).toBe(true);
    const lenient = buildRunPlan({ maxIncrease: 0.05 });
    expect(isProgressionSafe(totals(lenient), 0.05)).toBe(true);
    expect(totals(lenient)[7]).toBeLessThan(totals(p)[7]);
  });

  it('maxNextWeekMinutes e isProgressionSafe', () => {
    expect(maxNextWeekMinutes(45)).toBe(49);
    expect(maxNextWeekMinutes(40)).toBe(44);
    expect(maxNextWeekMinutes(100)).toBe(110);
    expect(maxNextWeekMinutes(50, 0.5)).toBe(55); // il tetto resta il 10%
    expect(isProgressionSafe([40, 44, 48])).toBe(true);
    expect(isProgressionSafe([40, 45])).toBe(false);
    expect(isProgressionSafe([60, 30, 33])).toBe(true);
    expect(isProgressionSafe([])).toBe(true);
  });

  it('quasi tutto in zona 2: nessuna corsa dura', () => {
    const p = buildRunPlan({ weeks: 12 });
    for (const w of p.weeks) {
      for (const s of w.sessions) {
        expect(s.run.zone).toBe(2);
        expect(['facile', 'lungo']).toContain(s.run.type);
        expect(s.run.targetMinutes).toBe(s.minutes);
      }
    }
  });

  it('la prima settimana è quella del metodo: corsa facile da 20 minuti e corsa lunga da 25', () => {
    const p = buildRunPlan();
    expect(p.weeks[0].sessions.map((s) => [s.name, s.minutes, s.run.type, s.day])).toEqual([
      ['Corsa facile', 20, 'facile', 1],
      ['Corsa lunga facile', 25, 'lungo', 5],
    ]);
  });

  it('gli allunghi arrivano dopo quattro settimane e in una sola uscita', () => {
    const p = buildRunPlan({ weeks: 8 });
    for (const w of p.weeks) {
      const withStrides = w.sessions.filter((s) => s.run.intervals);
      if (w.week <= 4) {
        expect(w.strides).toBe(false);
        expect(withStrides).toHaveLength(0);
      } else {
        expect(w.strides).toBe(true);
        expect(withStrides).toHaveLength(1);
        expect(withStrides[0].run.type).toBe('facile');
        expect(withStrides[0].name).toBe('Corsa facile con allunghi');
        expect(withStrides[0].run.intervals).toEqual([{ reps: w.week >= 7 ? 6 : 4, workSec: 20, restSec: 60 }]);
        expect(withStrides[0].run.note).toMatch(/allunghi di 20 secondi/);
      }
    }
    expect(p.weeks[4].note).toBe('Da questa settimana una corsa include gli allunghi.');
  });

  it('con una sola uscita a settimana l\'uscita è facile e prende gli allunghi', () => {
    const p = buildRunPlan({ runsPerWeek: 1, weeks: 6, startWeeklyMinutes: 30 });
    expect(p.weeks[0].sessions).toHaveLength(1);
    expect(p.weeks[0].sessions[0]).toMatchObject({ day: 5, minutes: 30, name: 'Corsa facile' });
    expect(p.weeks[5].sessions[0].run.intervals).toBeDefined();
  });

  it('con tre uscite l\'ultima è la lunga e i giorni sono martedì, giovedì e sabato', () => {
    const p = buildRunPlan({ runsPerWeek: 3, startWeeklyMinutes: 60 });
    const w = p.weeks[0];
    expect(w.sessions.map((s) => s.day)).toEqual([1, 3, 5]);
    expect(w.sessions.map((s) => s.run.type)).toEqual(['facile', 'facile', 'lungo']);
    expect(w.sessions[2].minutes).toBeGreaterThan(w.sessions[0].minutes);
    expect(w.totalMinutes).toBe(60);
  });

  it('date: ogni settimana parte dal primo lunedì su o dopo la data di inizio', () => {
    const p = buildRunPlan({ startDate: '2026-11-23', weeks: 3 });
    expect(p.weeks.map((w) => w.start)).toEqual(['2026-11-23', '2026-11-30', '2026-12-07']);
    expect(p.weeks[0].sessions.map((s) => s.date)).toEqual(['2026-11-24', '2026-11-28']);
    const mid = buildRunPlan({ startDate: '2026-11-25', weeks: 1 });
    expect(mid.weeks[0].start).toBe('2026-11-30');
    expect(buildRunPlan().weeks[0].start).toBeUndefined();
    expect(buildRunPlan().weeks[0].sessions[0].date).toBeUndefined();
  });

  it('giorni scelti: ordinati e controllati', () => {
    const p = buildRunPlan({ days: [5, 2] });
    expect(p.weeks[0].sessions.map((s) => s.day)).toEqual([2, 5]);
    expect(() => buildRunPlan({ days: [1] })).toThrow(/giorno/);
    expect(() => buildRunPlan({ days: [1, 9] })).toThrow();
  });

  it('con una partenza oltre i limiti il piano si ferma ai tempi massimi e lo dice', () => {
    const p = buildRunPlan({ startWeeklyMinutes: 150 });
    expect(totals(p).every((m) => m === 100)).toBe(true);
    for (const w of p.weeks) {
      expect(w.sessions[0].minutes).toBeLessThanOrEqual(40);
      expect(w.sessions[1].minutes).toBeLessThanOrEqual(60);
    }
    expect(p.weeks[1].capped).toBe(true);
    expect(p.weeks[1].note).toBe('Tempo massimo raggiunto: da qui il piano non cresce più.');
    expect(p.startWeeklyMinutes).toBe(100);
  });

  it('la zona 2 della persona finisce nelle note delle uscite', () => {
    const z2 = hrZonesFromMax(190)[1];
    const p = buildRunPlan({ zone2: z2 });
    for (const s of p.weeks[0].sessions) expect(s.run.note).toMatch(/da 114 a 132 battiti al minuto/);
    expect(buildRunPlan().weeks[0].sessions[0].run.note).not.toMatch(/battiti/);
  });

  it('note di sicurezza: conversazione, cammino, gambe e pesi', () => {
    const { notes } = buildRunPlan();
    expect(notes.join(' ')).toMatch(/zona 2/);
    expect(notes.join(' ')).toMatch(/cammino/);
    expect(notes.join(' ')).toMatch(/gambe/);
  });

  it('i testi per l\'utente non usano lineette lunghe', () => {
    const p = buildRunPlan({ weeks: 12, zone2: hrZonesFromMax(190)[1] });
    const texts = [
      ...p.notes,
      ...p.weeks.flatMap((w) => [w.note ?? '', ...w.sessions.flatMap((s) => [s.name, s.run.note ?? ''])]),
    ];
    for (const t of texts) expect(t).not.toMatch(/[—–]/);
  });
});

function run(start: string, minutes: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: `manuale:${start}`,
    source: 'manuale',
    kind: 'corsa',
    typeKey: 'running',
    name: 'Corsa',
    start,
    durationSec: minutes * 60,
    ...extra,
  };
}

describe('corse recenti e punto di partenza del piano', () => {
  const today = '2026-11-23';

  it('minuti di corsa in una settimana, solo corse e nel tempo in movimento', () => {
    const acts = [
      run('2026-11-17T07:00:00+01:00', 30), // martedì
      run('2026-11-21T09:00:00+01:00', 35, { movingSec: 30 * 60 }), // sabato, 30 minuti in movimento
      run('2026-11-23T07:00:00+01:00', 40), // lunedì dopo: fuori dalla settimana
      { ...run('2026-11-18T18:00:00+01:00', 60), kind: 'forza', typeKey: 'strength_training' } as Activity,
    ];
    expect(weeklyRunMinutes(acts, '2026-11-16')).toBe(60);
    expect(weeklyRunMinutes(acts, '2026-11-23')).toBe(40);
    expect(weeklyRunMinutes([], '2026-11-16')).toBe(0);
  });

  it('media settimanale sulle ultime quattro settimane', () => {
    const acts = [
      run('2026-11-22T07:00:00+01:00', 60),
      run('2026-11-15T07:00:00+01:00', 60),
      run('2026-11-08T07:00:00+01:00', 60),
      run('2026-11-01T07:00:00+01:00', 60),
      run('2026-10-26T07:00:00+01:00', 600), // fuori dalle 4 settimane (oltre 28 giorni fa)
    ];
    expect(recentWeeklyRunMinutes(acts, today)).toBe(60);
    expect(recentWeeklyRunMinutes(acts, today, 8)).toBe(Math.round(840 / 8));
  });

  it('il piano parte da quello che fai già, se corri almeno 30 minuti a settimana', () => {
    const acts = [0, 7, 14, 21].map((d) => run(`2026-11-${String(22 - d).padStart(2, '0')}T07:00:00+01:00`, 60));
    expect(suggestStartMinutes(acts, today)).toBe(60);
    const plan = buildRunPlan({ startWeeklyMinutes: suggestStartMinutes(acts, today) });
    expect(plan.weeks[0].totalMinutes).toBe(60);
    expect(isProgressionSafe(totals(plan))).toBe(true);
  });

  it('se corri poco o niente riparte dal programma base', () => {
    expect(suggestStartMinutes([], today)).toBe(DEFAULT_START_MINUTES);
    expect(suggestStartMinutes([run('2026-11-20T07:00:00+01:00', 20)], today)).toBe(DEFAULT_START_MINUTES);
  });

  function totals(p: ReturnType<typeof buildRunPlan>) {
    return p.weeks.map((w) => w.totalMinutes);
  }
});

describe('analisi di una corsa', () => {
  const zones = hrZonesFromMax(190);

  function base(extra: Partial<Activity> = {}): Activity {
    return run('2026-11-22T07:30:00+01:00', 32, {
      distanceM: 5421,
      durationSec: 1900,
      movingSec: 1860,
      avgHr: 138,
      maxHr: 158,
      ...extra,
    });
  }

  it('km, passo medio e velocità', () => {
    const a = analyzeRun(base());
    expect(a.km).toBe(5.42);
    expect(a.durationSec).toBe(1860);
    expect(Math.round(a.paceSecPerKm!)).toBe(343);
    expect(fmtPace(a.paceSecPerKm)).toBe('5:43 /km');
    expect(a.speedKmh).toBeCloseTo(10.49, 1);
    expect(a.avgHr).toBe(138);
    expect(a.maxHr).toBe(158);
    expect(a.commento).toBe('5,42 km a 5:43 /km.');
  });

  it('il passo dell\'orologio ha la precedenza su quello calcolato', () => {
    expect(analyzeRun(base({ avgPaceSecPerKm: 340 })).paceSecPerKm).toBe(340);
  });

  it('tempo in zona dall\'orologio e quota di corsa facile', () => {
    const a = analyzeRun(base({ hrZonesSec: [120, 1500, 240, 0, 0] }));
    expect(a.zonesSec).toEqual([120, 1500, 240, 0, 0]);
    expect(a.zoneSource).toBe('orologio');
    expect(a.zonesPct).toEqual([6.5, 80.6, 12.9, 0, 0]);
    expect(a.easyPct).toBe(87.1);
    expect(a.commento).toBe('5,42 km a 5:43 /km: corsa facile ben dosata, il 87% del tempo in zona 1 e 2.');
  });

  it('senza zone dell\'orologio le ricava dalla serie della frequenza cardiaca', () => {
    const a = analyzeRun(
      base({ hrSeries: [[0, 100], [10, 100], [20, 150], [30, 150], [40, 120]] }),
      { zones },
    );
    expect(a.zonesSec).toEqual([20, 0, 20, 0, 0]);
    expect(a.zoneSource).toBe('serie-fc');
    expect(a.easyPct).toBe(50);
    expect(a.commento).toMatch(/il 50% del tempo in zona 1 e 2\. Per una corsa facile/);
  });

  it('i buchi nella serie non gonfiano il tempo in zona', () => {
    // 10 minuti senza campioni contano al massimo 30 secondi; poi 10 secondi fino all'ultimo campione
    const a = analyzeRun(base({ hrSeries: [[0, 120], [600, 120], [610, 150]] }), { zones });
    expect(a.zonesSec).toEqual([0, 40, 0, 0, 0]);
  });

  it('senza serie, usa la frequenza media dei giri', () => {
    const a = analyzeRun(
      base({
        laps: [
          { distanceM: 1000, durationSec: 360, avgHr: 120 },
          { distanceM: 1000, durationSec: 350, avgHr: 128 },
          { distanceM: 1000, durationSec: 340, avgHr: 160 },
        ],
      }),
      { zones },
    );
    expect(a.zoneSource).toBe('giri');
    expect(a.zonesSec).toEqual([0, 710, 0, 340, 0]);
    expect(a.laps.map((l) => l.zone)).toEqual([2, 2, 4]);
    expect(a.commento).toMatch(/corsa intensa|il 68% del tempo/);
  });

  it('senza zone e senza dati cardiaci non inventa nulla', () => {
    const a = analyzeRun(base({ avgHr: undefined, maxHr: undefined }));
    expect(a.zonesSec).toBeUndefined();
    expect(a.easyPct).toBeUndefined();
    expect(a.avgHr).toBeUndefined();
    expect(analyzeRun(base({ hrSeries: [[0, 120], [10, 130]] })).zonesSec).toBeUndefined();
  });

  it('giri più veloci: passo dei giri, senza i frammenti troppo corti', () => {
    const laps = [
      { distanceM: 1000, durationSec: 340 },
      { distanceM: 1000, durationSec: 330 },
      { distanceM: 1000, durationSec: 325 },
      { distanceM: 1000, durationSec: 320 },
      { distanceM: 1000, durationSec: 345 },
      { distanceM: 50, durationSec: 12 }, // ultimo pezzo: 240 s/km ma troppo corto per contare
      { distanceM: 1000, durationSec: 999, avgPaceSecPerKm: 300 }, // il passo dell'orologio vale più del calcolo
    ];
    const a = analyzeRun(base({ laps }));
    expect(a.laps).toHaveLength(7);
    expect(a.laps[3]).toMatchObject({ index: 4, distanceM: 1000, durationSec: 320, paceSecPerKm: 320 });
    expect(a.fastestLaps.map((l) => [l.index, l.paceSecPerKm])).toEqual([[7, 300], [4, 320], [3, 325]]);
    expect(analyzeRun(base({ laps }), { topLaps: 1 }).fastestLaps).toHaveLength(1);
    expect(analyzeRun(base({ laps }), { minLapM: 10 }).fastestLaps[0].index).toBe(6);
    expect(analyzeRun(base()).fastestLaps).toEqual([]);
  });

  it('un\'attività senza distanza (pesi) non rompe nulla', () => {
    const a = analyzeRun({ ...run('2026-11-22T18:00:00+01:00', 50), kind: 'forza', typeKey: 'strength_training' } as Activity);
    expect(a.km).toBe(0);
    expect(a.paceSecPerKm).toBeUndefined();
    expect(a.durationSec).toBe(3000);
  });

  it('i commenti non usano lineette lunghe né toni di rimprovero', () => {
    const variants = [
      analyzeRun(base({ hrZonesSec: [100, 1500, 260, 0, 0] })),
      analyzeRun(base({ hrZonesSec: [0, 1100, 500, 260, 0] })),
      analyzeRun(base({ hrZonesSec: [0, 100, 900, 800, 60] })),
      analyzeRun(base()),
    ];
    for (const v of variants) {
      expect(v.commento).not.toMatch(/[—–]/);
      expect(v.commento).not.toMatch(/sbagli|male|colpa|devi/i);
    }
    expect(variants[2].commento).toMatch(/corsa intensa/);
    expect(variants[1].commento).toMatch(/parti un po' più piano/);
  });
});
