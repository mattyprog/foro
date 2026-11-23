/**
 * Importa nel database locale il pacchetto della sync Garmin (già decifrato).
 *
 * Regole (idempotenti: reimportare lo stesso pacchetto non cambia nulla):
 * - attività: upsert per id; i campi che il pacchetto non porta (es. i dettagli FIT delle attività
 *   più vecchie di 90 giorni) restano quelli già salvati. Se una nuova attività Garmin è lo stesso
 *   allenamento di un file FIT importato a mano, la versione Garmin prende il posto di quella FIT,
 *   ne eredita i dettagli mancanti e le sedute collegate vengono ripuntate;
 * - benessere: unione per data, senza mai toccare i campi soggettivi (umore, energia, indolenzimento);
 * - pesi: per data; se per quella data c'è un peso inserito a mano, vince quello manuale;
 * - un pacchetto più vecchio dell'ultimo importato viene ignorato (`stale: true`).
 */
import type { AppDB } from '@/db/db';
import type { Activity, SyncBundle, WeightEntry, WellnessDay } from '@/db/types';
import { findDuplicate, mergeActivityDetails } from '@/lib/fit/dedupe';

export const LAST_BUNDLE_KEY = 'garmin.lastBundleAt';
export const LAST_WARNINGS_KEY = 'garmin.lastWarnings';
const SUBJECTIVE = ['mood', 'energy', 'soreness'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ImportCounts {
  added: number;
  updated: number;
  unchanged: number;
}

export interface ImportResult {
  /** `merged`: doppioni FIT sostituiti dalla versione Garmin; `skipped`: elementi malformati. */
  activities: ImportCounts & { merged: number; skipped: number };
  wellness: ImportCounts;
  /** `keptManual`: date in cui è rimasto il peso inserito a mano. */
  weights: ImportCounts & { keptManual: number };
  /** true se il pacchetto era più vecchio dell'ultimo importato: niente è stato scritto. */
  stale: boolean;
}

function counts(): ImportCounts {
  return { added: 0, updated: 0, unchanged: 0 };
}

/** Toglie le chiavi con valore undefined o null (il contratto vuole i dati mancanti assenti). */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const kb = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(ao[k], bo[k]));
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function validActivity(a: unknown): a is Activity {
  return (
    isObj(a) &&
    typeof a.id === 'string' &&
    a.id.length > 0 &&
    typeof a.start === 'string' &&
    Number.isFinite(Date.parse(a.start)) &&
    typeof a.kind === 'string' &&
    typeof a.durationSec === 'number'
  );
}

const validWellness = (w: unknown): w is WellnessDay => isObj(w) && typeof w.date === 'string' && DATE_RE.test(w.date);

const validWeight = (w: unknown): w is WeightEntry =>
  isObj(w) && typeof w.date === 'string' && DATE_RE.test(w.date) && typeof w.kg === 'number' && Number.isFinite(w.kg) && w.kg > 0;

export async function importBundle(db: AppDB, bundle: SyncBundle, opts: { force?: boolean } = {}): Promise<ImportResult> {
  const result: ImportResult = {
    activities: { ...counts(), merged: 0, skipped: 0 },
    wellness: counts(),
    weights: { ...counts(), keptManual: 0 },
    stale: false,
  };

  await db.transaction('rw', [db.activities, db.wellness, db.weights, db.sessions, db.settings], async () => {
    const last = (await db.settings.get(LAST_BUNDLE_KEY))?.value;
    if (!opts.force && typeof last === 'string' && Date.parse(bundle.generatedAt) < Date.parse(last)) {
      result.stale = true;
      return;
    }

    /* -------------------------------------------------------------- attività */
    const existing = await db.activities.toArray();
    const byId = new Map(existing.map((a) => [a.id, a]));
    let fitOnly = existing.filter((a) => a.source === 'fit');
    for (const raw of bundle.activities ?? []) {
      if (!validActivity(raw)) {
        result.activities.skipped++;
        continue;
      }
      const incoming = compact(raw);
      const old = byId.get(incoming.id);
      if (old) {
        const merged = compact({ ...old, ...incoming });
        if (deepEqual(old, merged)) result.activities.unchanged++;
        else {
          await db.activities.put(merged);
          byId.set(merged.id, merged);
          result.activities.updated++;
        }
        continue;
      }
      const dup = incoming.source === 'garmin' ? findDuplicate(incoming, fitOnly) : undefined;
      if (dup) {
        const merged = mergeActivityDetails(incoming, dup);
        await db.activities.delete(dup.id);
        await db.sessions.filter((s) => s.activityId === dup.id).modify({ activityId: merged.id });
        fitOnly = fitOnly.filter((a) => a.id !== dup.id);
        byId.delete(dup.id);
        await db.activities.put(merged);
        byId.set(merged.id, merged);
        result.activities.merged++;
        continue;
      }
      await db.activities.put(incoming);
      byId.set(incoming.id, incoming);
      result.activities.added++;
    }

    /* -------------------------------------------------------------- benessere */
    const days = (bundle.wellness ?? []).filter(validWellness).map((w) => compact(w));
    const oldDays = await db.wellness.bulkGet(days.map((d) => d.date));
    for (let i = 0; i < days.length; i++) {
      const incoming = { ...days[i] };
      for (const k of SUBJECTIVE) delete incoming[k];
      const old = oldDays[i];
      if (!old) {
        await db.wellness.put({ ...incoming, source: 'garmin' });
        result.wellness.added++;
        continue;
      }
      const merged: WellnessDay = compact({ ...old, ...incoming, source: 'garmin' });
      for (const k of SUBJECTIVE) {
        if (old[k] !== undefined) merged[k] = old[k];
      }
      if (deepEqual(old, merged)) result.wellness.unchanged++;
      else {
        await db.wellness.put(merged);
        result.wellness.updated++;
      }
    }

    /* -------------------------------------------------------------- pesi */
    const weights = (bundle.weights ?? []).filter(validWeight).map((w) => compact({ ...w, source: 'garmin' as const }));
    const oldWeights = await db.weights.bulkGet(weights.map((w) => w.date));
    for (let i = 0; i < weights.length; i++) {
      const incoming = weights[i];
      const old = oldWeights[i];
      if (old?.source === 'manuale') {
        result.weights.keptManual++;
      } else if (!old) {
        await db.weights.put(incoming);
        result.weights.added++;
      } else if (deepEqual(old, incoming)) {
        result.weights.unchanged++;
      } else {
        await db.weights.put(incoming);
        result.weights.updated++;
      }
    }

    await db.settings.put({ key: LAST_BUNDLE_KEY, value: bundle.generatedAt });
    await db.settings.put({ key: LAST_WARNINGS_KEY, value: Array.isArray(bundle.warnings) ? bundle.warnings : [] });
  });

  return result;
}
