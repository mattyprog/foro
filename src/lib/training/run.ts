/**
 * Corsa: zone cardiache, piano progressivo per chi inizia, formattazioni e analisi di una corsa.
 *
 * Regole del metodo:
 * - 2 uscite a settimana, quasi tutte facili in zona 2, di 20-30 minuti all'inizio;
 * - il tempo totale della settimana non cresce più del 10% rispetto alla precedente;
 * - dopo 4 settimane una sola uscita a settimana include gli allunghi (pochi secondi più veloci, sciolti);
 * - mai corse dure il giorno prima delle gambe e, se si fanno pesi e corsa lo stesso giorno, prima i pesi
 *   (queste due regole stanno in `templates.ts`: `isHardRun`, `isLegDay`, `todaysPlan`).
 *
 * Zone cardiache: percentuali della FC massima (come le zone predefinite dell'orologio): 50-60-70-80-90-100%.
 * La FC massima viene dalle zone fornite, da un valore noto o, come ripiego, dalla formula di Tanaka (208 - 0,7 x età).
 */
import type { Activity, ISODate, Lap, RunPlan } from '../../db/types';
import { addDays, localDateOf, weekdayMon0 } from './dates';
import { fmtNum } from './format';

export { fmtDuration, fmtHms } from './format';

/* ------------------------------------------------------------ Zone cardiache */

export type ZoneNumber = 1 | 2 | 3 | 4 | 5;

export interface HrZone {
  zone: ZoneNumber;
  minBpm: number;
  maxBpm: number;
  nome: string;
}

export const ZONE_NAMES: Record<ZoneNumber, string> = {
  1: 'Recupero',
  2: 'Facile',
  3: 'Moderata',
  4: 'Intensa',
  5: 'Massimale',
};

/** Limite inferiore di ogni zona come frazione della FC massima. */
export const ZONE_LOWER_PCT = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

const ZONE_NUMBERS: readonly ZoneNumber[] = [1, 2, 3, 4, 5];

/** Età in anni compiuti alla data indicata. */
export function ageOn(birthDate: ISODate, onDate: ISODate): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

/** FC massima stimata con la formula di Tanaka: 208 - 0,7 x età, arrotondata al battito. */
export function tanakaMaxHr(age: number): number {
  return Math.round(208 - 0.7 * age);
}

/** Cinque zone come percentuali della FC massima (50-60-70-80-90-100%). */
export function hrZonesFromMax(maxHr: number): HrZone[] {
  if (!(maxHr > 0)) throw new Error(`FC massima non valida: ${maxHr}`);
  const lows = ZONE_LOWER_PCT.map((p) => Math.round(maxHr * p));
  return ZONE_NUMBERS.map((zone, i) => ({
    zone,
    minBpm: lows[i],
    maxBpm: i < 4 ? lows[i + 1] - 1 : Math.round(maxHr),
    nome: ZONE_NAMES[zone],
  }));
}

/**
 * Zone da limiti forniti (per esempio quelli impostati sull'orologio): sei numeri crescenti,
 * il limite inferiore delle zone 1-5 e la FC massima.
 */
export function hrZonesFromBounds(bounds: readonly number[]): HrZone[] {
  if (bounds.length !== 6 || bounds.some((b) => !Number.isFinite(b) || b <= 0) || bounds.some((b, i) => i > 0 && b <= bounds[i - 1])) {
    throw new Error('Servono sei limiti crescenti: l\'inizio delle zone 1-5 e la FC massima.');
  }
  return ZONE_NUMBERS.map((zone, i) => ({
    zone,
    minBpm: bounds[i],
    maxBpm: i < 4 ? bounds[i + 1] - 1 : bounds[5],
    nome: ZONE_NAMES[zone],
  }));
}

export interface HrZoneInput {
  /** Zone già pronte (cinque, crescenti). */
  zones?: readonly HrZone[];
  /** Sei limiti: inizio delle zone 1-5 e FC massima. */
  bounds?: readonly number[];
  /** FC massima misurata o nota. */
  maxHr?: number;
  /** Con la data di nascita si ricava la FC massima con Tanaka. */
  birthDate?: ISODate;
  /** Data di riferimento per l'età (default: nessuna, serve per calcolare l'età). */
  onDate?: ISODate;
}

