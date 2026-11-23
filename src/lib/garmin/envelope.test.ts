import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SyncBundle } from '@/db/types';
import {
  CorruptedEnvelopeError,
  DEFAULT_ITERATIONS,
  UnsupportedVersionError,
  WrongPassphraseError,
  base64ToBytes,
  decryptEnvelope,
  decryptJson,
  encryptBundle,
  encryptJson,
  parseEnvelope,
} from './envelope';

/** Password usata SOLO nei test e nella busta di esempio (stessa di scripts/sync/tests/helpers.py). */
const PASS = 'prova-foro-solo-test-2026';
const FAST = { iter: 1000 };

const samplePath = fileURLToPath(new URL('../../../tests/fixtures/garmin-envelope.sample.json', import.meta.url));
const sampleText = readFileSync(samplePath, 'utf8');

const bundle: SyncBundle = {
  version: 1,
  generatedAt: '2026-11-20T09:23:00Z',
  range: { from: '2025-11-20', to: '2026-11-20' },
  activities: [
    {
      id: 'garmin:1',
      source: 'garmin',
      kind: 'corsa',
      typeKey: 'running',
      name: 'Corsa sintetica, più lenta',
      start: '2026-11-18T07:00:05+01:00',
      durationSec: 900,
      track: [
        [38.86, -94.79],
        [38.87, -94.78],
      ],
    },
  ],
  wellness: [{ date: '2026-11-19', source: 'garmin', steps: 8000 }],
  weights: [{ date: '2026-11-19', kg: 72.4, source: 'garmin' }],
  warnings: [],
};

