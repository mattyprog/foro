import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/db';
import { decryptJson } from '@/lib/garmin/envelope';
import { dataUrlToBlob, exportBackup, restoreBackup } from './backup';

const AT = '2026-11-23T10:00:00+01:00';
const PASS = 'tavolo lampone vela ottobre';

async function seed() {
  await db.profile.put({ id: 'me', sex: 'M', birthDate: '1999-05-10', heightCm: 178, weightKg: 72, goal: 'massa', experience: 'nuovo', gymDaysPerWeek: 3, runDaysPerWeek: 2, dailyActivity: 'leggero', mealsPerDay: 4, diet: 'onnivora', allergies: [], excludedFoods: [], createdAt: AT, updatedAt: AT });
  await db.weights.bulkPut([{ date: '2026-11-22', kg: 72.1, source: 'manuale' }, { date: '2026-11-23', kg: 71.9, source: 'manuale' }]);
  await db.foodLog.add({
    date: '2026-11-23', time: '13:00', slot: 'pranzo', method: 'foto', createdAt: AT,
    items: [{ name: 'Pasta e ceci', grams: 350, nutrients: { kcal: 520, protein: 22, carbs: 78, fat: 11 }, source: 'ricetta', confidence: 'alta' }],
    photoThumb: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
  });
  await db.settings.bulkPut([
    { key: 'theme', value: 'dark' },
    { key: 'gemini.apiKey', value: 'chiave-segreta-di-prova' },
    { key: 'garmin.passphrase', value: 'password-segreta-di-prova' },
  ]);
}

describe('copia di sicurezza', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('esporta senza segreti e ripristina tutto, miniature comprese', async () => {
    await seed();
    const { blob } = await exportBackup(PASS);
    const text = await blob.text();
    expect(text).not.toContain('chiave-segreta');
    const plain = JSON.stringify(await decryptJson(JSON.parse(text), PASS));
    expect(plain).not.toContain('chiave-segreta');
    expect(plain).not.toContain('password-segreta');

    // telefono nuovo: altri dati e altre chiavi, che devono restare
    await db.delete();
    await db.open();
    await db.weights.put({ date: '2026-01-01', kg: 99, source: 'manuale' });
    await db.settings.put({ key: 'gemini.apiKey', value: 'chiave-del-telefono-nuovo' });

    const n = await restoreBackup(text, PASS);
    expect(n).toBeGreaterThan(4);
    expect((await db.profile.get('me'))?.weightKg).toBe(72);
    expect((await db.weights.toArray()).map((w) => w.date)).toEqual(['2026-11-22', '2026-11-23']);
    const entry = (await db.foodLog.toArray())[0];
    expect(entry.items[0].name).toBe('Pasta e ceci');
    expect(entry.photoThumb).toBeInstanceOf(Blob);
    expect(new Uint8Array(await entry.photoThumb!.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect((await db.settings.get('theme'))?.value).toBe('dark');
    expect((await db.settings.get('gemini.apiKey'))?.value).toBe('chiave-del-telefono-nuovo');
    expect(await db.settings.get('garmin.passphrase')).toBeUndefined();
  });

  it('password sbagliata o file rovinato: non tocca niente', async () => {
    await seed();
    const { blob } = await exportBackup(PASS);
    const text = await blob.text();
    await expect(restoreBackup(text, 'password sbagliata davvero')).rejects.toThrow();
    await expect(restoreBackup('{non json', PASS)).rejects.toThrow('non è un backup');
    expect(await db.weights.count()).toBe(2);
    expect(await db.foodLog.count()).toBe(1);
  });

  it('le tabelle che il backup non contiene restano come sono', async () => {
    await seed();
    const env = JSON.parse(await (await exportBackup(PASS)).blob.text());
    const file = (await decryptJson(env, PASS)) as { tables: Record<string, unknown> };
    delete file.tables.weights;
    const { encryptJson } = await import('@/lib/garmin/envelope');
    const partial = JSON.stringify(await encryptJson(file, PASS));
    await db.weights.put({ date: '2026-11-24', kg: 71.5, source: 'manuale' });
    await restoreBackup(partial, PASS);
    expect(await db.weights.count()).toBe(3);
  });

  it('data URL -> Blob', async () => {
    const b = dataUrlToBlob('data:image/jpeg;base64,/9j/2Q==');
    expect(b.type).toBe('image/jpeg');
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(() => dataUrlToBlob('non un data url')).toThrow();
  });
});
