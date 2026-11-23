import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/db';
import { clearDemo, loadDemo, stripDemoDay } from './demo';

const NOW = new Date('2026-11-23T10:00:00');

describe('dati di prova', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('caricati e poi cancellati non lasciano traccia', async () => {
    await loadDemo(NOW);
    expect(await db.sessions.count()).toBeGreaterThan(5);
    expect(await db.programs.count()).toBe(1);
    expect((await db.programs.toArray())[0].active).toBe(true);
    expect(await db.templates.count()).toBeGreaterThan(1);
    expect(await db.foodLog.count()).toBeGreaterThan(10);
    await clearDemo();
    for (const t of [db.sessions, db.programs, db.templates, db.activities, db.foodLog, db.wellness, db.weights]) {
      expect(await t.count()).toBe(0);
    }
    expect(await db.settings.get('demo.loaded')).toBeUndefined();
  });

  it('non tocca i dati veri e non ruba la scheda attiva', async () => {
    const at = '2026-11-01T10:00:00+01:00';
    await db.programs.put({ id: 'mia', name: 'La mia scheda', active: true, createdAt: at, updatedAt: at });
    await db.weights.put({ date: '2026-11-23', kg: 80.4, source: 'manuale' });
    await db.wellness.put({ date: '2026-11-22', source: 'garmin', sleepSec: 25000 });
    await db.foodLog.add({ date: '2026-11-23', time: '08:00', slot: 'colazione', items: [], method: 'manuale', createdAt: at });

    await loadDemo(NOW);
    const demoProgram = (await db.programs.toArray()).find((p) => p.id !== 'mia')!;
    expect(demoProgram.active).toBe(false);
    expect((await db.programs.get('mia'))!.active).toBe(true);
    expect((await db.weights.get('2026-11-23'))!.kg).toBe(80.4);

    await clearDemo();
    expect(await db.programs.count()).toBe(1);
    expect((await db.weights.get('2026-11-23'))?.kg).toBe(80.4);
    expect((await db.wellness.get('2026-11-22'))?.sleepSec).toBe(25000);
    expect(await db.foodLog.count()).toBe(1);
  });

  it('cancellando la prova restano come ti senti, i dati veri del Garmin e i pesi veri', async () => {
    await loadDemo(NOW);
    const days = (await db.wellness.toArray()).map((w) => w.date).sort();
    const [garminDay, feelingDay] = [days[3], days[days.length - 1]];
    // come ti senti, oggi, sopra la giornata di prova
    const f = (await db.wellness.get(feelingDay))!;
    await db.wellness.put({ ...f, energy: 4, mood: 4, soreness: 2 });
    // la sync Garmin unisce i dati veri a una giornata di prova (come importBundle)
    const g = (await db.wellness.get(garminDay))!;
    await db.wellness.put({ ...g, source: 'garmin', sleepSec: 26123, restingHr: 49 });
    // un peso vero al posto di uno di prova
    const demoWeight = (await db.weights.toArray())[0];
    await db.weights.put({ date: demoWeight.date, kg: demoWeight.kg + 3.3, source: 'manuale' });

    await clearDemo();
    expect(await db.wellness.get(feelingDay)).toEqual({ date: feelingDay, source: 'manuale', energy: 4, mood: 4, soreness: 2 });
    expect(await db.wellness.get(garminDay)).toEqual({ date: garminDay, source: 'garmin', sleepSec: 26123, restingHr: 49 });
    expect(await db.wellness.count()).toBe(2);
    expect((await db.weights.get(demoWeight.date))?.kg).toBeCloseTo(demoWeight.kg + 3.3, 5);
    expect(await db.weights.count()).toBe(1);
  });

  it('stripDemoDay: senza niente di nuovo la giornata sparisce', () => {
    const demo = { date: '2026-11-01', source: 'garmin' as const, sleepSec: 25000, restingHr: 55 };
    expect(stripDemoDay({ ...demo }, demo)).toBeNull();
    expect(stripDemoDay({ ...demo, mood: 2 }, demo)).toEqual({ date: '2026-11-01', source: 'manuale', mood: 2 });
  });
});
