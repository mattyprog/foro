import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDB } from '@/db/db';
import type { Activity, SyncBundle } from '@/db/types';
import { decryptEnvelope } from './envelope';
import { LAST_BUNDLE_KEY, importBundle } from './importBundle';

const PASS = 'prova-foro-solo-test-2026';
let n = 0;
const dbs: AppDB[] = [];

function freshDb(): AppDB {
  const db = new AppDB(`test-import-${Date.now()}-${n++}`);
  dbs.push(db);
  return db;
}

afterEach(async () => {
  while (dbs.length) await dbs.pop()!.delete();
});

const run: Activity = {
  id: 'garmin:1',
  source: 'garmin',
  kind: 'corsa',
  typeKey: 'running',
  name: 'Corsa facile',
  start: '2026-11-18T07:00:05+01:00',
  durationSec: 900,
  distanceM: 3000,
  track: [
    [38.86, -94.79],
    [38.87, -94.78],
  ],
};

function bundle(over: Partial<SyncBundle> = {}): SyncBundle {
  return {
    version: 1,
    generatedAt: '2026-11-20T09:23:00Z',
    range: { from: '2025-11-20', to: '2026-11-20' },
    activities: [run],
    wellness: [
      { date: '2026-11-19', source: 'garmin', sleepSec: 25200, steps: 8000, hrvNightAvg: 61 },
      { date: '2026-11-20', source: 'garmin', steps: 3000 },
    ],
    weights: [
      { date: '2026-11-19', kg: 72.4, source: 'garmin' },
      { date: '2026-11-20', kg: 72.2, source: 'garmin', bodyFatPct: 17.9 },
    ],
    warnings: [],
    ...over,
  };
}

