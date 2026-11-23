/**
 * Date e istanti per la logica di allenamento. Funzioni pure, senza dipendenze.
 *
 * Convenzioni del contratto dati:
 * - le date locali sono stringhe 'YYYY-MM-DD' (ISODate);
 * - gli istanti sono ISO 8601 con offset (ISODateTime);
 * - il giorno della settimana è 0 = lunedì … 6 = domenica.
 *
 * Nomi e significato di addDays / weekdayMon0 / startOfWeek / daysBetween coincidono con
 * quelli di src/lib/dates.ts, così un domani si possono unificare cambiando solo l'import.
 */
import type { ISODate, ISODateTime } from '../../db/types';

export const DAY_MS = 86_400_000;

/** Un istante: millisecondi epoch, Date oppure stringa ISO. */
export type Instant = number | Date | string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Numero di giorni dal 1970-01-01 (aritmetica in UTC: nessun problema di ora legale). */
export function dayNumber(date: ISODate): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Data non valida: ${date}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

export function fromDayNumber(n: number): ISODate {
  const d = new Date(n * DAY_MS);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: ISODate, n: number): ISODate {
  return fromDayNumber(dayNumber(date) + n);
}

/** Giorni da `a` a `b` (positivo se b è dopo a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return dayNumber(b) - dayNumber(a);
}

/** Lunedì = 0 … domenica = 6. */
export function weekdayMon0(date: ISODate): number {
  // il 1970-01-01 era un giovedì (3 con lunedì = 0)
  return (((dayNumber(date) + 3) % 7) + 7) % 7;
}

/** Il lunedì della settimana che contiene `date`. */
export function startOfWeek(date: ISODate): ISODate {
  return addDays(date, -weekdayMon0(date));
}

export function toMs(i: Instant): number {
  const ms = typeof i === 'number' ? i : i instanceof Date ? i.getTime() : Date.parse(i);
  if (!Number.isFinite(ms)) throw new Error(`Istante non valido: ${String(i)}`);
  return ms;
}

/** Scarto del fuso del dispositivo in minuti rispetto a UTC (Roma d'inverno: +60). */
export function deviceOffsetMin(ms: number): number {
  return -new Date(ms).getTimezoneOffset() || 0;
}

/**
 * Data locale di un istante. Una stringa con offset esplicito vale per l'ora scritta nella stringa
 * (è l'ora locale di chi l'ha registrata); numeri, Date e stringhe 'Z' usano `tzOffsetMin`
 * (di default il fuso del dispositivo).
 */
export function localDateOf(i: Instant, tzOffsetMin?: number): ISODate {
  if (typeof i === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(i) && !/Z$/i.test(i)) {
    return i.slice(0, 10);
  }
  if (typeof i === 'string' && DATE_RE.test(i)) return i;
  const ms = toMs(i);
  const off = tzOffsetMin ?? deviceOffsetMin(ms);
  return fromDayNumber(Math.floor((ms + off * 60_000) / DAY_MS));
}

/** ISO 8601 con offset, es. '2026-11-23T18:30:05+01:00'. */
export function toISOWithOffset(i: Instant, tzOffsetMin?: number): ISODateTime {
  const ms = toMs(i);
  const off = tzOffsetMin ?? deviceOffsetMin(ms);
  const shifted = new Date(ms + off * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${p(shifted.getUTCFullYear(), 4)}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** Elenco di date consecutive da `from` a `to` inclusi. */
export function rangeDays(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n++) out.push(fromDayNumber(n));
  return out;
}
