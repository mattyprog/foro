import { Encoder, Profile, Utils } from '@garmin/fitsdk';
import type { ActivityMesg, EventMesg, FileIdMesg, LapMesg, Mesg, RecordMesg, SessionMesg, SetMesg } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import type { Activity } from '@/db/types';
import { haversineM } from './geo';
import { FitParseError, findDuplicate, parseFitFile } from './parseFit';

/* ------------------------------------------------------------------ file FIT SINTETICI */

const M = Profile.MesgNum;
// Sede Garmin a Olathe (Kansas): un luogo pubblico qualsiasi, nessun dato reale.
const START_LAT = 38.8556;
const START_LON = -94.799;
const RUN_START = new Date(Date.UTC(2026, 10, 18, 6, 0, 5)); // 07:00:05 a Roma
const semi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

function put<T extends Mesg>(enc: Encoder, mesgNum: number, mesg: T): void {
  enc.writeMesg({ ...mesg, mesgNum });
}

function runFit(): Uint8Array {
  const pace = 300; // 5:00/km
  const speed = 1000 / pace;
  const seconds = 3 * pace; // 3 km
  const at = (s: number) => new Date(RUN_START.getTime() + s * 1000);
  const enc = new Encoder();
  put<FileIdMesg>(enc, M.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: RUN_START, serialNumber: 4242 });
  put<EventMesg>(enc, M.EVENT, { timestamp: RUN_START, event: 'timer', eventType: 'start' });
  for (let s = 0; s <= seconds; s++) {
    const d = s * speed;
    const dLat = (d * Math.cos(Math.PI / 6)) / 111_195;
    const dLon = (d * Math.sin(Math.PI / 6)) / (111_195 * Math.cos((START_LAT * Math.PI) / 180));
    put<RecordMesg>(enc, M.RECORD, {
      timestamp: at(s),
      positionLat: semi(START_LAT + dLat),
      positionLong: semi(START_LON + dLon),
      heartRate: 120 + Math.floor((40 * s) / seconds),
      distance: d,
      enhancedSpeed: speed,
    });
  }
  for (let i = 0; i < 3; i++) {
    put<LapMesg>(enc, M.LAP, {
      messageIndex: i,
      timestamp: at((i + 1) * pace),
      startTime: at(i * pace),
      totalElapsedTime: pace,
      totalTimerTime: pace,
      totalDistance: 1000,
      enhancedAvgSpeed: speed,
      avgHeartRate: 130 + 10 * i,
      maxHeartRate: 140 + 10 * i,
    });
  }
  const end = at(seconds);
  put<SessionMesg>(enc, M.SESSION, {
    messageIndex: 0,
    timestamp: end,
    startTime: RUN_START,
    totalElapsedTime: seconds + 20,
    totalTimerTime: seconds,
    totalDistance: 3000,
    sport: 'running',
    subSport: 'generic',
    avgHeartRate: 140,
    maxHeartRate: 160,
    totalCalories: 210,
    enhancedAvgSpeed: speed,
    totalAscent: 12,
    avgCadence: 83,
    totalTrainingEffect: 2.8,
    totalAnaerobicTrainingEffect: 0.3,
    timeInHrZone: [30, 300, 450, 120, 0],
    firstLapIndex: 0,
    numLaps: 3,
  });
  put<ActivityMesg>(enc, M.ACTIVITY, {
    timestamp: end,
    totalTimerTime: seconds,
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
    localTimestamp: Utils.convertDateToDateTime(end) + 3600, // ora locale +01:00
  });
  return enc.close();
}

const STRENGTH_START = new Date(Date.UTC(2026, 10, 19, 17, 0, 0));