export interface ResolvedZones {
  zones: HrZone[];
  maxHr: number;
  source: 'fornite' | 'fc-massima' | 'tanaka';
}

function validZones(zones: readonly HrZone[]): boolean {
  return (
    zones.length === 5 &&
    zones.every((z, i) => z.zone === i + 1 && z.minBpm > 0 && z.maxBpm >= z.minBpm && (i === 0 || z.minBpm > zones[i - 1].minBpm))
  );
}

/** Sceglie la fonte più affidabile: zone fornite, poi FC massima nota, poi Tanaka. Undefined se non si sa nulla. */
export function resolveHrZones(input: HrZoneInput): ResolvedZones | undefined {
  if (input.zones && validZones(input.zones)) {
    return { zones: input.zones.map((z) => ({ ...z })), maxHr: input.zones[4].maxBpm, source: 'fornite' };
  }
  if (input.bounds) {
    try {
      const zones = hrZonesFromBounds(input.bounds);
      return { zones, maxHr: zones[4].maxBpm, source: 'fornite' };
    } catch {
      // limiti non validi: si prova con la fonte successiva
    }
  }
  if (input.maxHr !== undefined && input.maxHr > 0) {
    return { zones: hrZonesFromMax(input.maxHr), maxHr: Math.round(input.maxHr), source: 'fc-massima' };
  }
  if (input.birthDate && input.onDate) {
    const age = ageOn(input.birthDate, input.onDate);
    if (age >= 10 && age <= 100) {
      const maxHr = tanakaMaxHr(age);
      return { zones: hrZonesFromMax(maxHr), maxHr, source: 'tanaka' };
    }
  }
  return undefined;
}

/** In che zona cade un valore di FC: la zona più alta il cui limite inferiore è raggiunto (sotto la zona 1, la 1). */
export function zoneOfHr(zones: readonly HrZone[], bpm: number): ZoneNumber {
  let found: ZoneNumber = 1;
  for (const z of zones) if (bpm >= z.minBpm) found = z.zone;
  return found;
}

/** "Zona 2: da 114 a 132 battiti al minuto". */
export function describeZone(z: HrZone): string {
  return `Zona ${z.zone} (${z.nome.toLowerCase()}): da ${z.minBpm} a ${z.maxBpm} battiti al minuto`;
}

/* ------------------------------------------------- Passo, velocità, distanza */

/** Secondi per chilometro; undefined senza distanza. */
export function paceSecPerKm(distanceM: number, durationSec: number): number | undefined {
  if (!(distanceM > 0) || !(durationSec > 0)) return undefined;
  return durationSec / (distanceM / 1000);
}

export function speedKmh(paceSecPerKmValue: number): number {
  return 3600 / paceSecPerKmValue;
}

export function paceFromSpeed(kmh: number): number {
  return 3600 / kmh;
}