describe('importBundle', () => {
  it('importa attività, benessere e pesi in un database vuoto', async () => {
    const db = freshDb();
    const res = await importBundle(db, bundle());
    expect(res.stale).toBe(false);
    expect(res.activities).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
    expect(res.wellness).toMatchObject({ added: 2, updated: 0 });
    expect(res.weights).toMatchObject({ added: 2, updated: 0, keptManual: 0 });
    expect(await db.activities.get('garmin:1')).toEqual(run);
    expect((await db.wellness.get('2026-11-19'))?.hrvNightAvg).toBe(61);
    expect((await db.settings.get(LAST_BUNDLE_KEY))?.value).toBe('2026-11-20T09:23:00Z');
  });

  it('è idempotente: reimportare lo stesso pacchetto non cambia nulla', async () => {
    const db = freshDb();
    await importBundle(db, bundle());
    const before = await db.activities.toArray();
    const res = await importBundle(db, bundle());
    expect(res.activities).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(res.wellness).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(res.weights).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(await db.activities.toArray()).toEqual(before);
  });

  it('unisce il benessere senza cancellare i campi inseriti a mano', async () => {
    const db = freshDb();
    await db.wellness.put({ date: '2026-11-19', source: 'manuale', mood: 4, energy: 3, soreness: 2, sleepSec: 1000 });
    const res = await importBundle(
      db,
      bundle({ wellness: [{ date: '2026-11-19', source: 'garmin', sleepSec: 25200, steps: 8000, mood: 1 } as never] }),
    );
    expect(res.wellness).toMatchObject({ added: 0, updated: 1 });
    expect(await db.wellness.get('2026-11-19')).toEqual({
      date: '2026-11-19',
      source: 'garmin',
      mood: 4,
      energy: 3,
      soreness: 2,
      sleepSec: 25200,
      steps: 8000,
    });
  });

  it('per i pesi della stessa data vince quello inserito a mano', async () => {
    const db = freshDb();
    await db.weights.bulkPut([
      { date: '2026-11-19', kg: 70.0, source: 'manuale' },
      { date: '2026-11-20', kg: 75.0, source: 'garmin' },
    ]);
    const res = await importBundle(db, bundle());
    expect(res.weights).toMatchObject({ added: 0, updated: 1, keptManual: 1 });
    expect(await db.weights.get('2026-11-19')).toEqual({ date: '2026-11-19', kg: 70.0, source: 'manuale' });
    expect(await db.weights.get('2026-11-20')).toEqual({ date: '2026-11-20', kg: 72.2, source: 'garmin', bodyFatPct: 17.9 });
  });

  it('aggiorna le attività per id e conserva i dettagli che il pacchetto non porta più', async () => {
    const db = freshDb();
    await importBundle(db, bundle());
    const { track: _track, ...summaryOnly } = run;
    const res = await importBundle(
      db,
      bundle({ generatedAt: '2026-11-21T09:23:00Z', activities: [{ ...summaryOnly, name: 'Corsa rinominata' }] }),
    );
    expect(res.activities).toMatchObject({ added: 0, updated: 1 });
    const stored = await db.activities.get('garmin:1');
    expect(stored?.name).toBe('Corsa rinominata');
    expect(stored?.track).toEqual(run.track);
  });

  it('sostituisce il doppione importato da FIT con l’attività Garmin, senza perdere dettagli e collegamenti', async () => {
    const db = freshDb();
    const fit: Activity = {
      id: 'fit:0123456789abcdef',
      source: 'fit',
      kind: 'corsa',
      typeKey: 'running',
      name: 'Corsa',
      start: '2026-11-18T06:01:00Z', // 55 s dopo l'inizio Garmin (07:00:05+01:00)
      durationSec: 905,
      hrSeries: [
        [0, 120],
        [60, 140],
      ],
    };
    await db.activities.put(fit);
    const sessionId = await db.sessions.add({ date: '2026-11-18', startedAt: '2026-11-18T07:00:00+01:00', sets: [], activityId: fit.id });
    const res = await importBundle(db, bundle());
    expect(res.activities).toMatchObject({ added: 0, merged: 1 });
    expect(await db.activities.get(fit.id)).toBeUndefined();
    const merged = await db.activities.get('garmin:1');
    expect(merged?.hrSeries).toEqual(fit.hrSeries);
    expect(merged?.track).toEqual(run.track);
    expect((await db.sessions.get(sessionId))?.activityId).toBe('garmin:1');
  });

  it('non tocca un’attività FIT di tipo diverso o lontana nel tempo', async () => {
    const db = freshDb();
    const walk: Activity = { ...run, id: 'fit:aaaa', source: 'fit', kind: 'camminata', typeKey: 'walking', start: run.start };
    const late: Activity = { ...run, id: 'fit:bbbb', source: 'fit', start: '2026-11-18T07:03:00+01:00' };
    await db.activities.bulkPut([walk, late]);
    const res = await importBundle(db, bundle());
    expect(res.activities).toMatchObject({ added: 1, merged: 0 });
    expect(await db.activities.count()).toBe(3);
  });

  it('ignora un pacchetto più vecchio di quello già importato', async () => {
    const db = freshDb();
    await importBundle(db, bundle({ generatedAt: '2026-11-21T00:00:00Z' }));
    const res = await importBundle(db, bundle({ generatedAt: '2026-11-20T00:00:00Z', activities: [{ ...run, name: 'vecchio' }] }));
    expect(res.stale).toBe(true);
    expect((await db.activities.get('garmin:1'))?.name).toBe('Corsa facile');
    expect((await db.settings.get(LAST_BUNDLE_KEY))?.value).toBe('2026-11-21T00:00:00Z');
  });

  it('salta gli elementi malformati', async () => {
    const db = freshDb();
    const res = await importBundle(
      db,
      bundle({
        activities: [run, { name: 'senza id' } as never],
        wellness: [{ steps: 1 } as never],
        weights: [{ date: '2026-11-19', kg: 'tanti' } as never],
      }),
    );
    expect(res.activities.added).toBe(1);
    expect(res.activities.skipped).toBe(1);
    expect(await db.wellness.count()).toBe(0);
    expect(await db.weights.count()).toBe(0);
  });

  it('importa il pacchetto di esempio prodotto dallo script Python', async () => {
    const db = freshDb();
    const sample = readFileSync(
      fileURLToPath(new URL('../../../tests/fixtures/garmin-envelope.sample.json', import.meta.url)),
      'utf8',
    );
    const decoded = await decryptEnvelope(sample, PASS);
    const res = await importBundle(db, decoded);
    expect(res.activities.added).toBe(7);
    expect(res.wellness.added).toBe(91);
    expect(res.weights.added).toBe(105);
    expect(await db.activities.where('kind').equals('forza').count()).toBe(2);
    const again = await importBundle(db, decoded);
    expect(again.activities.unchanged + again.wellness.unchanged + again.weights.unchanged).toBe(7 + 91 + 105);
  });
});