function strengthFit(): Uint8Array {
  const at = (s: number) => new Date(STRENGTH_START.getTime() + s * 1000);
  const enc = new Encoder();
  put<FileIdMesg>(enc, M.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: STRENGTH_START, serialNumber: 4242 });
  for (let s = 0; s <= 600; s += 5) put<RecordMesg>(enc, M.RECORD, { timestamp: at(s), heartRate: 95 + (Math.floor(s / 20) % 30) });
  const sets: (SetMesg & { start: number; duration: number })[] = [
    { start: 0, duration: 40, setType: 'active', repetitions: 10, weight: 60, category: ['benchPress'], categorySubtype: [1] },
    { start: 40, duration: 120, setType: 'rest' },
    { start: 160, duration: 45, setType: 'active', repetitions: 8, weight: 80, category: ['squat'], categorySubtype: [6] },
  ];
  sets.forEach(({ start, duration, ...rest }, i) =>
    put<SetMesg>(enc, M.SET, { messageIndex: i, timestamp: at(start + duration), startTime: at(start), duration, ...rest }),
  );
  put<LapMesg>(enc, M.LAP, { messageIndex: 0, timestamp: at(600), startTime: STRENGTH_START, totalElapsedTime: 600, totalTimerTime: 600 });
  put<SessionMesg>(enc, M.SESSION, {
    messageIndex: 0,
    timestamp: at(600),
    startTime: STRENGTH_START,
    totalElapsedTime: 600,
    totalTimerTime: 600,
    sport: 'training',
    subSport: 'strengthTraining',
    avgHeartRate: 110,
    maxHeartRate: 140,
    totalCalories: 150,
  });
  return enc.close();
}

const toBuffer = (u8: Uint8Array): ArrayBuffer => u8.slice().buffer as ArrayBuffer;

