/** Formattazione all'italiana: separatore delle migliaia col punto, decimali con la virgola. */

const intFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: true });
const dec1Fmt = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const dec2Fmt = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Il raggruppamento di Intl per l'italiano parte da 5 cifre: lo forziamo anche a 4 (1.840). */
function group4(s: string): string {
  return s.replace(/^(-?)(\d)(\d{3})(?=$|,)/, '$1$2.$3');
}

export function fmtInt(n: number): string {
  return group4(intFmt.format(Math.round(n)));
}

export function fmt1(n: number): string {
  return group4(dec1Fmt.format(n));
}

export function fmt2(n: number): string {
  return group4(dec2Fmt.format(n));
}

export function fmtKg(n: number): string {
  return fmt2(Math.round(n * 100) / 100);
}

/** 3725 s -> "1 h 02 min"; 1500 s -> "25 min". */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

/** 95 -> "1:35". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Ore di sonno: 26100 s -> "7 h 15". */
export function fmtSleep(sec: number): string {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Passo in secondi al km -> "5:12". */
export function fmtPace(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return 'n.d.';
  return fmtClock(secPerKm);
}

export function fmtKm(m: number): string {
  return fmt2(Math.round(m / 10) / 100);
}

const dayFmt = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDayFmt = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });

export function fmtDayLong(d: Date): string {
  const s = dayFmt.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fmtDayShort(d: Date): string {
  return shortDayFmt.format(d);
}

export function fmtTime(d: Date): string {
  return timeFmt.format(d);
}

/** "oggi", "ieri", oppure la data breve. */
export function fmtRelativeDay(iso: string, today: string): string {
  if (iso === today) return 'oggi';
  const d = new Date(iso + 'T12:00:00');
  const t = new Date(today + 'T12:00:00');
  const diff = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diff === 1) return 'ieri';
  return fmtDayShort(d);
}

/** "6 ore fa", "12 min fa", "2 giorni fa". */
export function fmtAgo(from: Date, now = new Date()): string {
  const min = Math.round((now.getTime() - from.getTime()) / 60000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? "un'ora fa" : `${h} ore fa`;
  const g = Math.round(h / 24);
  return g === 1 ? 'ieri' : `${g} giorni fa`;
}