describe('busta cifrata', () => {
  it('cifra e decifra un JSON qualsiasi (andata e ritorno)', async () => {
    const value = { a: 1, testo: 'Perché sì: caffè ☕', lista: [1.5, null, true] };
    const env = await encryptJson(value, PASS, FAST);
    expect(await decryptJson(env, PASS)).toEqual(value);
    expect(JSON.stringify(env)).not.toContain('caff');
  });

  it('usa i parametri del contratto: AES-256-GCM, PBKDF2-SHA256, 600000 iterazioni, sale 16 e iv 12 byte', async () => {
    const env = await encryptBundle(bundle, PASS);
    expect(env).toMatchObject({ v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: DEFAULT_ITERATIONS });
    expect(DEFAULT_ITERATIONS).toBe(600_000);
    expect(env.generatedAt).toBe(bundle.generatedAt);
    expect(base64ToBytes(env.salt)).toHaveLength(16);
    expect(base64ToBytes(env.iv)).toHaveLength(12);
    expect(await decryptEnvelope(env, PASS)).toEqual(bundle);
  });

  it('sale e iv cambiano a ogni cifratura', async () => {
    const a = await encryptJson(bundle, PASS, FAST);
    const b = await encryptJson(bundle, PASS, FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('compatibilità tra linguaggi: decifra la busta prodotta dallo script Python', async () => {
    const decoded = await decryptEnvelope(sampleText, PASS);
    expect(decoded.version).toBe(1);
    expect(decoded.generatedAt).toBe('2026-11-20T09:23:00Z');
    expect(decoded.range).toEqual({ from: '2025-11-20', to: '2026-11-20' });
    expect(decoded.activities).toHaveLength(7);
    expect(decoded.wellness).toHaveLength(91);
    expect(decoded.weights).toHaveLength(105);
    expect(decoded.warnings).toEqual([]);
    const ids = decoded.activities.map((a) => a.id);
    expect(ids).toContain('garmin:9000000101');
    const treadmill = decoded.activities.find((a) => a.id === 'garmin:9000000103');
    expect(treadmill?.name).toBe('Tapis roulant sintetico, più lento');
    const run = decoded.activities.find((a) => a.id === 'garmin:9000000101');
    expect(run?.track?.length).toBeGreaterThanOrEqual(2);
    expect(run?.laps).toHaveLength(3);
    const strength = decoded.activities.find((a) => a.id === 'garmin:9000000102');
    expect(strength?.exerciseSets?.map((s) => s.category)).toEqual(['BENCH_PRESS', 'SQUAT']);
    const today = decoded.wellness.find((w) => w.date === '2026-11-20');
    expect(today).toMatchObject({ source: 'garmin', fitnessAge: 27.4, hrvStatus: 'BALANCED' });
  });

  it('password sbagliata: WrongPassphraseError', async () => {
    await expect(decryptEnvelope(sampleText, 'password sbagliata')).rejects.toBeInstanceOf(WrongPassphraseError);
    const env = await encryptJson(bundle, PASS, FAST);
    const err = await decryptJson(env, 'un’altra').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WrongPassphraseError);
    expect((err as Error).name).toBe('WrongPassphraseError');
  });

  it('normalizza la password (è composta o scomposta)', async () => {
    const env = await encryptJson({ ok: true }, 'caff\u00e8-lungo-mattina', FAST);
    expect(await decryptJson(env, 'caffe\u0300-lungo-mattina')).toEqual({ ok: true });
  });

  it('busta corrotta: CorruptedEnvelopeError', async () => {
    const env = await encryptJson(bundle, PASS, FAST);
    const broken: unknown[] = [
      'non sono json',
      42,
      null,
      { ...env, iv: 'c2hvcnQ=' },
      { ...env, salt: '%%%' },
      { ...env, ct: 'AAAA' },
      { ...env, iter: 10 },
      { ...env, iter: 1e9 },
      { ...env, ct: undefined },
    ];
    for (const b of broken) {
      const err = await decryptJson(b, PASS).catch((e: unknown) => e);
      expect(err, JSON.stringify(b)?.slice(0, 40)).toBeInstanceOf(CorruptedEnvelopeError);
      expect((err as Error).name).toBe('CorruptedEnvelopeError');
    }
  });

  it('versione o algoritmo non supportati: UnsupportedVersionError', async () => {
    const env = await encryptJson(bundle, PASS, FAST);
    for (const b of [{ ...env, v: 2 }, { ...env, alg: 'AES-128-CBC' }, { ...env, kdf: 'scrypt' }]) {
      const err = await decryptJson(b, PASS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedVersionError);
      expect((err as Error).name).toBe('UnsupportedVersionError');
    }
  });

  it('decryptEnvelope controlla che il contenuto sia un SyncBundle', async () => {
    const backup = await encryptJson({ app: 'foro', version: 1 }, PASS, FAST);
    await expect(decryptEnvelope(backup, PASS)).rejects.toBeInstanceOf(CorruptedEnvelopeError);
    const future = await encryptJson({ ...bundle, version: 2 }, PASS, FAST);
    await expect(decryptEnvelope(future, PASS)).rejects.toBeInstanceOf(UnsupportedVersionError);
  });

  it('parseEnvelope accetta testo JSON e oggetti, e rifiuta il resto', async () => {
    const env = await encryptJson(bundle, PASS, FAST);
    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
    expect(parseEnvelope(env)).toEqual(env);
    expect(() => parseEnvelope('[1,2]')).toThrow(CorruptedEnvelopeError);
  });

  it('rifiuta password vuote e iterazioni fuori limite in cifratura', async () => {
    await expect(encryptJson({}, '', FAST)).rejects.toThrow();
    await expect(encryptJson({}, PASS, { iter: 10 })).rejects.toThrow(RangeError);
  });

  it('cifra anche contenuti grandi (backup)', async () => {
    const big = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, nome: `riga ${i}`, v: i * 1.5 })) };
    const env = await encryptJson(big, PASS, FAST);
    expect(await decryptJson(env, PASS)).toEqual(big);
  });
});

describe('tetto alla decompressione', () => {
  it('un contenuto che si gonfia oltre il tetto si ferma con un errore chiaro', async () => {
    const grande = { version: 1, riempitivo: 'a'.repeat(300_000) }; // si comprime a pochi KB
    const env = await encryptJson(grande, PASS, FAST);
    expect(JSON.stringify(env).length).toBeLessThan(20_000);
    await expect(decryptJson(env, PASS, { maxBytes: 100_000 })).rejects.toThrow(/troppo grande/);
    await expect(decryptJson(env, PASS, { maxBytes: 100_000 })).rejects.toBeInstanceOf(CorruptedEnvelopeError);
    expect(await decryptJson(env, PASS, { maxBytes: 400_000 })).toEqual(grande);
  });
});

