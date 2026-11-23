import { db } from '@/db/db';
import { findDuplicate, parseFitFile } from '@/lib/fit/parseFit';
import { linkGymSessions } from '@/app/linkSessions';

/** Importa file FIT scelti dall'utente, saltando i doppioni (stesso inizio e stesso tipo). */
export async function importFitFiles(files: File[]): Promise<{ added: number; duplicates: number; failed: number }> {
  let added = 0;
  let duplicates = 0;
  let failed = 0;
  const existing = await db.activities.toArray();
  for (const f of files) {
    try {
      const act = await parseFitFile(await f.arrayBuffer());
      if ((await db.activities.get(act.id)) || findDuplicate(act, existing)) {
        duplicates++;
        continue;
      }
      await db.activities.put(act);
      existing.push(act);
      added++;
    } catch {
      failed++;
    }
  }
  if (added > 0) await linkGymSessions(db);
  return { added, duplicates, failed };
}
