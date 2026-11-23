import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, setSetting } from '@/db/db';
import { useProfile, useSetting } from '@/app/hooks';
import { useTargets, useTodayPlan } from '@/app/engine';
import { dailyIntake, weeklyCheckIn, type CheckInResult } from '@/lib/nutrition';
import { addDays, todayISO } from '@/lib/dates';
import { fmtInt, fmt1 } from '@/lib/format';
import { useToast } from '@/components/ui';

/** Proposta del lunedì: dispendio ricalcolato dal trend del peso e dalle calorie registrate. */
export function useCheckIn(): CheckInResult | null | undefined {
  const today = todayISO();
  const profile = useProfile();
  const plan = useTodayPlan(today);
  const t = useTargets(today, plan);
  const weights = useLiveQuery(() => db.weights.where('date').between(addDays(today, -56), today, true, true).toArray(), [today]);
  const log = useLiveQuery(() => db.foodLog.where('date').between(addDays(today, -28), today, true, true).toArray(), [today]);
  // primo giorno di uso vero (prima pesata e primo pasto di sempre): la settimana di assestamento si scarta una volta sola
  const first = useLiveQuery(async () => {
    const [w, f] = await Promise.all([db.weights.orderBy('date').first(), db.foodLog.orderBy('date').first()]);
    return { w: w?.date, f: f?.date };
  }, []);
  const [tdee] = useSetting<number | null>('nutrition.tdee', null);
  return useMemo(() => {
    if (profile === null || !weights || !log || !first || t === undefined) return undefined;
    if (!profile || !t) return null;
    const startDate = first.w && first.f ? (first.w > first.f ? first.w : first.f) : undefined;
    return weeklyCheckIn({
      startDate,
      asOf: today,
      weights,
      intake: dailyIntake(log),
      previousTdee: tdee ?? t.targets.tdee.value,
      bmr: t.targets.bmr.value,
      goal: profile.goal,
      experience: profile.experience,
      currentTargetKcal: t.targets.average.kcal.value,
    });
  }, [profile, weights, log, first, t, tdee, today]);
}

export function CheckInCard({ showInsufficient }: { showInsufficient?: boolean }) {
  const toast = useToast();
  const r = useCheckIn();
  const [done] = useSetting<string | null>('nutrition.checkin.monday', null);
  if (!r) return null;
  if (r.status === 'dati-insufficienti') {
    if (!showInsufficient) return null;
    return (
      <section className="section">
        <h2>Revisione del lunedì</h2>
        <p className="small muted">{r.reason}</p>
        {r.missing.length > 0 && <p className="xs muted">Manca: {r.missing.join('; ')}.</p>}
      </section>
    );
  }
  if (done === r.monday) return null;
  const up = r.deltaKcal > 0;
  return (
    <section className="section" aria-labelledby="h-check">
      <h2 id="h-check">Revisione del lunedì</h2>
      <div className="panel panel--raised">
        <p>{r.reason}</p>
        <div className="grid-3">
          <div className="metric">
            <span className="metric-v">{fmt1(r.trendChangeKg)}</span>
            <span className="metric-l">kg di tendenza</span>
          </div>
          <div className="metric">
            <span className="metric-v">{fmtInt(r.avgKcal)}</span>
            <span className="metric-l">kcal medie registrate</span>
          </div>
          <div className="metric">
            <span className="metric-v">{fmtInt(r.newTdee)}</span>
            <span className="metric-l">dispendio stimato</span>
          </div>
        </div>
        {r.deltaKcal !== 0 && (
          <p className="small">
            Proposta: obiettivo {up ? 'più alto' : 'più basso'} di {fmtInt(Math.abs(r.deltaKcal))} kcal al giorno, cioè {fmtInt(r.kcalTarget)} kcal.
          </p>
        )}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={async () => {
              await setSetting('nutrition.tdee', r.newTdee);
              await setSetting('nutrition.checkin.monday', r.monday);
              toast('Obiettivi aggiornati.');
            }}
          >
            Applica
          </button>
          <button type="button" className="btn" onClick={() => setSetting('nutrition.checkin.monday', r.monday)}>
            Non ora
          </button>
        </div>
      </div>
    </section>
  );
}