/* ------------------------------------------------------------------ ZIP come l'export di Garmin Connect */

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(data as Uint8Array<ArrayBuffer>);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function zipOf(name: string, data: Uint8Array, method: 0 | 8): Promise<ArrayBuffer> {
  const body = method === 8 ? await deflateRaw(data) : data;
  const nameB = new TextEncoder().encode(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, method, true);
  local.setUint32(14, crc32(data), true);
  local.setUint32(18, body.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameB.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(10, method, true);
  central.setUint32(16, crc32(data), true);
  central.setUint32(20, body.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, nameB.length, true);
  central.setUint32(42, 0, true);
  const cdOffset = 30 + nameB.length + body.length;
  const cdSize = 46 + nameB.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOffset, true);
  const parts = [new Uint8Array(local.buffer), nameB, body, new Uint8Array(central.buffer), nameB, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

/* ------------------------------------------------------------------ test */

describe('parseFitFile', () => {
  it('corsa di 3 km: riepilogo dal messaggio session', async () => {
    const a = await parseFitFile(toBuffer(runFit()));
    expect(a.id).toMatch(/^fit:[0-9a-f]{16}$/);
    expect(a).toMatchObject({
      source: 'fit',
      kind: 'corsa',
      typeKey: 'running',
      name: 'Corsa',
      start: '2026-11-18T07:00:05+01:00',
      durationSec: 900,
      distanceM: 3000,
      avgHr: 140,
      maxHr: 160,
      calories: 210,
      elevGainM: 12,
      avgPaceSecPerKm: 300,
      avgCadence: 166,
      aerobicTE: 2.8,
      anaerobicTE: 0.3,
      hrZonesSec: [30, 300, 450, 120, 0],
    });
    expect(Date.parse(a.start)).toBe(RUN_START.getTime());
    expect(a.exerciseSets).toBeUndefined();
  });

  it('corsa: giri, traccia tagliata e semplificata, serie FC e passo sottocampionate', async () => {
    const a = await parseFitFile(toBuffer(runFit()));
    expect(a.laps).toHaveLength(3);
    expect(a.laps?.[0]).toEqual({ durationSec: 300, distanceM: 1000, avgHr: 130, avgPaceSecPerKm: 300 });
    expect(a.track!.length).toBeGreaterThanOrEqual(2);
    expect(a.track!.length).toBeLessThanOrEqual(500);
    for (const [lat, lon] of a.track!) expect(haversineM(START_LAT, START_LON, lat, lon)).toBeGreaterThanOrEqual(299);
    expect(a.hrSeries!.length).toBeLessThanOrEqual(600);
    expect(a.hrSeries![0]).toEqual([0, 120]);
    expect(a.paceSeries!.length).toBeLessThanOrEqual(600);
    expect(a.paceSeries!.every(([, p]) => p === 300)).toBe(true);
  });

  it('il taglio privacy è configurabile', async () => {
    const a = await parseFitFile(toBuffer(runFit()), { privacyTrimM: 0 });
    const [lat, lon] = a.track![0];
    expect(haversineM(START_LAT, START_LON, lat, lon)).toBeLessThan(5);
    const b = await parseFitFile(toBuffer(runFit()), { privacyTrimM: 800 });
    for (const [la, lo] of b.track!) expect(haversineM(START_LAT, START_LON, la, lo)).toBeGreaterThanOrEqual(799);
  });

  it('stesso file, stesso id; anche dentro uno ZIP (export "file originale")', async () => {
    const fit = runFit();
    const a = await parseFitFile(toBuffer(fit));
    const b = await parseFitFile(toBuffer(fit));
    expect(b.id).toBe(a.id);
    for (const method of [0, 8] as const) {
      const fromZip = await parseFitFile(await zipOf('9000000101_ACTIVITY.fit', fit, method));
      expect(fromZip).toEqual(a);
    }
  });

  it('seduta di forza con 2 serie: nomi leggibili e chiavi Garmin', async () => {
    const a = await parseFitFile(toBuffer(strengthFit()));
    expect(a.kind).toBe('forza');
    expect(a.typeKey).toBe('strength_training');
    expect(a.name).toBe('Forza');
    expect(Date.parse(a.start)).toBe(STRENGTH_START.getTime());
    expect(a.durationSec).toBe(600);
    expect(a.exerciseSets).toEqual([
      { name: 'Barbell bench press', category: 'BENCH_PRESS', reps: 10, kg: 60, durationSec: 40 },
      { name: 'Barbell back squat', category: 'SQUAT', reps: 8, kg: 80, durationSec: 45 },
    ]);
    expect(a.track).toBeUndefined();
    expect(a.paceSeries).toBeUndefined();
    expect(a.laps).toBeUndefined();
    expect(a.hrSeries!.length).toBeGreaterThan(10);
    expect(a.distanceM).toBeUndefined();
  });

  it('file non FIT o ZIP senza FIT: FitParseError', async () => {
    const notFit = new TextEncoder().encode('questo non è un file FIT, è solo testo qualsiasi').buffer as ArrayBuffer;
    const e1 = await parseFitFile(notFit).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(FitParseError);
    expect((e1 as Error).name).toBe('FitParseError');
    const zipNoFit = await zipOf('leggimi.txt', new TextEncoder().encode('niente'), 0);
    await expect(parseFitFile(zipNoFit)).rejects.toBeInstanceOf(FitParseError);
  });
});

describe('findDuplicate', () => {
  const garminRun: Activity = {
    id: 'garmin:9000000101',
    source: 'garmin',
    kind: 'corsa',
    typeKey: 'running',
    name: 'Corsa',
    start: '2026-11-18T07:00:05+01:00',
    durationSec: 900,
  };

  it('trova la stessa attività Garmin (stesso tipo, inizio entro 90 s)', async () => {
    const fromFit = await parseFitFile(toBuffer(runFit()));
    expect(findDuplicate(fromFit, [garminRun])?.id).toBe('garmin:9000000101');
    expect(findDuplicate({ ...fromFit, start: '2026-11-18T06:01:30Z' }, [garminRun])?.id).toBe('garmin:9000000101');
  });

  it('non confonde attività di tipo diverso o lontane nel tempo', () => {
    expect(findDuplicate({ kind: 'corsa', start: '2026-11-18T06:02:00Z' }, [garminRun])).toBeUndefined();
    expect(findDuplicate({ kind: 'camminata', start: garminRun.start }, [garminRun])).toBeUndefined();
    expect(findDuplicate({ kind: 'corsa', start: 'non è una data' }, [garminRun])).toBeUndefined();
  });

  it('se ce ne sono più di una sceglie la più vicina', () => {
    const near = { ...garminRun, id: 'garmin:2', start: '2026-11-18T06:00:10Z' };
    expect(findDuplicate({ kind: 'corsa', start: '2026-11-18T06:00:12Z' }, [garminRun, near])?.id).toBe('garmin:2');
  });
});
