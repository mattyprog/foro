/**
 * Semaforo di prontezza: verde, giallo, rosso (o "imparando") con il motivo in UNA riga in italiano.
 *
 * Regole (valori di partenza prudenti, tutti modificabili dalle opzioni, non ancora verificati su fonti):
 * - sonno sotto le 6 ore: seduta leggera (un terzo di serie in meno);
 * - HRV di stanotte sotto il proprio intervallo normale (mediana dei 21 giorni fino a ieri, 1,5 deviazioni robuste,
 *   largo almeno l'8%): seduta leggera; se dura 3 giorni o più, si propone anche la settimana di scarico;
 * - FC a riposo più di 5 battiti sopra la media dei 7 giorni precedenti, per 2 giorni di fila: seduta leggera
 *   e si chiede "come ti senti?";
 * - Body Battery e stress sono solo contesto: compaiono nei dettagli e non cambiano il livello;
 * - la sensazione dichiarata (energia, umore, indolenzimento da 1 a 5) vince sempre sui numeri:
 *   se stai bene è verde anche con numeri storti, se stai male è almeno giallo anche con numeri perfetti;
 * - per le basi di confronto personali servono 14 giorni di dati: prima si dice "sto ancora imparando i tuoi valori"
 *   (il sonno sotto le 6 ore e la sensazione dichiarata valgono comunque, non hanno bisogno di una base);
 * - un dato che manca non conta: niente valori inventati, niente medie al posto dei buchi.
 *
 * Livelli: nessun segnale = verde (consiglio normale); 1-2 punti = giallo (leggero); 3 o più = rosso (riposo).
 * Punti: sonno corto 1, HRV bassa 1 (2 se dura da 3 giorni), FC a riposo alta 1.
 *
 * Assunzioni sui dati: il sonno di una data è quello della notte che finisce quella mattina; nell'indolenzimento
 * 5 è il peggiore, in energia e umore 5 è il migliore.
 *
 * Il testo non fa diagnosi, non nomina patologie, non parla di farmaci e non rimprovera.
 */
import type { ISODate, WellnessDay } from '../../db/types';
import { addDays } from '../training/dates';
import { fmtDuration, fmtNum } from '../training/format';
import { BASELINE_MIN_DAYS, computeBaselines, indexByDate, metricValue, valuesInWindow, type DaysInput, type RangeOptions } from './baselines';

export type ReadinessLevel = 'verde' | 'giallo' | 'rosso' | 'imparando';
export type ReadinessAdvice = 'normale' | 'leggero' | 'riposo';
export type Feeling = 'bene' | 'normale' | 'male' | 'molto-male';

/** Messaggio fisso per i sintomi che non c'entrano con l'allenamento. */
export const SAFETY_MESSAGE = 'Se hai dolore al petto o ti senti svenire, parlane con un medico.';

export interface ReadinessOptions {
  /** Ore di sonno sotto le quali la seduta è leggera (default 6). */
  sleepMinHours?: number;
  /** Giorni di HRV bassa dopo i quali si propone lo scarico (default 3). */
  hrvDeloadDays?: number;
  /** Battiti sopra la media dei 7 giorni (default 5: conta solo chi supera, non chi arriva a 5). */
  rhrMarginBpm?: number;
  /** Giorni di fila con la FC a riposo alta (default 2). */
  rhrDays?: number;
  /** Valori minimi nei 7 giorni di riferimento della FC a riposo (default 4). */
  rhrMinReferenceValues?: number;
  /** Giorni di semaforo giallo o rosso di fila dopo i quali si propone lo scarico (default 7). */
  yellowDeloadDays?: number;
  /** Giorni di dati prima di fidarsi dei confronti personali (default 14). */
  minBaselineDays?: number;
  /** Come si calcola l'intervallo normale dell'HRV. */
  range?: RangeOptions;
}

export interface ReadinessSignal {
  id: 'sonno' | 'hrv' | 'fc-riposo' | 'sensazione';
  testo: string;
}

