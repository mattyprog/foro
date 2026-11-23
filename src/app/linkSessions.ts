import { db as defaultDb, type AppDB } from '@/db/db';
import type { Activity, GymSession } from '@/db/types';
import { addDays } from '@/lib/dates';

/** Partenze più distanti di così, senza sovrapposizione, non sono lo stesso allenamento. */
const MAX_START_GAP_MS = 30 * 60 * 1000;

/**
 * Quanto una seduta di Foro e un'attività di forza del Garmin sembrano lo stesso allenamento:
 * più si sovrappongono e più partono vicine, più il punteggio è alto. undefined = non sono lo stesso.
 */
export function matchScore(s: Pick<GymSession, 'startedAt' | 'endedAt'>, a: Pick<Activity, 'kind' | 'start' | 'durationSec'>): number | undefined {
  if (a.kind !== 'forza' || !s.endedAt) return undefined;
  const s0 = Date.parse(s.startedAt);
  const s1 = Date.parse(s.endedAt);
  const a0 = Date.parse(a.start);
  const a1 = a0 + Math.max(0, a.durationSec ?? 0) * 1000;
  if (![s0, s1, a0].every(Number.isFinite)) return undefined;
  const overlap = Math.min(s1, a1) - Math.max(s0, a0);
  const gap = Math.abs(a0 - s0);
  if (overlap <= 0 && gap > MAX_START_GAP_MS) return undefined;
  return Math.max(0, overlap) - gap;
}

/**
 * Abbina le sedute chiuse alle attività di forza registrate dall'orologio nello stesso momento,
 * così lo storico non le mostra due volte e la seduta prende frequenza cardiaca e calorie del Garmin.
 * Restituisce quante sedute ha abbinato. Le coppie già fatte non si toccano.
 */
export async function linkGymSessions(db: AppDB = defaultDb): Promise<number> {
  return db.transaction('rw', db.sessions, db.activities, async () => {
    const sessions = await db.sessions.toArray();
    const linked = new Set(sessions.map((s) => s.activityId).filter((x): x is string => !!x));
    const free = sessions.filter((s) => s.endedAt && !s.activityId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (free.length === 0) return 0;
    const acts = (await db.activities.where('start').aboveOrEqual(addDays(free[0].date, -1)).toArray()).filter((a) => a.kind === 'forza' && !linked.has(a.id));
    let n = 0;
    for (const s of free) {
      let best: Activity | undefined;
      let bestScore = -Infinity;
      for (const a of acts) {
        if (linked.has(a.id)) continue;
        const sc = matchScore(s, a);
        if (sc !== undefined && sc > bestScore) {
          best = a;
          bestScore = sc;
        }
      }
      if (best) {
        await db.sessions.update(s.id!, { activityId: best.id });
        linked.add(best.id);
        n++;
      }
    }
    return n;
  });
}
