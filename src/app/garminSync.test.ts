import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, setSetting } from '@/db/db';
import { LAST_BUNDLE_KEY } from '@/lib/garmin/importBundle';
import { hasNewBundle } from './garminSync';

const meta = (generatedAt: string) => vi.fn(async () => new Response(JSON.stringify({ v: 1, generatedAt }), { status: 200 }));

describe('sync Garmin: controllo leggero di meta.json', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prima sync: c’è sempre qualcosa da scaricare, senza chiedere meta.json', async () => {
    const f = meta('2026-11-23T09:00:00Z');
    vi.stubGlobal('fetch', f);
    expect(await hasNewBundle('mattyprog/foro')).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('pacchetto uguale all’ultimo importato: niente download della busta', async () => {
    await setSetting(LAST_BUNDLE_KEY, '2026-11-23T09:00:00Z');
    const f = meta('2026-11-23T09:00:00Z');
    vi.stubGlobal('fetch', f);
    expect(await hasNewBundle('mattyprog/foro')).toBe(false);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('/data/meta.json');
  });

  it('pacchetto più nuovo, o meta.json illeggibile: si scarica', async () => {
    await setSetting(LAST_BUNDLE_KEY, '2026-11-23T09:00:00Z');
    vi.stubGlobal('fetch', meta('2026-11-23T12:00:00Z'));
    expect(await hasNewBundle('mattyprog/foro')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('non json', { status: 200 })));
    expect(await hasNewBundle('mattyprog/foro')).toBe(true);
  });
});