/** 330 -> "5:30 /km". Senza un passo valido, "-". */
export function fmtPace(secPerKm: number | undefined): string {
  if (secPerKm === undefined || !Number.isFinite(secPerKm) || secPerKm <= 0) return '-';
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} /km`;
}

/** 10.9 -> "10,9 km/h". */
export function fmtSpeed(kmh: number | undefined): string {
  if (kmh === undefined || !Number.isFinite(kmh) || kmh <= 0) return '-';
  return `${fmtNum(kmh, 1)} km/h`;
}

/** 5421 -> "5,42 km". */
export function fmtKm(distanceM: number | undefined, decimals = 2): string {
  if (distanceM === undefined || !Number.isFinite(distanceM)) return '-';
  return `${fmtNum(distanceM / 1000, decimals)} km`;
}

/* ------------------------------------------------------------- Piano corsa */

/** Il tempo totale di una settimana non cresce più di così rispetto alla precedente. */
export const MAX_WEEKLY_INCREASE = 0.1;
/** Settimana di partenza se non si hanno dati: una corsa facile da 20 minuti e una lunga da 25. */
export const DEFAULT_START_MINUTES = 45;
/** Sotto questo tempo settimanale recente, il piano riparte dal programma base. */
export const MIN_RECENT_MINUTES = 30;
export const ZONE2_STRIDES_FROM_WEEK = 5;

export interface RunSession {
  /** Giorno suggerito, 0 = lunedì … 6 = domenica. */
  day: number;
  date?: ISODate;
  name: string;
  minutes: number;
  run: RunPlan;
}

export interface RunWeek {
  /** Numero della settimana, da 1. */
  week: number;
  start?: ISODate;
  totalMinutes: number;
  /** Variazione del tempo totale rispetto alla settimana prima (null alla prima). */
  changePct: number | null;
  /** Settimana di assestamento: stesso tempo della precedente. */
  consolidation: boolean;
  /** Il tempo massimo delle uscite è stato raggiunto: il piano non cresce oltre. */
  capped: boolean;
  /** Una delle uscite include gli allunghi. */
  strides: boolean;
  note?: string;
  sessions: RunSession[];
}

export interface RunPlanOptions {
  /** Minuti corsi in una settimana di partenza (di solito la media delle ultime). Default 45. */
  startWeeklyMinutes?: number;
  /** Uscite a settimana, da 1 a 4 (default 2). */
  runsPerWeek?: number;
  /** Quante settimane (default 8). */
  weeks?: number;
  /** Se data, ogni settimana parte dal primo lunedì su o dopo questa data e le uscite hanno la data. */
  startDate?: ISODate;
  /** Giorni delle uscite (0 = lunedì); uno per uscita. Default: martedì e sabato con due uscite. */
  days?: readonly number[];
  /** Aumento massimo da una settimana all'altra (non può superare 0,10). */
  maxIncrease?: number;
  /** Prima settimana con gli allunghi (default 5, cioè dopo quattro settimane). */
  stridesFromWeek?: number;
  /** Durata massima di una corsa facile e della corsa lunga in minuti. */
  maxEasyMinutes?: number;
  maxLongMinutes?: number;
  /** Zona 2 della persona, per scrivere i battiti nelle note. */
  zone2?: HrZone;
}

export interface RunPlanResult {
  weeks: RunWeek[];
  startWeeklyMinutes: number;
  /** Aumento percentuale massimo tra due settimane consecutive. */
  maxWeeklyIncreasePct: number;
  notes: string[];
}

const DEFAULT_RUN_DAYS: Record<number, number[]> = { 1: [5], 2: [1, 5], 3: [1, 3, 5], 4: [1, 3, 5, 6] };
const LONG_SHARE: Record<number, number> = { 1: 1, 2: 0.55, 3: 0.4, 4: 0.34 };

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Il massimo che si può correre la settimana dopo: +10%, arrotondato per difetto al minuto. */
export function maxNextWeekMinutes(prevMinutes: number, maxIncrease = MAX_WEEKLY_INCREASE): number {
  return Math.floor(prevMinutes + prevMinutes * Math.min(maxIncrease, MAX_WEEKLY_INCREASE) + 1e-9);
}

/** Vero se nessuna settimana supera la precedente di più del 10%. */
export function isProgressionSafe(weeklyMinutes: readonly number[], maxIncrease = MAX_WEEKLY_INCREASE): boolean {
  return weeklyMinutes.every((m, i) => i === 0 || m <= maxNextWeekMinutes(weeklyMinutes[i - 1], maxIncrease));
}

function splitMinutes(total: number, runs: number, easyCap: number, longCap: number): number[] {
  if (runs === 1) return [total];
  const long = Math.min(longCap, Math.max(1, Math.round(total * LONG_SHARE[runs])));
  const easyTotal = total - long;
  const easy = Math.floor(easyTotal / (runs - 1));
  const list = Array.from({ length: runs - 1 }, () => Math.min(easy, easyCap));
  // quello che resta (arrotondamenti o limiti) va alla corsa lunga, entro il suo limite
  const rest = total - list.reduce((a, b) => a + b, 0);
  return [...list, Math.min(rest, longCap)];
}

const firstMondayOnOrAfter = (d: ISODate): ISODate => (weekdayMon0(d) === 0 ? d : addDays(d, 7 - weekdayMon0(d)));

/**
 * Piano corsa progressivo: quasi tutto in zona 2, tempo totale +10% a settimana al massimo,
 * una settimana di assestamento (stesso tempo) ogni quattro e, dalla quinta, una sola uscita con gli allunghi.
 */
export function buildRunPlan(opts: RunPlanOptions = {}): RunPlanResult {
  const runs = clampInt(opts.runsPerWeek ?? 2, 1, 4);
  const weeks = clampInt(opts.weeks ?? 8, 1, 26);
  const maxInc = Math.min(Math.max(opts.maxIncrease ?? MAX_WEEKLY_INCREASE, 0), MAX_WEEKLY_INCREASE);
  const easyCap = Math.max(10, Math.round(opts.maxEasyMinutes ?? 40));
  const longCap = Math.max(10, Math.round(opts.maxLongMinutes ?? 60));
  const maxTotal = easyCap * (runs - 1) + longCap;
  const start = Math.max(runs * 10, Math.round(opts.startWeeklyMinutes ?? DEFAULT_START_MINUTES));
  const stridesFrom = Math.max(2, Math.round(opts.stridesFromWeek ?? ZONE2_STRIDES_FROM_WEEK));
  const days = opts.days ?? DEFAULT_RUN_DAYS[runs];
  if (days.length !== runs || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error('Serve un giorno della settimana (0-6) per ogni uscita.');
  }
  const sortedDays = [...days].sort((a, b) => a - b);
  const monday = opts.startDate ? firstMondayOnOrAfter(opts.startDate) : undefined;
  const zoneText = opts.zone2 ? ` Zona 2: da ${opts.zone2.minBpm} a ${opts.zone2.maxBpm} battiti al minuto.` : '';

  const result: RunWeek[] = [];
  let prev = 0;
  for (let w = 1; w <= weeks; w++) {
    let total = start;
    let consolidation = false;
    let capped = false;
    if (w > 1) {
      const cap = maxNextWeekMinutes(prev, maxInc);
      consolidation = (w - 1) % 4 === 3; // settimane 4, 8, 12 ...
      total = consolidation ? prev : Math.min(cap, Math.max(prev, maxTotal));
      capped = !consolidation && total === prev && prev >= maxTotal;
    }
    const minutes = splitMinutes(total, runs, easyCap, longCap);
    const weekTotal = minutes.reduce((a, b) => a + b, 0);
    const hasStrides = w >= stridesFrom;
    const stridesReps = w >= stridesFrom + 2 ? 6 : 4;
    const weekStart = monday ? addDays(monday, (w - 1) * 7) : undefined;
    const sessions: RunSession[] = minutes.map((m, i) => {
      const isLong = runs > 1 && i === runs - 1;
      const withStrides = hasStrides && i === 0;
      const run: RunPlan = {
        type: isLong ? 'lungo' : 'facile',
        targetMinutes: m,
        zone: 2,
        note: isLong
          ? `Corsa lunga ma facile, sempre in zona 2: conta il tempo, non il passo.${zoneText}`
          : `Ritmo da conversazione: se non riesci a parlare, rallenta o cammina un minuto.${zoneText}`,
      };
      if (withStrides) {
        run.intervals = [{ reps: stridesReps, workSec: 20, restSec: 60 }];
        run.note = `${run.note} Negli ultimi minuti, ${stridesReps} allunghi di 20 secondi: veloci ma sciolti, non uno scatto. Tra uno e l'altro 1 minuto camminando.`;
      }
      const session: RunSession = {
        day: sortedDays[i],
        name: isLong ? 'Corsa lunga facile' : withStrides ? 'Corsa facile con allunghi' : 'Corsa facile',
        minutes: m,
        run,
      };
      if (weekStart) session.date = addDays(weekStart, sortedDays[i]);
      return session;
    });
    const week: RunWeek = {
      week: w,
      totalMinutes: weekTotal,
      changePct: w === 1 ? null : Math.round(((weekTotal - prev) / prev) * 1000) / 10,
      consolidation,
      capped,
      strides: hasStrides,
      sessions,
    };
    if (weekStart) week.start = weekStart;
    if (consolidation) week.note = 'Settimana di assestamento: stesso tempo della scorsa, nessun aumento.';
    else if (capped) week.note = 'Tempo massimo raggiunto: da qui il piano non cresce più.';
    else if (hasStrides && w === stridesFrom) week.note = 'Da questa settimana una corsa include gli allunghi.';
    result.push(week);
    prev = weekTotal;
  }

  const increases = result.slice(1).map((wk, i) => (wk.totalMinutes - result[i].totalMinutes) / result[i].totalMinutes);
  const notes = [
    'Quasi tutto in zona 2: se non riesci a parlare in frasi intere, rallenta o alterna corsa e cammino.',
    'Se 20 minuti di corsa continua sono troppi, alterna 2 minuti di corsa e 1 di cammino e accorcia la corsa.',
    'Mai una corsa dura il giorno prima delle gambe; se corri e fai pesi nello stesso giorno, prima i pesi e la corsa almeno 6 ore dopo.',
  ];
  return {
    weeks: result,
    startWeeklyMinutes: result[0].totalMinutes,
    maxWeeklyIncreasePct: Math.round(Math.max(0, ...increases) * 1000) / 10,
    notes,
  };
}

