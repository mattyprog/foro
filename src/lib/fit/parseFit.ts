/**
 * Importa nel browser un file FIT (o lo ZIP "file originale" scaricato da Garmin Connect).
 *
 * Stesse regole di normalizzazione dello script di sync (scripts/sync/garmin_bridge/fitparse.py e
 * normalize.py): se ne cambi una, cambia anche l'altra.
 * - riepilogo dal messaggio 'session' (durata = tempo del timer, passo dalla velocità media,
 *   cadenza della corsa in passi al minuto, zone FC 1..5);
 * - giri dai messaggi 'lap' (non per la forza);
 * - traccia dai 'record' con GPS: taglio privacy, poi Douglas-Peucker fino a 500 punti;
 * - serie FC e passo sottocampionate fino a 600 punti;
 * - serie di forza dai messaggi 'set' attivi, con categoria e nome Garmin leggibili
 *   (es. 'BENCH_PRESS' e 'Barbell bench press', abbinabili con findByGarmin della libreria);
 * - id 'fit:' + i primi 16 caratteri esadecimali dello SHA-256 del file FIT.
 */
import { Decoder, Profile, Stream, Utils } from '@garmin/fitsdk';
import type { ActivityMesg, FileIdMesg, FitMessages, LapMesg, RecordMesg, SessionMesg, SetMesg } from '@garmin/fitsdk';
import type { Activity, ActivityKind, Lap } from '@/db/types';
import { MIN_SPEED_MS, downsamplePairs, isValidCoord, roundHalfEven, roundTo, simplifyTrack, speedSeriesToPace, trimPrivacy } from './geo';
import type { LatLon, Pair } from './geo';

export { DUPLICATE_TOLERANCE_SEC, findDuplicate } from './dedupe';

export const DEFAULT_PRIVACY_TRIM_M = 300;
export const MAX_FIT_BYTES = 50 * 1024 * 1024;
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

type Bytes = Uint8Array<ArrayBuffer>;

export class FitParseError extends Error {
  constructor(message = 'File FIT non leggibile.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'FitParseError';
  }
}

export interface ParseFitOptions {
  /** Metri tagliati a inizio e fine traccia (predefinito 300; 0 = nessun taglio). */
  privacyTrimM?: number;
}

/* ------------------------------------------------------------------ tipi e nomi (come normalize.py) */

const RUN_KEYS = new Set([
  'running',
  'trail_running',
  'treadmill_running',
  'track_running',
  'indoor_running',
  'street_running',
  'ultra_run',
  'virtual_run',
  'obstacle_run',
]);
const WALK_KEYS = new Set(['walking', 'hiking', 'casual_walking', 'speed_walking', 'indoor_walking']);
const BIKE_KEYS = new Set(['virtual_ride', 'bmx', 'cyclocross']);

export const DEFAULT_NAMES: Record<ActivityKind, string> = {
  corsa: 'Corsa',
  forza: 'Forza',
  camminata: 'Camminata',
  bici: 'Bici',
  nuoto: 'Nuoto',
  altro: 'Attività',
};

/** Chiave Garmin del tipo (es. 'trail_running') -> ActivityKind dell'app. */
export function kindFromTypeKey(typeKey: string | undefined): ActivityKind {
  const k = (typeKey ?? '').trim().toLowerCase();
  if (RUN_KEYS.has(k)) return 'corsa';
  if (k === 'strength_training') return 'forza';
  if (WALK_KEYS.has(k)) return 'camminata';
  if (k.includes('cycling') || k.includes('biking') || BIKE_KEYS.has(k) || k.startsWith('e_bike')) return 'bici';
  if (k.includes('swim')) return 'nuoto';
  return 'altro';
}

