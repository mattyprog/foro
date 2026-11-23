import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDB } from '@/db/db';
import type { Activity, GymSession } from '@/db/types';
import { linkGymSessions, matchScore } from './linkSessions';

const dbs: AppDB[] = [];
const fresh = () => {
  const d = new AppDB(`test-link-${Math.random().toString(36).slice(2)}`);
  dbs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

const session = (date: string, from: string, to: string, extra: Partial<GymSession> = {}): GymSession => ({
  date,
  startedAt: `${date}T${from}:00+01:00`,
  endedAt: `${date}T${to}:00+01:00`,
  sets: [{ exerciseId: 'leg-press', setIndex: 0, kg: 80, reps: 10, done: true }],
  ...extra,
});
const act = (id: string, date: string, at: string, min: number, kind: Activity['kind'] = 'forza'): Activity => ({
  id, source: 'garmin', kind, typeKey: kind === 'forza' ? 'strength_training' : 'running', name: id,
  start: `${date}T${at}:00+01:00`, durationSec: min * 60,
});

describe('sedute e attività di forza del Garmin', () => {
  it('abbina la stessa seduta, non le corse né i giorni diversi', async () => {
    const db = fresh();
    const a = await db.sessions.add(session('2026-11-23', '18:30', '19:35'));
    const b = await db.sessions.add(session('2026-11-21', '10:00', '11:00'));
    await db.activities.bulkPut([
      act('g-forza', '2026-11-23', '18:33', 60),
      act('g-corsa', '2026-11-23', '18:30', 30, 'corsa'),
      act('g-altro-giorno', '2026-11-22', '10:00', 60),
    ]);
    expect(await linkGymSessions(db)).toBe(1);
    expect((await db.sessions.get(a))?.activityId).toBe('g-forza');
    expect((await db.sessions.get(b))?.activityId).toBeUndefined();
    // seconda passata: niente da rifare
    expect(await linkGymSessions(db)).toBe(0);
  });

  it('due sedute nello stesso giorno: ognuna prende la sua attività', async () => {
    const db = fresh();
    const mattina = await db.sessions.add(session('2026-11-23', '07:00', '07:50'));
    const sera = await db.sessions.add(session('2026-11-23', '19:00', '20:00'));
    await db.activities.bulkPut([act('g-sera', '2026-11-23', '19:02', 55), act('g-mattina', '2026-11-23', '07:01', 48)]);
    await linkGymSessions(db);
    expect((await db.sessions.get(mattina))?.activityId).toBe('g-mattina');
    expect((await db.sessions.get(sera))?.activityId).toBe('g-sera');
  });

  it('le sedute aperte e le coppie già fatte restano come sono', async () => {
    const db = fresh();
    const aperta = await db.sessions.add({ ...session('2026-11-23', '18:30', '19:30'), endedAt: undefined });
    const fatta = await db.sessions.add(session('2026-11-20', '18:30', '19:30', { activityId: 'g-vecchia' }));
    await db.activities.bulkPut([act('g-oggi', '2026-11-23', '18:31', 50), act('g-vecchia', '2026-11-20', '18:31', 50)]);
    expect(await linkGymSessions(db)).toBe(0);
    expect((await db.sessions.get(aperta))?.activityId).toBeUndefined();
    expect((await db.sessions.get(fatta))?.activityId).toBe('g-vecchia');
  });

  it('punteggio: partenze lontane senza sovrapposizione non valgono', () => {
    const s = session('2026-11-23', '18:00', '18:40');
    expect(matchScore(s, act('x', '2026-11-23', '19:30', 30))).toBeUndefined();
    expect(matchScore(s, act('y', '2026-11-23', '18:20', 30))).toBeGreaterThan(-Infinity);
  });
});
