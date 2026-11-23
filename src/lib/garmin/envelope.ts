/**
 * Busta cifrata (contratto EncryptedEnvelope): la usa la sync Garmin e anche il backup dell'app.
 *
 * Formato, identico a scripts/sync/garmin_bridge/envelope.py:
 *   dati   = gzip(JSON UTF-8)
 *   chiave = PBKDF2-HMAC-SHA256(password normalizzata NFC, salt 16 byte, iter) -> AES-256
 *   ct     = AES-256-GCM(chiave, iv 12 byte, dati), con il tag GCM (16 byte) in coda
 *   busta  = { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter, salt, iv, ct, generatedAt }
 *
 * Funziona nel browser (contesto sicuro: HTTPS o localhost) e in Node 22: WebCrypto e
 * CompressionStream/DecompressionStream sono globali in entrambi.
 */
import type { EncryptedEnvelope, SyncBundle } from '@/db/types';

export const ENVELOPE_VERSION = 1 as const;
export const ENVELOPE_ALG = 'AES-256-GCM' as const;
export const ENVELOPE_KDF = 'PBKDF2-SHA256' as const;
export const DEFAULT_ITERATIONS = 600_000;
/** Limiti accettati: sotto e' inutile, sopra bloccherebbe il telefono per minuti. */
export const MIN_ITERATIONS = 1_000;
export const MAX_ITERATIONS = 10_000_000;
/** Tetto al JSON decompresso: un anno di dati pesa pochi MB, un gzip malevolo di pochi KB può gonfiarsi a GB. */
export const MAX_PLAIN_BYTES = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Bytes = Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ errori */

export class EnvelopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnvelopeError';
  }
}

/** Autenticazione GCM fallita: password sbagliata (o file alterato, GCM non distingue). */
export class WrongPassphraseError extends EnvelopeError {
  constructor(message = 'Password sbagliata.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'WrongPassphraseError';
  }
}

/** Busta malformata o contenuto illeggibile. */
export class CorruptedEnvelopeError extends EnvelopeError {
  constructor(message = 'File cifrato danneggiato.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CorruptedEnvelopeError';
  }
}

/** Versione, algoritmo o KDF non supportati (es. file prodotto da una versione piu' nuova). */
export class UnsupportedVersionError extends EnvelopeError {
  constructor(message = 'Versione del file non supportata.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsupportedVersionError';
  }
}

/* ------------------------------------------------------------------ base64 e gzip */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Bytes {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new CorruptedEnvelopeError('Base64 non valido.');
  }
  const bin = atob(clean);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function transform(data: Bytes, stream: CompressionStream | DecompressionStream, maxBytes = Infinity): Promise<Bytes> {
  const writer = stream.writable.getWriter();
  // gli errori arrivano anche dal lato di lettura: qui si evitano solo i rifiuti non gestiti
  writer.write(data).catch(() => undefined);
  writer.close().catch(() => undefined);
  // lettura a pezzi: oltre il tetto si smette subito, senza tenere tutto in memoria
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CorruptedEnvelopeError('Contenuto troppo grande per un pacchetto di sync.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const gzip = (data: Bytes) => transform(data, new CompressionStream('gzip'));
const gunzip = (data: Bytes, maxBytes: number) => transform(data, new DecompressionStream('gzip'), maxBytes);

/* ------------------------------------------------------------------ chiave */

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new EnvelopeError('Cifratura non disponibile: serve una pagina HTTPS.');
  return s;
}

function normalizePassphrase(passphrase: unknown): string {
  return typeof passphrase === 'string' ? passphrase.normalize('NFC') : '';
}

async function deriveKey(passphrase: string, salt: Bytes, iterations: number, usage: KeyUsage[]): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(passphrase) as Bytes;
  const base = await subtle().importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

/* ------------------------------------------------------------------ busta */

interface ParsedEnvelope {
  envelope: EncryptedEnvelope;
  salt: Bytes;
  iv: Bytes;
  ct: Bytes;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseInternal(input: unknown): ParsedEnvelope {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new CorruptedEnvelopeError('Il file non è JSON.', { cause: e });
    }
  }
  if (!isRecord(obj)) throw new CorruptedEnvelopeError('Il file non contiene una busta cifrata.');
  const { v, alg, kdf, iter, salt, iv, ct, generatedAt } = obj;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new CorruptedEnvelopeError('Versione mancante.');
  if (v !== ENVELOPE_VERSION) throw new UnsupportedVersionError();
  if (alg !== ENVELOPE_ALG || kdf !== ENVELOPE_KDF) throw new UnsupportedVersionError('Algoritmo di cifratura non supportato.');
  if (typeof iter !== 'number' || !Number.isInteger(iter) || iter < MIN_ITERATIONS || iter > MAX_ITERATIONS) {
    throw new CorruptedEnvelopeError('Parametri di cifratura non validi.');
  }
  if (typeof salt !== 'string' || typeof iv !== 'string' || typeof ct !== 'string' || typeof generatedAt !== 'string') {
    throw new CorruptedEnvelopeError('Campi della busta mancanti.');
  }
  const saltB = base64ToBytes(salt);
  const ivB = base64ToBytes(iv);
  const ctB = base64ToBytes(ct);
  if (saltB.length < SALT_BYTES || ivB.length !== IV_BYTES || ctB.length <= TAG_BYTES) {
    throw new CorruptedEnvelopeError('Lunghezze della busta non valide.');
  }
  const envelope: EncryptedEnvelope = { v: ENVELOPE_VERSION, alg: ENVELOPE_ALG, kdf: ENVELOPE_KDF, iter, salt, iv, ct, generatedAt };
  return { envelope, salt: saltB, iv: ivB, ct: ctB };
}

