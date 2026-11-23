import { getSetting, setSetting } from '@/db/db';

/** Somma la spesa stimata di Gemini (in dollari) al contatore mostrato nel profilo. */
export async function addSpent(usd: number) {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const prev = await getSetting<number>('gemini.spentUsd', 0);
  await setSetting('gemini.spentUsd', prev + usd);
}