const isRun = (a: Activity) => a.kind === 'corsa';
const runMinutes = (a: Activity) => (a.movingSec ?? a.durationSec) / 60;

/** Minuti di corsa in una settimana (lunedì-domenica) che inizia alla data indicata. */
export function weeklyRunMinutes(activities: readonly Activity[], weekStart: ISODate): number {
  const end = addDays(weekStart, 6);
  let total = 0;
  for (const a of activities) {
    if (!isRun(a)) continue;
    const d = localDateOf(a.start);
    if (d >= weekStart && d <= end) total += runMinutes(a);
  }
  return Math.round(total);
}

/** Minuti di corsa a settimana, in media, negli ultimi `weeks` (default 4) periodi di sette giorni fino a oggi. */
export function recentWeeklyRunMinutes(activities: readonly Activity[], today: ISODate, weeks = 4): number {
  const from = addDays(today, -(weeks * 7 - 1));
  let total = 0;
  for (const a of activities) {
    if (!isRun(a)) continue;
    const d = localDateOf(a.start);
    if (d >= from && d <= today) total += runMinutes(a);
  }
  return Math.round(total / weeks);
}

/**
 * Da dove far partire il piano: la media delle ultime quattro settimane se corri già almeno 30 minuti a settimana
 * (così la prima settimana non supera quello che fai davvero), altrimenti il programma base da 45 minuti.
 */