export interface ReadinessDetails {
  data: ISODate;
  sensazione?: Feeling;
  /** Mancano ancora giorni di dati per le basi di confronto. */
  imparando: boolean;
  giorniDati: number;
  giorniNecessari: number;
  segnali: ReadinessSignal[];
  sonno?: { ore: number; sogliaOre: number; sotto: boolean };
  hrv?: {
    valore: number;
    intervallo?: { min: number; max: number; centro: number };
    sotto: boolean;
    /** Giorni di fila, fino a oggi, sotto l'intervallo. */
    giorniSotto: number;
  };
  fcRiposo?: {
    oggi: number;
    ieri?: number;
    /** Media dei 7 giorni che precedono quelli confrontati. */
    media7?: number;
    sopraOggi?: number;
    sopraIeri?: number;
    elevata: boolean;
  };
  /** Body Battery e stress: solo per informazione. */
  contesto: string[];
  /** Dati di oggi che mancano: sonno, HRV, FC a riposo. */
  mancanti: string[];
  /** Domanda da fare se la FC a riposo è alta e non hai dichiarato come stai. */
  domanda?: string;
  /** Giorni di fila, fino a oggi, con semaforo giallo o rosso. */
  giorniGialli: number;
}

export interface Readiness {
  livello: ReadinessLevel;
  /** Una riga in italiano. */
  motivo: string;
  consiglio: ReadinessAdvice;
  /** Proporre una settimana di scarico (HRV bassa da 3 giorni, o semaforo giallo da una settimana). */
  suggerisciDeload: boolean;
  dettagli: ReadinessDetails;
}

const DEFAULTS = {
  sleepMinHours: 6,
  hrvDeloadDays: 3,
  rhrMarginBpm: 5,
  rhrDays: 2,
  rhrMinReferenceValues: 4,
  yellowDeloadDays: 7,
  minBaselineDays: BASELINE_MIN_DAYS,
};

const MAX_STREAK_DAYS = 30;
const MAX_YELLOW_LOOKBACK = 14;
const r1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const giorni = (n: number) => `${n} ${n === 1 ? 'giorno' : 'giorni'}`;

function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

const valid15 = (v: number | undefined): v is number => typeof v === 'number' && v >= 1 && v <= 5;

/** Come dichiari di sentirti oggi: la sensazione vince sempre sui numeri. Undefined se non hai segnato nulla. */
export function declaredFeeling(day: WellnessDay | undefined): Feeling | undefined {
  if (!day) return undefined;
  const energy = valid15(day.energy) ? day.energy : undefined;
  const mood = valid15(day.mood) ? day.mood : undefined;
  const soreness = valid15(day.soreness) ? day.soreness : undefined;
  if (energy === undefined && mood === undefined && soreness === undefined) return undefined;
  const veryBad = energy === 1 || soreness === 5 || (energy !== undefined && energy <= 2 && mood !== undefined && mood <= 2);
  if (veryBad) return 'molto-male';
  const bad = (energy !== undefined && energy <= 2) || (soreness !== undefined && soreness >= 4) || (mood !== undefined && mood <= 2);
  if (bad) return 'male';
  if ((energy !== undefined && energy >= 4) || (mood !== undefined && mood >= 4)) return 'bene';
  return 'normale';
}

/** Perché ti senti male, a parole (per il motivo). */
function feelingReason(day: WellnessDay | undefined, feeling: Feeling): string {
  const energy = valid15(day?.energy) ? (day?.energy as number) : undefined;
  const soreness = valid15(day?.soreness) ? (day?.soreness as number) : undefined;
  const mood = valid15(day?.mood) ? (day?.mood as number) : undefined;
  if (feeling === 'molto-male') {
    if (energy === 1) return 'molta stanchezza';
    if (soreness === 5) return 'i muscoli molto indolenziti';
    return 'poca energia e umore basso';
  }
  if (energy !== undefined && energy <= 2) return 'poca energia';
  if (soreness !== undefined && soreness >= 4) return 'i muscoli molto indolenziti';
  if (mood !== undefined && mood <= 2) return "l'umore basso";
  return 'di non stare bene';
}

function contextLines(day: WellnessDay | undefined): string[] {
  const out: string[] = [];
  if (!day) return out;
  const { bodyBatteryLow: lo, bodyBatteryHigh: hi, stressAvg } = day;
  if (lo !== undefined && hi !== undefined) out.push(`Body Battery da ${fmtNum(lo, 0)} a ${fmtNum(hi, 0)}`);
  else if (hi !== undefined) out.push(`Body Battery massimo ${fmtNum(hi, 0)}`);
  else if (lo !== undefined) out.push(`Body Battery minimo ${fmtNum(lo, 0)}`);
  if (stressAvg !== undefined) out.push(`Stress medio ${fmtNum(stressAvg, 0)}`);
  return out;
}

