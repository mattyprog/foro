import { rescaleDraft, type DraftItem } from '@/lib/nutrition';

/**
 * Risposta a una domanda sui grammi (es. "quanto olio?"): la voce si cerca per alimento e nome scritto,
 * non per posizione, perché la lista cambia se l'utente toglie qualcosa. 0 g la toglie; se era stata tolta
 * e poi si sceglie una quantità, torna in lista.
 */
export function answerItems(items: DraftItem[], anchor: DraftItem | undefined, grams: number): DraftItem[] {
  if (!anchor) return items;
  const i = items.findIndex((x) => x.foodId === anchor.foodId && x.inputName === anchor.inputName);
  if (grams <= 0) return i >= 0 ? items.filter((_, k) => k !== i) : items;
  if (i >= 0) return items.map((x, k) => (k === i ? rescaleDraft(x, grams) : x));
  return [...items, rescaleDraft(anchor, grams)];
}
