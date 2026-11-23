import { db } from '@/db/db';
import { decryptJson, encryptJson } from '@/lib/garmin/envelope';
import { todayISO } from '@/lib/dates';
import { invalidateFoodIndex } from '@/app/engine';

/** Chiavi che non escono mai dal telefono, nemmeno nel backup cifrato. */
const SECRET_KEYS = new Set(['garmin.passphrase', 'gemini.apiKey']);

const TABLES = [
  'profile',
  'foods',
  'foodLog',
  'savedMeals',
  'weights',
  'measures',
  'exercises',
  'programs',
  'templates',
  'sessions',
  'activities',
  'wellness',
  'settings',
] as const;

type TableName = (typeof TABLES)[number];

interface BackupFile {
  app: 'foro';
  version: 1;
  createdAt: string;
  tables: Record<TableName, unknown[]>;
}

/** Blob -> data URL senza FileReader (funziona anche fuori dal browser, nei test). */
async function blobToDataUrl(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${b.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/** Data URL -> Blob, sincrono: niente fetch, che dentro una transazione IndexedDB la chiuderebbe a metà. */
export function dataUrlToBlob(u: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(u);
  if (!m) throw new Error('Miniatura non valida nel backup.');
  const type = m[1] || 'application/octet-stream';
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type });
}

export async function exportBackup(passphrase: string): Promise<{ blob: Blob; filename: string }> {
  const tables = {} as Record<TableName, unknown[]>;
  for (const t of TABLES) {
    let rows = (await db.table(t).toArray()) as Record<string, unknown>[];
    if (t === 'settings') rows = rows.filter((r) => !SECRET_KEYS.has(String(r.key)));
    if (t === 'foodLog') {
      rows = await Promise.all(
        rows.map(async (r) => (r.photoThumb instanceof Blob ? { ...r, photoThumb: await blobToDataUrl(r.photoThumb) } : r)),
      );
    }
    tables[t] = rows;
  }
  const file: BackupFile = { app: 'foro', version: 1, createdAt: new Date().toISOString(), tables };
  const env = await encryptJson(file, passphrase);
  const blob = new Blob([JSON.stringify(env)], { type: 'application/json' });
  return { blob, filename: `foro-backup-${todayISO()}.json` };
}

/**
 * Ripristina sostituendo i dati del telefono con quelli del backup (le chiavi segrete restano).
 * Tutto si prepara e si controlla prima di toccare il database; poi una sola transazione, senza attese esterne:
 * se qualcosa va storto non cambia niente. Le tabelle che il backup non contiene restano come sono.
 */
export async function restoreBackup(text: string, passphrase: string): Promise<number> {
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('Il file non è un backup di Foro.');
  }
  const file = (await decryptJson(env as Parameters<typeof decryptJson>[0], passphrase)) as Partial<BackupFile> | null;
  if (file?.app !== 'foro' || file.version !== 1 || !file.tables || typeof file.tables !== 'object') throw new Error('Non è un backup di Foro.');
  const present = TABLES.filter((t) => Array.isArray(file.tables![t]));
  if (present.length === 0) throw new Error('Il backup è vuoto.');

  const prepared = new Map<TableName, Record<string, unknown>[]>();
  for (const t of present) {
    const rows = file.tables[t] as Record<string, unknown>[];
    if (rows.some((r) => !r || typeof r !== 'object')) throw new Error(`Backup danneggiato (tabella ${t}).`);
    prepared.set(t, t === 'foodLog' ? rows.map((r) => (typeof r.photoThumb === 'string' ? { ...r, photoThumb: dataUrlToBlob(r.photoThumb) } : r)) : rows);
  }

  let count = 0;
  await db.transaction('rw', present.map((t) => db.table(t)), async () => {
    for (const t of present) {
      const rows = prepared.get(t)!;
      const table = db.table(t);
      if (t === 'settings') {
        const keep = (await table.toArray()).filter((r: { key: string }) => SECRET_KEYS.has(r.key));
        await table.clear();
        await table.bulkPut([...rows.filter((r) => !SECRET_KEYS.has(String(r.key))), ...keep]);
      } else {
        await table.clear();
        await table.bulkPut(rows);
      }
      count += rows.length;
    }
  });
  invalidateFoodIndex();
  return count;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
