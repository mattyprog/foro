import type { GymSession, LoggedSet } from '@/db/types';
import { getExercise, isAssisted, isTimed } from '@/lib/training/library';
import { tonnage } from '@/lib/training/records';

/**
 * Tonnellaggio come nel riepilogo di fine seduta: kg x ripetizioni delle serie fatte, senza riscaldamento,
 * senza esercizi a tempo (lì le ripetizioni sono secondi) e senza macchine assistite (lì i kg sono di aiuto).
 */
export function sessionTonnage(s: Pick<GymSession, 'sets'>): number {
  return tonnage(
    s.sets.filter((x) => {
      const ex = getExercise(x.exerciseId);
      return !ex || (!isTimed(ex) && !isAssisted(ex));
    }),
  );
}

/** Serie raggruppate per esercizio, nell'ordine in cui compaiono. */
export function groupSets(sets: LoggedSet[]): { exerciseId: string; sets: LoggedSet[] }[] {
  const order: string[] = [];
  const map = new Map<string, LoggedSet[]>();
  for (const s of sets) {
    if (!map.has(s.exerciseId)) {
      map.set(s.exerciseId, []);
      order.push(s.exerciseId);
    }
    map.get(s.exerciseId)!.push(s);
  }
  return order.map((id) => ({ exerciseId: id, sets: map.get(id)!.sort((a, b) => a.setIndex - b.setIndex) }));
}