export function suggestStartMinutes(activities: readonly Activity[], today: ISODate): number {
  const recent = recentWeeklyRunMinutes(activities, today);
  return recent >= MIN_RECENT_MINUTES ? recent : DEFAULT_START_MINUTES;
}

/* ------------------------------------------------------------ Analisi corsa */

export interface LapAnalysis {
  /** Numero del giro, da 1. */
  index: number;
  distanceM?: number;
  durationSec: number;
  paceSecPerKm?: number;
  avgHr?: number;
  zone?: ZoneNumber;
}

export interface RunAnalysis {
  activityId: string;
  km: number;
  durationSec: number;
  paceSecPerKm?: number;
  speedKmh?: number;
  avgHr?: number;
  maxHr?: number;
  /** Secondi in zona 1-5. */
  zonesSec?: number[];
  /** Percentuale del tempo in zona 1-5. */
  zonesPct?: number[];
  zoneSource?: 'orologio' | 'serie-fc' | 'giri';
  /** Percentuale del tempo in zona 1 e 2. */
  easyPct?: number;
  laps: LapAnalysis[];
  /** I giri più veloci (solo quelli di almeno `minLapM`). */
  fastestLaps: LapAnalysis[];
  /** Una riga in italiano. */
  commento: string;
}

export interface AnalyzeOptions {
  /** Zone cardiache per calcolare il tempo in zona quando l'orologio non lo dà. */
  zones?: readonly HrZone[];
  /** Quanti giri veloci restituire (default 3). */
  topLaps?: number;
  /** Lunghezza minima di un giro per contare tra i più veloci (default 400 m). */
  minLapM?: number;
}

const MAX_SAMPLE_GAP_SEC = 30;

function zonesFromSeries(series: readonly (readonly [number, number])[], zones: readonly HrZone[]): number[] | undefined {
  if (series.length < 2) return undefined;
  const sorted = [...series].sort((a, b) => a[0] - b[0]);
  const out = [0, 0, 0, 0, 0];
  for (let i = 0; i < sorted.length - 1; i++) {
    const dt = Math.min(sorted[i + 1][0] - sorted[i][0], MAX_SAMPLE_GAP_SEC);
    if (dt > 0) out[zoneOfHr(zones, sorted[i][1]) - 1] += dt;
  }
  return out.some((s) => s > 0) ? out.map((s) => Math.round(s)) : undefined;
}

