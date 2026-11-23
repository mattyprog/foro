import type { Activity } from '@/db/types';

/** Due attività sono la stessa se hanno lo stesso tipo e iniziano a meno di 90 secondi l'una dall'altra. */
export const DUPLICATE_TOLERANCE_SEC = 90;

/** Campi di dettaglio (dal file FIT): un pacchetto più vecchio di 90 giorni non li porta più. */
export const DETAIL_FIELDS = ['laps', 'track', 'hrSeries', 'paceSeries', 'exerciseSets'] as const;

/**
 * Cerca tra `existing` la stessa attività (stesso `kind`, inizio entro ±90 s) e restituisce la più vicina.
 * Serve a non avere doppioni tra file FIT importati a mano e attività arrivate dalla sync Garmin.
 */
export function findDuplicate(
  activity: Pick<Activity, 'kind' | 'start'>,
  existing: readonly Activity[],
  toleranceSec = DUPLICATE_TOLERANCE_SEC,
): Activity | undefined {
  const t = Date.parse(activity.start);
  if (!Number.isFinite(t)) return undefined;
  let best: Activity | undefined;
  let bestDiff = Infinity;
  for (const e of existing) {
    if (e.kind !== activity.kind) continue;
    const diff = Math.abs(Date.parse(e.start) - t);
    if (Number.isFinite(diff) && diff <= toleranceSec * 1000 && diff < bestDiff) {
      best = e;
      bestDiff = diff;
    }
  }
  return best;
}

/** Completa `target` con i dettagli (giri, traccia, serie) che ha solo `source`. */
export function mergeActivityDetails(target: Activity, source: Activity): Activity {
  const out: Activity = { ...target };
  for (const key of DETAIL_FIELDS) {
    if (out[key] === undefined && source[key] !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = source[key];
    }
  }
  return out;
}
