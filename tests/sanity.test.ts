import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { AppDB } from '../src/db/db';

describe('db', () => {
  it('apre lo schema e scrive un peso', async () => {
    const db = new AppDB('test-sanity');
    await db.weights.put({ date: '2026-11-23', kg: 70, source: 'manuale' });
    expect((await db.weights.get('2026-11-23'))?.kg).toBe(70);
    await db.delete();
  });
});
