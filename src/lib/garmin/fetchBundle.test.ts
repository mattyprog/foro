import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CorruptedEnvelopeError, UnsupportedVersionError } from './envelope';
import {
  BundleNetworkError,
  BundleNotFoundError,
  BundleTimeoutError,
  envelopeUrl,
  fetchAndDecryptBundle,
  fetchBundle,
  fetchSyncMeta,
} from './fetchBundle';

const PASS = 'prova-foro-solo-test-2026';
const sampleText = readFileSync(
  fileURLToPath(new URL('../../../tests/fixtures/garmin-envelope.sample.json', import.meta.url)),
  'utf8',
);

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit | undefined][] };
  };
}

describe('fetchBundle', () => {
  it('costruisce l’URL raw del ramo data da owner/repo', () => {
    expect(envelopeUrl('mattyprog', 'foro')).toBe('https://raw.githubusercontent.com/mattyprog/foro/data/garmin.json.enc');
    expect(envelopeUrl('mattyprog', 'foro', { file: 'meta.json' })).toBe(
      'https://raw.githubusercontent.com/mattyprog/foro/data/meta.json',
    );
    expect(() => envelopeUrl('matty/prog', 'foro')).toThrow(TypeError);
    expect(() => envelopeUrl('mattyprog', '../x?y')).toThrow(TypeError);
  });

  it('scarica la busta con cache-busting e senza cache del browser', async () => {
    const f = fakeFetch(() => new Response(sampleText, { status: 200 }));
    const env = await fetchBundle('https://example.test/data/garmin.json.enc', { fetch: f, now: () => 1234 });
    expect(env.v).toBe(1);
    expect(env.iter).toBe(600_000);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://example.test/data/garmin.json.enc?t=1234');
    expect(init?.cache).toBe('no-store');
    expect(init?.credentials).toBe('omit');
  });

  it('accetta anche owner e repo come opzioni', async () => {
    const f = fakeFetch(() => new Response(sampleText));
    await fetchBundle({ owner: 'mattyprog', repo: 'foro', fetch: f, now: () => 1 });
    expect(f.mock.calls[0][0]).toBe('https://raw.githubusercontent.com/mattyprog/foro/data/garmin.json.enc?t=1');
  });

  it('404: la sync non è mai stata eseguita', async () => {
    const f = fakeFetch(() => new Response('404: Not Found', { status: 404 }));
    const err = await fetchBundle('https://example.test/x', { fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleNotFoundError);
    expect((err as Error).name).toBe('BundleNotFoundError');
  });

  it('errori di rete e risposte HTTP non riuscite', async () => {
    const offline = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const e1 = await fetchBundle('https://example.test/x', { fetch: offline }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BundleNetworkError);
    expect((e1 as Error).name).toBe('BundleNetworkError');
    const server = fakeFetch(() => new Response('boom', { status: 503 }));
    const e2 = await fetchBundle('https://example.test/x', { fetch: server }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(BundleNetworkError);
    expect((e2 as BundleNetworkError).status).toBe(503);
    expect((e2 as Error).message).not.toContain('404');
  });

  it('timeout', async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const err = await fetchBundle('https://example.test/x', { fetch: hang, timeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleTimeoutError);
    expect(err).toBeInstanceOf(BundleNetworkError);
    expect((err as Error).name).toBe('BundleTimeoutError');
  });

  it('annullamento da parte dell’app', async () => {
    const ctrl = new AbortController();
    const hang = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const p = fetchBundle('https://example.test/x', { fetch: hang, signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
  });

  it('busta corrotta o di una versione futura', async () => {
    const html = fakeFetch(() => new Response('<html>pagina di errore</html>'));
    await expect(fetchBundle('https://example.test/x', { fetch: html })).rejects.toBeInstanceOf(CorruptedEnvelopeError);
    const future = fakeFetch(() => new Response(JSON.stringify({ ...JSON.parse(sampleText), v: 9 })));
    await expect(fetchBundle('https://example.test/x', { fetch: future })).rejects.toBeInstanceOf(UnsupportedVersionError);
  });

  it('scarica e decifra in un passo', async () => {
    const f = fakeFetch(() => new Response(sampleText));
    const { envelope, bundle } = await fetchAndDecryptBundle('https://example.test/x', PASS, { fetch: f });
    expect(envelope.generatedAt).toBe(bundle.generatedAt);
    expect(bundle.activities).toHaveLength(7);
  });

  it('legge meta.json accanto alla busta', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ v: 1, generatedAt: '2026-11-20T09:23:00Z' })));
    const meta = await fetchSyncMeta({ owner: 'mattyprog', repo: 'foro', fetch: f, now: () => 5 });
    expect(meta).toEqual({ v: 1, generatedAt: '2026-11-20T09:23:00Z' });
    expect(f.mock.calls[0][0]).toBe('https://raw.githubusercontent.com/mattyprog/foro/data/meta.json?t=5');
  });
});