/** sport/sottosport del FIT -> chiave del tipo usata da Garmin Connect. */
const SPORT_SUB_KEYS: Record<string, string> = {
  'running/trail': 'trail_running',
  'running/treadmill': 'treadmill_running',
  'running/track': 'track_running',
  'running/street': 'street_running',
  'running/indoorRunning': 'indoor_running',
  'running/virtualActivity': 'virtual_run',
  'running/ultra': 'ultra_run',
  'running/obstacle': 'obstacle_run',
  'walking/indoorWalking': 'indoor_walking',
  'walking/casualWalking': 'casual_walking',
  'walking/speedWalking': 'speed_walking',
  'cycling/road': 'road_biking',
  'cycling/mountain': 'mountain_biking',
  'cycling/downhill': 'downhill_biking',
  'cycling/indoorCycling': 'indoor_cycling',
  'cycling/spin': 'indoor_cycling',
  'cycling/virtualActivity': 'virtual_ride',
  'cycling/gravelCycling': 'gravel_cycling',
  'cycling/cyclocross': 'cyclocross',
  'cycling/trackCycling': 'track_cycling',
  'cycling/recumbent': 'recumbent_cycling',
  'cycling/handCycling': 'hand_cycling',
  'cycling/bmx': 'bmx',
  'cycling/eBikeFitness': 'e_bike_fitness',
  'cycling/eBikeMountain': 'e_bike_mountain',
  'eBiking/eBikeMountain': 'e_bike_mountain',
  'swimming/lapSwimming': 'lap_swimming',
  'swimming/openWater': 'open_water_swimming',
  'training/strengthTraining': 'strength_training',
  'training/cardioTraining': 'indoor_cardio',
  'training/yoga': 'yoga',
  'training/pilates': 'pilates',
  'training/hiit': 'hiit',
  'training/breathing': 'breathwork',
  'fitnessEquipment/treadmill': 'treadmill_running',
  'fitnessEquipment/indoorRowing': 'indoor_rowing',
  'fitnessEquipment/elliptical': 'elliptical',
  'fitnessEquipment/stairClimbing': 'stair_climbing',
  'fitnessEquipment/indoorCycling': 'indoor_cycling',
  'fitnessEquipment/strengthTraining': 'strength_training',
};
const SPORT_KEYS: Record<string, string> = { eBiking: 'e_bike_fitness', swimming: 'swimming', generic: 'other' };

export function typeKeyFromSport(sport: unknown, subSport: unknown): string {
  const s = typeof sport === 'string' ? sport : '';
  const sub = typeof subSport === 'string' ? subSport : '';
  if (!s) return 'other';
  return SPORT_SUB_KEYS[`${s}/${sub}`] ?? SPORT_KEYS[s] ?? exerciseKey(s)!.toLowerCase();
}

