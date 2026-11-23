/**
 * Scarica la busta cifrata pubblicata dalla GitHub Action sul ramo `data` del repository.
 *
 * - URL predefinito: https://raw.githubusercontent.com/<owner>/<repo>/data/garmin.json.enc
 *   (raw.githubusercontent.com risponde con CORS aperto, nessun header personalizzato: niente preflight);
 * - cache-busting con ?t=<ora> e `cache: 'no-store'` (il CDN di GitHub tiene i file qualche minuto);
 * - timeout; errori tipizzati con `name` stabile, che la UI usa per il messaggio in italiano.
 */
import type { EncryptedEnvelope, SyncBundle } from '@/db/types';
import { CorruptedEnvelopeError, decryptEnvelope, parseEnvelope } from './envelope';

export const DATA_BRANCH = 'data';
export const ENVELOPE_FILE = 'garmin.json.enc';
export const META_FILE = 'meta.json';
export const DEFAULT_TIMEOUT_MS = 20_000;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,200}$/;

/* ------------------------------------------------------------------ errori */

export class BundleFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BundleFetchError';
  }
}

/** Rete assente, CDN o GitHub non raggiungibili, risposta HTTP non riuscita. */
export class BundleNetworkError extends BundleFetchError {
  readonly status?: number;
  constructor(message = 'Rete non disponibile.', options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.name = 'BundleNetworkError';
    this.status = options?.status;
  }
}

/** Nessuna risposta entro il tempo massimo. */
export class BundleTimeoutError extends BundleNetworkError {
  constructor(message = 'Tempo scaduto: GitHub non ha risposto.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'BundleTimeoutError';
  }
}

/** 404: il file non esiste, cioè la sync non è mai stata eseguita (o il repository è sbagliato). */
export class BundleNotFoundError extends BundleFetchError {
  constructor(message = 'Nessun pacchetto pubblicato: la prima sync non è ancora partita.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'BundleNotFoundError';
  }
}

/* ------------------------------------------------------------------ URL */

export function envelopeUrl(owner: string, repo: string, opts: { branch?: string; file?: string } = {}): string {
  const branch = opts.branch ?? DATA_BRANCH;
  const file = opts.file ?? ENVELOPE_FILE;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || !BRANCH_RE.test(branch) || !NAME_RE.test(file) || branch.includes('..')) {
    throw new TypeError('Repository non valido: usa la forma utente/repo.');
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`;
}

export interface FetchBundleOptions {
  /** URL completo del file (ha la precedenza su owner/repo). */
  url?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per i test o per ambienti senza fetch globale. */
  fetch?: typeof fetch;
  /** Orologio per il cache-busting (test). */
  now?: () => number;
}

function resolveUrl(opts: FetchBundleOptions, file: string): string {
  if (opts.url) {
    if (file === ENVELOPE_FILE) return opts.url;
    return new URL(file, opts.url).toString();
  }
  if (opts.owner && opts.repo) return envelopeUrl(opts.owner, opts.repo, { branch: opts.branch, file });
  throw new TypeError('Serve un URL oppure owner e repo.');
}

function withCacheBust(url: string, t: number): string {
  const u = new URL(url);
  u.searchParams.set('t', String(t));
  return u.toString();
}

function normalizeArgs(source: string | FetchBundleOptions | undefined, options: FetchBundleOptions): FetchBundleOptions {
  if (typeof source === 'string') return { ...options, url: source };
  return { ...source, ...options };
}

async function fetchText(opts: FetchBundleOptions, file: string): Promise<string> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = withCacheBust(resolveUrl(opts, file), (opts.now ?? Date.now)());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const external = opts.signal;
  const onAbort = () => ctrl.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await doFetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: ctrl.signal });
    } catch (e) {
      if (timedOut) throw new BundleTimeoutError(undefined, { cause: e });
      if (external?.aborted) throw e;
      throw new BundleNetworkError('Rete non disponibile.', { cause: e });
    }
    if (res.status === 404) throw new BundleNotFoundError();
    if (!res.ok) throw new BundleNetworkError(`GitHub ha risposto con l'errore HTTP ${res.status}.`, { status: res.status });
    try {
      return await res.text();
    } catch (e) {
      if (timedOut) throw new BundleTimeoutError(undefined, { cause: e });
      if (external?.aborted) throw e;
      throw new BundleNetworkError('Download interrotto.', { cause: e });
    }
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

/**
 * Scarica la busta cifrata (non la decifra). `source` è l'URL completo oppure le opzioni con owner/repo.
 * Errori: BundleNotFoundError (404), BundleNetworkError / BundleTimeoutError, CorruptedEnvelopeError,
 * UnsupportedVersionError.
 */
export async function fetchBundle(source?: string | FetchBundleOptions, options: FetchBundleOptions = {}): Promise<EncryptedEnvelope> {
  const text = await fetchText(normalizeArgs(source, options), ENVELOPE_FILE);
  return parseEnvelope(text);
}

/** Scarica e decifra: comodo quando non serve tenere la busta. */
export async function fetchAndDecryptBundle(
  source: string | FetchBundleOptions,
  passphrase: string,
  options: FetchBundleOptions = {},
): Promise<{ envelope: EncryptedEnvelope; bundle: SyncBundle }> {
  const envelope = await fetchBundle(source, options);
  return { envelope, bundle: await decryptEnvelope(envelope, passphrase) };
}

export interface SyncMeta {
  v: 1;
  generatedAt: string;
}

/** Legge meta.json ({v, generatedAt}): pochi byte, per sapere se c'è un pacchetto nuovo prima di scaricarlo. */
export async function fetchSyncMeta(source?: string | FetchBundleOptions, options: FetchBundleOptions = {}): Promise<SyncMeta> {
  const text = await fetchText(normalizeArgs(source, options), META_FILE);
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch (e) {
    throw new CorruptedEnvelopeError('meta.json non valido.', { cause: e });
  }
  const m = meta as Partial<SyncMeta> | null;
  if (!m || m.v !== 1 || typeof m.generatedAt !== 'string') throw new CorruptedEnvelopeError('meta.json non valido.');
  return { v: 1, generatedAt: m.generatedAt };
}
