/**
 * Formattazione all'italiana dei numeri che compaiono nei testi dei suggerimenti
 * (virgola decimale, niente zeri inutili). Nessuna dipendenza da Intl: l'output è identico ovunque.
 */

/** 62.5 -> "62,5"; 60 -> "60"; 1.25 -> "1,25". */
export function fmtNum(n: number, maxDecimals = 2): string {
  const f = 10 ** maxDecimals;
  const r = Math.round(n * f) / f;
  return String(r).replace('.', ',');
}

/** 62.5 -> "62,5 kg". */
export function fmtKg(n: number): string {
  return `${fmtNum(n)} kg`;
}

/** Arrotonda al passo indicato (es. 1,25). */
export function roundToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  // il resto del calcolo in virgola mobile viene ripulito per non ottenere 56.25000000000001
  return Math.round(Math.round(value / step) * step * 1e6) / 1e6;
}

/** Secondi in "1:02" (minuti:secondi) per i timer. */
export function fmtClockSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Secondi in ore:minuti:secondi, con le ore solo se servono: 3725 -> "1:02:05"; 1930 -> "32:10". */
export function fmtHms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Durata a parole: 45 -> "45 s"; 1500 -> "25 min"; 3725 -> "1 h 02 min". Dal minuto in su arrotonda al minuto. */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 59.5) return `${Math.round(s)} s`;
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