const CAMEL_RE = /(?<=[a-z])(?=[A-Z0-9])|(?<=[0-9])(?=[A-Za-z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

/** Nome Garmin in qualsiasi forma ('benchPress', 'bench_press', 'BENCH_PRESS') -> 'BENCH_PRESS'. */
export function exerciseKey(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name.trim()) return undefined;
  let s = name.trim();
  if (/[a-z]/.test(s)) s = s.replace(CAMEL_RE, '_');
  s = s.replace(/[\s-]+/g, '_').replace(/_+/g, '_').toUpperCase();
  return s || undefined;
}

/** 'BARBELL_BENCH_PRESS' -> 'Barbell bench press' (reversibile: maiuscolo e '_' tornano la chiave). */
export function humanizeKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const words = key.replace(/_/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : undefined;
}

/* ------------------------------------------------------------------ numeri */

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asInt(v: unknown, opts: { positive?: boolean; nonNegative?: boolean } = {}): number | undefined {
  const f = num(v);
  if (f === undefined || (opts.positive && f <= 0) || (opts.nonNegative && f < 0)) return undefined;
  return roundHalfEven(f);
}

function asRound(v: unknown, digits: number, positive = false): number | undefined {
  const f = num(v);
  if (f === undefined || (positive && f <= 0)) return undefined;
  return roundTo(f, digits);
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

function clean<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/* ------------------------------------------------------------------ ZIP e decodifica */

function isFitHeader(b: Uint8Array): boolean {
  return b.length >= 12 && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54; // '.FIT'
}

async function inflateRaw(data: Bytes, limit: number): Promise<Bytes> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new FitParseError('File FIT troppo grande.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Il download Garmin è uno ZIP con il file originale: estrae il primo .fit (o accetta un FIT nudo). */
export async function extractFit(input: ArrayBuffer | Uint8Array): Promise<Bytes> {
  const bytes = new Uint8Array(input instanceof Uint8Array ? input.slice().buffer : input.slice(0)) as Bytes;
  if (isFitHeader(bytes)) {
    if (bytes.length > MAX_FIT_BYTES) throw new FitParseError('File FIT troppo grande.');
    return bytes;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || dv.getUint32(0, true) !== 0x04034b50) throw new FitParseError('Il file non è un FIT né uno ZIP.');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FitParseError('ZIP danneggiato.');
  const entries = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  try {
    for (let n = 0; n < entries; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!name.toLowerCase().endsWith('.fit') || (flags & 1) !== 0 || size > MAX_FIT_BYTES) continue;
      if (dv.getUint32(local, true) !== 0x04034b50) throw new FitParseError('ZIP danneggiato.');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      if (start + compSize > bytes.length) throw new FitParseError('ZIP danneggiato.');
      const data = bytes.slice(start, start + compSize) as Bytes;
      if (method === 0) return data;
      if (method === 8) return await inflateRaw(data, MAX_FIT_BYTES);
    }
  } catch (e) {
    if (e instanceof FitParseError) throw e;
    throw new FitParseError('ZIP danneggiato.', { cause: e });
  }
  throw new FitParseError('Nello ZIP non c’è un file FIT.');
}

function decode(fit: Bytes): FitMessages {
  if (!Decoder.isFIT(Stream.fromByteArray(fit))) throw new FitParseError('Intestazione FIT non valida.');
  let messages: FitMessages;
  try {
    ({ messages } = new Decoder(Stream.fromByteArray(fit)).read({
      applyScaleAndOffset: true,
      expandSubFields: true,
      expandComponents: true,
      convertTypesToStrings: true,
      convertDateTimesToDates: true,
      mergeHeartRates: true,
    }));
  } catch (e) {
    throw new FitParseError('Decodifica FIT non riuscita.', { cause: e });
  }
  if (!messages || (!messages.sessionMesgs?.length && !messages.recordMesgs?.length)) {
    throw new FitParseError('Il file FIT non contiene un’attività.');
  }
  const type = (messages.fileIdMesgs?.[0] as FileIdMesg | undefined)?.type;
  if (type !== undefined && type !== 'activity') throw new FitParseError('Il file FIT non è un’attività.');
  return messages;
}

/* ------------------------------------------------------------------ orari */

const asDate = (v: unknown): Date | undefined => (v instanceof Date && Number.isFinite(v.getTime()) ? v : undefined);
const pad = (n: number) => String(n).padStart(2, '0');

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const m = Math.abs(minutes);
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Istante -> '2026-11-18T07:00:05+01:00' (ora locale con il suo scostamento). */
export function isoWithOffset(ms: number, offsetMin: number): string {
  const t = Math.floor(ms / 1000) * 1000 + offsetMin * 60_000;
  const d = new Date(t);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date}T${time}${formatOffset(offsetMin)}`;
}

/** Scostamento locale dal messaggio 'activity' (local_timestamp - timestamp), al quarto d'ora. */
function offsetMinutes(activity: ActivityMesg | undefined, at: Date): number {
  const ts = asDate(activity?.timestamp);
  const lt: unknown = activity?.localTimestamp;
  const localMs = typeof lt === 'number' ? Utils.FIT_EPOCH_MS + lt * 1000 : asDate(lt)?.getTime();
  if (ts && localMs !== undefined && Number.isFinite(localMs)) {
    const off = roundHalfEven((localMs - ts.getTime()) / 60_000 / 15) * 15;
    if (Math.abs(off) <= 14 * 60) return off;
  }
  return -at.getTimezoneOffset(); // fuso del dispositivo che importa
}

/* ------------------------------------------------------------------ serie di forza */

function exerciseNameKey(category: string | undefined, subtype: unknown): string | undefined {
  const sub = asInt(first(subtype), { nonNegative: true });
  if (!category || sub === undefined) return undefined;
  const table = (Profile.types as Record<string, Record<number, string> | undefined>)[`${category}ExerciseName`];
  return table ? exerciseKey(table[sub]) : undefined;
}

type ExerciseSet = NonNullable<Activity['exerciseSets']>[number];

function exerciseSet(categoryKey: string | undefined, nameKey: string | undefined, s: SetMesg): ExerciseSet {
  const category = categoryKey && categoryKey !== 'UNKNOWN' ? categoryKey : undefined;
  return clean({
    name: humanizeKey(nameKey) ?? humanizeKey(category) ?? 'Esercizio',
    category,
    reps: asInt(s.repetitions, { positive: true }),
    kg: asRound(s.weight, 2, true),
    durationSec: asInt(s.duration, { positive: true }),
  });
}

/* ------------------------------------------------------------------ attività */

async function sha256Hex16(data: Bytes): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hrZones(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const vals = raw.map((v) => num(v));
  // Garmin scrive 6 valori (il primo è il tempo sotto la zona 1); l'app vuole le zone 1..5.
  const zones = vals.length >= 6 ? vals.slice(1, 6) : vals.length === 5 ? vals : undefined;
  if (!zones || zones.every((z) => z === undefined)) return undefined;
  return zones.map((z) => roundHalfEven(z ?? 0));
}

/** Legge un file FIT (o lo ZIP di Garmin Connect) e restituisce l'attività normalizzata. */
export async function parseFitFile(buf: ArrayBuffer | Uint8Array, opts: ParseFitOptions = {}): Promise<Activity> {
  const fit = await extractFit(buf);
  const messages = decode(fit);
  const session = (messages.sessionMesgs?.[0] ?? {}) as SessionMesg;
  const records = (messages.recordMesgs ?? []) as RecordMesg[];

  const stamps = records.map((r) => asDate(r.timestamp)).filter((d): d is Date => d !== undefined);
  const start =
    asDate(session.startTime) ??
    (stamps.length ? new Date(Math.min(...stamps.map((d) => d.getTime()))) : undefined) ??
    asDate((messages.fileIdMesgs?.[0] as FileIdMesg | undefined)?.timeCreated);
  if (!start) throw new FitParseError('Il file FIT non ha data e ora.');

  const typeKey = typeKeyFromSport(session.sport, session.subSport);
  const kind = kindFromTypeKey(typeKey);
  const startMs = start.getTime();

  let duration = num(session.totalTimerTime) ?? num(session.totalElapsedTime);
  if (duration === undefined && stamps.length) duration = (Math.max(...stamps.map((d) => d.getTime())) - startMs) / 1000;
  const distance = asInt(session.totalDistance, { positive: true });
  const speed = num(session.enhancedAvgSpeed) ?? num(session.avgSpeed);
  const pace = distance && speed && speed > 0 && kind !== 'forza' ? roundHalfEven(1000 / speed) : undefined;

  let cadence: number | undefined;
  const rawCadence = num(session.avgRunningCadence) ?? num(session.avgCadence);
  if (rawCadence !== undefined && rawCadence > 0) {
    if (kind === 'corsa' || kind === 'camminata') cadence = roundHalfEven((rawCadence + (num(session.avgFractionalCadence) ?? 0)) * 2);
    else if (kind === 'bici') cadence = roundHalfEven(rawCadence);
  }

  /* -------------------------------------------------------------- record */
  const trackRaw: LatLon[] = [];
  const hr: Pair[] = [];
  const speeds: Pair[] = [];
  for (const rec of records) {
    const lat = rec.positionLat;
    const lon = rec.positionLong;
    if (Number.isInteger(lat) && Number.isInteger(lon)) {
      const dlat = (lat as number) * SEMICIRCLE_TO_DEG;
      const dlon = (lon as number) * SEMICIRCLE_TO_DEG;
      if (isValidCoord(dlat, dlon)) trackRaw.push([dlat, dlon]);
    }
    const ts = asDate(rec.timestamp);
    if (!ts) continue;
    const t = (ts.getTime() - startMs) / 1000;
    if (t < 0) continue;
    const bpm = asInt(rec.heartRate, { positive: true });
    if (bpm !== undefined && bpm < 250) hr.push([t, bpm]);
    const v = num(rec.enhancedSpeed) ?? num(rec.speed);
    if (v !== undefined) speeds.push([t, v]);
  }

  const activity: Activity = clean({
    id: `fit:${await sha256Hex16(fit)}`,
    source: 'fit' as const,
    kind,
    typeKey,
    name: DEFAULT_NAMES[kind],
    start: isoWithOffset(startMs, offsetMinutes(messages.activityMesgs?.[0] as ActivityMesg | undefined, start)),
    durationSec: roundHalfEven(Math.max(duration ?? 0, 0)),
    movingSec: asInt(session.totalMovingTime, { positive: true }),
    distanceM: distance,
    avgHr: asInt(session.avgHeartRate, { positive: true }),
    maxHr: asInt(session.maxHeartRate, { positive: true }),
    calories: asInt(session.totalCalories, { positive: true }),
    elevGainM: asInt(session.totalAscent, { nonNegative: true }),
    avgPaceSecPerKm: pace,
    avgCadence: cadence,
    aerobicTE: asRound(session.totalTrainingEffect, 1, true),
    anaerobicTE: asRound(session.totalAnaerobicTrainingEffect, 1, true),
    trainingLoad: asRound(session.trainingLoadPeak, 1, true),
    hrZonesSec: hrZones(session.timeInHrZone),
  });

  /* -------------------------------------------------------------- dettagli */
  if (kind !== 'forza') {
    const laps: Lap[] = [];
    for (const lap of (messages.lapMesgs ?? []) as LapMesg[]) {
      const d = num(lap.totalTimerTime) ?? num(lap.totalElapsedTime);
      if (!d || d <= 0) continue;
      const dist = asInt(lap.totalDistance, { positive: true });
      const sp = num(lap.enhancedAvgSpeed) ?? num(lap.avgSpeed);
      laps.push(
        clean({
          durationSec: roundHalfEven(d),
          distanceM: dist,
          avgHr: asInt(lap.avgHeartRate, { positive: true }),
          avgPaceSecPerKm: dist && sp && sp >= MIN_SPEED_MS ? roundHalfEven(1000 / sp) : undefined,
        }),
      );
    }
    if (laps.length) activity.laps = laps;
    const track = simplifyTrack(trimPrivacy(trackRaw, opts.privacyTrimM ?? DEFAULT_PRIVACY_TRIM_M));
    if (track.length >= 2) activity.track = track;
    const paceSeries = speedSeriesToPace(speeds);
    if (paceSeries.length) activity.paceSeries = paceSeries;
  }
  if (hr.length) activity.hrSeries = downsamplePairs(hr);

  const sets: ExerciseSet[] = [];
  for (const s of (messages.setMesgs ?? []) as SetMesg[]) {
    if (String(s.setType ?? 'active').toLowerCase() !== 'active') continue;
    const rawCat = first(s.category);
    const category = typeof rawCat === 'string' && rawCat !== 'unknown' ? rawCat : undefined;
    sets.push(exerciseSet(exerciseKey(category), exerciseNameKey(category, s.categorySubtype), s));
  }
  if (sets.length) activity.exerciseSets = sets;
  return activity;
}