function analyzeLap(lap: Lap, index: number, zones?: readonly HrZone[]): LapAnalysis {
  const pace = lap.avgPaceSecPerKm ?? (lap.distanceM ? paceSecPerKm(lap.distanceM, lap.durationSec) : undefined);
  const item: LapAnalysis = { index, durationSec: lap.durationSec };
  if (lap.distanceM !== undefined) item.distanceM = lap.distanceM;
  if (pace !== undefined) item.paceSecPerKm = pace;
  if (lap.avgHr !== undefined) {
    item.avgHr = lap.avgHr;
    if (zones) item.zone = zoneOfHr(zones, lap.avgHr);
  }
  return item;
}

/** Km, passo medio, tempo in zona e giri più veloci di una corsa. */
export function analyzeRun(activity: Activity, opts: AnalyzeOptions = {}): RunAnalysis {
  const zones = opts.zones;
  const durationSec = activity.movingSec ?? activity.durationSec;
  const pace = activity.avgPaceSecPerKm ?? (activity.distanceM ? paceSecPerKm(activity.distanceM, durationSec) : undefined);
  const laps = (activity.laps ?? []).map((l, i) => analyzeLap(l, i + 1, zones));

  let zonesSec: number[] | undefined;
  let zoneSource: RunAnalysis['zoneSource'];
  if (activity.hrZonesSec && activity.hrZonesSec.length >= 5) {
    zonesSec = activity.hrZonesSec.slice(0, 5).map((s) => Math.round(s));
    zoneSource = 'orologio';
  } else if (zones && activity.hrSeries) {
    zonesSec = zonesFromSeries(activity.hrSeries, zones);
    if (zonesSec) zoneSource = 'serie-fc';
  }
  if (!zonesSec && zones && laps.some((l) => l.avgHr !== undefined)) {
    const acc = [0, 0, 0, 0, 0];
    for (const l of laps) if (l.zone !== undefined) acc[l.zone - 1] += l.durationSec;
    if (acc.some((s) => s > 0)) {
      zonesSec = acc.map((s) => Math.round(s));
      zoneSource = 'giri';
    }
  }

  const analysis: RunAnalysis = {
    activityId: activity.id,
    km: Math.round((activity.distanceM ?? 0) / 10) / 100,
    durationSec,
    laps,
    fastestLaps: [],
    commento: '',
  };
  if (pace !== undefined) {
    analysis.paceSecPerKm = pace;
    analysis.speedKmh = speedKmh(pace);
  }
  if (activity.avgHr !== undefined) analysis.avgHr = activity.avgHr;
  if (activity.maxHr !== undefined) analysis.maxHr = activity.maxHr;

  if (zonesSec) {
    const total = zonesSec.reduce((a, b) => a + b, 0);
    analysis.zonesSec = zonesSec;
    analysis.zoneSource = zoneSource;
    if (total > 0) {
      analysis.zonesPct = zonesSec.map((s) => Math.round((s / total) * 1000) / 10);
      analysis.easyPct = Math.round(((zonesSec[0] + zonesSec[1]) / total) * 1000) / 10;
    }
  }

  const minLap = opts.minLapM ?? 400;
  analysis.fastestLaps = laps
    .filter((l) => l.paceSecPerKm !== undefined && (l.distanceM ?? 0) >= minLap)
    .sort((a, b) => (a.paceSecPerKm as number) - (b.paceSecPerKm as number))
    .slice(0, opts.topLaps ?? 3);

  analysis.commento = runComment(analysis);
  return analysis;
}

function runComment(a: RunAnalysis): string {
  const base = `${fmtNum(a.km, 2)} km${a.paceSecPerKm !== undefined ? ` a ${fmtPace(a.paceSecPerKm)}` : ''}`;
  if (a.easyPct === undefined) return `${base}.`;
  const pct = fmtNum(a.easyPct, 0);
  if (a.easyPct >= 80) return `${base}: corsa facile ben dosata, il ${pct}% del tempo in zona 1 e 2.`;
  if (a.easyPct >= 50) return `${base}: il ${pct}% del tempo in zona 1 e 2. Per una corsa facile, la prossima volta parti un po' più piano.`;
  return `${base}: corsa intensa, solo il ${pct}% del tempo in zona 1 e 2. Va bene ogni tanto: il giorno dopo niente gambe pesanti.`;
}