/** Valida la struttura di una busta (oggetto o testo JSON) senza decifrarla. */
export function parseEnvelope(input: unknown): EncryptedEnvelope {
  return parseInternal(input).envelope;
}

export interface EncryptOptions {
  /** Iterazioni PBKDF2 (predefinito 600000). */
  iter?: number;
  /** Istante da scrivere nella busta (predefinito: adesso). */
  generatedAt?: string;
}

/** Cifra un qualsiasi valore JSON (pacchetto di sync, backup...). */
export async function encryptJson(value: unknown, passphrase: string, opts: EncryptOptions = {}): Promise<EncryptedEnvelope> {
  const iter = opts.iter ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iter) || iter < MIN_ITERATIONS || iter > MAX_ITERATIONS) {
    throw new RangeError('Numero di iterazioni non valido.');
  }
  const pass = normalizePassphrase(passphrase);
  if (!pass) throw new EnvelopeError('La password non può essere vuota.');
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Valore non serializzabile in JSON.');
  const plain = await gzip(new TextEncoder().encode(json) as Bytes);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(pass, salt, iter, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    kdf: ENVELOPE_KDF,
    iter,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ct),
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  };
}

/** Decifra una busta (oggetto o testo JSON) e restituisce il valore originale. */
export async function decryptJson<T = unknown>(env: unknown, passphrase: string, opts: { maxBytes?: number } = {}): Promise<T> {
  const { salt, iv, ct, envelope } = parseInternal(env);
  const pass = normalizePassphrase(passphrase);
  if (!pass) throw new WrongPassphraseError('Inserisci la password.');
  const key = await deriveKey(pass, salt, envelope.iter, ['decrypt']);
  let compressed: Bytes;
  try {
    compressed = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct));
  } catch (e) {
    throw new WrongPassphraseError('Password sbagliata (o file alterato).', { cause: e });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await gunzip(compressed, opts.maxBytes ?? MAX_PLAIN_BYTES));
  } catch (e) {
    if (e instanceof CorruptedEnvelopeError) throw e;
    throw new CorruptedEnvelopeError('Contenuto illeggibile.', { cause: e });
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CorruptedEnvelopeError('Contenuto non JSON.', { cause: e });
  }
}

/* ------------------------------------------------------------------ pacchetto di sync */

/** Controllo di forma del SyncBundle (versione e campi principali). */
export function assertSyncBundle(x: unknown): SyncBundle {
  if (!isRecord(x)) throw new CorruptedEnvelopeError('Il file non contiene un pacchetto di sync.');
  if (typeof x.version === 'number' && x.version !== 1) throw new UnsupportedVersionError('Pacchetto di una versione più nuova.');
  const range = x.range;
  if (
    x.version !== 1 ||
    typeof x.generatedAt !== 'string' ||
    !isRecord(range) ||
    typeof range.from !== 'string' ||
    typeof range.to !== 'string' ||
    !Array.isArray(x.activities) ||
    !Array.isArray(x.wellness) ||
    !Array.isArray(x.weights)
  ) {
    throw new CorruptedEnvelopeError('Il file non contiene un pacchetto di sync valido.');
  }
  return { ...(x as unknown as SyncBundle), warnings: Array.isArray(x.warnings) ? (x.warnings as string[]) : [] };
}

export function encryptBundle(bundle: SyncBundle, passphrase: string, iter?: number): Promise<EncryptedEnvelope> {
  return encryptJson(bundle, passphrase, { iter, generatedAt: bundle.generatedAt });
}

export async function decryptEnvelope(env: unknown, passphrase: string): Promise<SyncBundle> {
  return assertSyncBundle(await decryptJson<unknown>(env, passphrase));
}