function evaluate(
  idx: ReadonlyMap<ISODate, WellnessDay>,
  today: ISODate,
  opts: ReadinessOptions,
  withStreak: boolean,
): Readiness {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS & ReadinessOptions;
  const day = idx.get(today);
  const base = computeBaselines(idx, today, { ...o.range, minDays: o.minBaselineDays });
  const feeling = declaredFeeling(day);
  const imparando = !base.ready;
  const segnali: ReadinessSignal[] = [];
  const clauses: string[] = [];
  const mancanti: string[] = [];
  const dettagli: ReadinessDetails = {
    data: today,
    imparando,
    giorniDati: base.daysWithData,
    giorniNecessari: base.daysNeeded,
    segnali,
    contesto: contextLines(day),
    mancanti,
    giorniGialli: 0,
  };
  if (feeling) dettagli.sensazione = feeling;
  let points = 0;

  // Sonno: regola assoluta, non ha bisogno di una base di confronto.
  const hours = metricValue(day, 'sonnoOre');
  if (hours === undefined) mancanti.push('sonno');
  else {
    const sotto = hours < o.sleepMinHours;
    dettagli.sonno = { ore: Math.round(hours * 100) / 100, sogliaOre: o.sleepMinHours, sotto };
    if (sotto) {
      points += 1;
      const clause = `hai dormito ${fmtDuration(Math.floor(hours * 60) * 60)}`;
      clauses.push(clause);
      segnali.push({ id: 'sonno', testo: cap(clause) });
    }
  }

  // HRV: sotto il proprio intervallo normale.
  const hrvToday = metricValue(day, 'hrv');
  let hrvStreak = 0;
  if (hrvToday === undefined) mancanti.push('HRV');
  else {
    dettagli.hrv = { valore: hrvToday, sotto: false, giorniSotto: 0 };
    const range = base.ready ? base.hrv.range : undefined;
    if (range) {
      dettagli.hrv.intervallo = { min: Math.round(range.low), max: Math.round(range.high), centro: Math.round(range.center) };
      for (let i = 0; i < MAX_STREAK_DAYS; i++) {
        const v = metricValue(idx.get(addDays(today, -i)), 'hrv');
        if (v !== undefined && v < range.low) hrvStreak++;
        else break;
      }
      dettagli.hrv.giorniSotto = hrvStreak;
      dettagli.hrv.sotto = hrvToday < range.low;
      if (dettagli.hrv.sotto) {
        points += hrvStreak >= o.hrvDeloadDays ? 2 : 1;
        const clause =
          hrvStreak >= o.hrvDeloadDays
            ? `l'HRV è sotto il tuo intervallo da ${giorni(hrvStreak)}`
            : `l'HRV (${fmtNum(hrvToday, 0)} ms) è sotto il tuo intervallo di ${dettagli.hrv.intervallo.min}-${dettagli.hrv.intervallo.max} ms`;
        clauses.push(clause);
        segnali.push({ id: 'hrv', testo: cap(clause) });
      }
    }
  }

  // FC a riposo: oltre 5 battiti sopra la media dei 7 giorni precedenti, per 2 giorni di fila.
  const rhrToday = metricValue(day, 'fcRiposo');
  let rhrHigh = false;
  if (rhrToday === undefined) mancanti.push('FC a riposo');
  else {
    dettagli.fcRiposo = { oggi: rhrToday, elevata: false };
    const recent = Array.from({ length: o.rhrDays }, (_, i) => metricValue(idx.get(addDays(today, -i)), 'fcRiposo'));
    if (recent[1] !== undefined) dettagli.fcRiposo.ieri = recent[1];
    const reference = valuesInWindow(idx, 'fcRiposo', addDays(today, -o.rhrDays), 7).map((x) => x.value);
    if (base.ready && reference.length >= o.rhrMinReferenceValues) {
      const ref = mean(reference);
      dettagli.fcRiposo.media7 = r1(ref);
      const above = recent.map((v) => (v === undefined ? undefined : v - ref));
      dettagli.fcRiposo.sopraOggi = r1(above[0] as number);
      if (above[1] !== undefined) dettagli.fcRiposo.sopraIeri = r1(above[1]);
      rhrHigh = above.every((a) => a !== undefined && a > o.rhrMarginBpm);
      dettagli.fcRiposo.elevata = rhrHigh;
      if (rhrHigh) {
        points += 1;
        const clause = `la FC a riposo è ${fmtNum(above[0] as number, 0)} battiti sopra la tua media da ${giorni(o.rhrDays)}`;
        clauses.push(clause);
        segnali.push({ id: 'fc-riposo', testo: cap(clause) });
      }
    }
  }

  // Livello dai numeri, poi la sensazione dichiarata che vince sempre.
  let livello: ReadinessLevel = points >= 3 ? 'rosso' : points >= 1 ? 'giallo' : 'verde';
  if (feeling === 'molto-male') livello = 'rosso';
  else if (feeling === 'male' && livello !== 'rosso') livello = 'giallo';
  else if (feeling === 'bene') livello = 'verde';
  if (feeling === 'male' || feeling === 'molto-male') {
    const reason = feelingReason(day, feeling);
    segnali.push({ id: 'sensazione', testo: `Hai segnato ${reason}` });
  }
  if (imparando && livello === 'verde' && feeling !== 'bene') livello = 'imparando';
  const consiglio: ReadinessAdvice = livello === 'rosso' ? 'riposo' : livello === 'giallo' ? 'leggero' : 'normale';

  // Quanti giorni di fila giallo o rosso (serve per proporre lo scarico dopo una settimana).
  let giorniGialli = 0;
  if (livello === 'giallo' || livello === 'rosso') {
    giorniGialli = 1;
    if (withStreak) {
      for (let i = 1; i < MAX_YELLOW_LOOKBACK; i++) {
        const prev = evaluate(idx, addDays(today, -i), opts, false).livello;
        if (prev === 'giallo' || prev === 'rosso') giorniGialli++;
        else break;
      }
    }
  }
  dettagli.giorniGialli = giorniGialli;
  const suggerisciDeload = feeling !== 'bene' && (hrvStreak >= o.hrvDeloadDays || giorniGialli >= o.yellowDeloadDays);

  const askFeeling = rhrHigh && feeling === undefined;
  if (askFeeling) dettagli.domanda = 'Come ti senti oggi?';

  // Il motivo, in una riga.
  const hasData = dettagli.sonno !== undefined || dettagli.hrv !== undefined || dettagli.fcRiposo !== undefined;
  let motivo: string;
  if (feeling === 'bene') {
    if (clauses.length > 0) motivo = `Ti senti bene, quindi vai col piano, anche se ${joinClauses(clauses)}.`;
    else if (hasData) motivo = 'Ti senti bene e i dati sono nella norma: allenamento come da piano.';
    else motivo = 'Ti senti bene: allenamento come da piano.';
  } else if (feeling === 'molto-male') {
    motivo = `Hai segnato ${feelingReason(day, feeling)}: oggi riposo o una passeggiata.`;
  } else if (livello === 'giallo' || livello === 'rosso') {
    const parts = feeling === 'male' ? [`hai segnato ${feelingReason(day, feeling)}`, ...clauses] : clauses;
    const verdict = livello === 'rosso' ? 'oggi riposo o una passeggiata' : 'oggi seduta leggera';
    motivo = `${cap(joinClauses(parts))}: ${verdict}.`;
  } else if (livello === 'imparando') {
    const n = base.daysWithData;
    motivo = `Sto ancora imparando i tuoi valori: ho ${n} ${n === 1 ? 'giorno' : 'giorni'} di dati su ${base.daysNeeded}.`;
  } else {
    const checked: string[] = [];
    if (dettagli.sonno) checked.push('sonno');
    if (dettagli.hrv?.intervallo) checked.push('HRV');
    if (dettagli.fcRiposo?.media7 !== undefined) checked.push('FC a riposo');
    if (checked.length > 0) motivo = `${cap(joinClauses(checked))} nella norma: allenamento come da piano.`;
    else if (!hasData) motivo = 'Mancano i dati di oggi: vai con il piano e ascolta come ti senti.';
    else motivo = 'Nessun segnale di stanchezza nei dati che ho: allenamento come da piano.';
  }
  if (suggerisciDeload) motivo += ' Ti propongo una settimana di scarico.';
  if (askFeeling) motivo += ' Come ti senti?';

  return { livello, motivo, consiglio, suggerisciDeload, dettagli };
}

/** Semaforo di oggi dai dati di benessere (anche con buchi: un dato che manca non conta). */
export function computeReadiness(days: DaysInput, today: ISODate, opts: ReadinessOptions = {}): Readiness {
  return evaluate(indexByDate(days), today, opts, true);
}

export interface ReadinessDay {
  date: ISODate;
  livello: ReadinessLevel;
  consiglio: ReadinessAdvice;
}

/** Il semaforo degli ultimi `n` giorni (default 7), dal più vecchio a oggi, ognuno con i soli dati fino a quel giorno. */
export function readinessSeries(days: DaysInput, today: ISODate, n = 7, opts: ReadinessOptions = {}): ReadinessDay[] {
  const idx = indexByDate(days);
  const out: ReadinessDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const r = evaluate(idx, date, opts, false);
    out.push({ date, livello: r.livello, consiglio: r.consiglio });
  }
  return out;
}
