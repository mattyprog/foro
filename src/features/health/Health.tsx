import { useMemo } from 'react';
import { Link } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { CaretRight, UserCircle } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { Activity, WellnessDay } from '@/db/types';
import { HrvBand, SleepNights, WeightChart } from '@/components/charts/Charts';
import { Corsia } from '@/components/Corsia';
import { Empty } from '@/components/ui';
import { SyncLine } from '@/features/settings/SyncLine';
import { ReadinessLine } from '@/features/health/ReadinessLine';
import { addDays, rangeDays, todayISO, startOfWeek } from '@/lib/dates';
import { fmt1, fmtInt, fmtSleep } from '@/lib/format';
import { weightTrend } from '@/features/health/weight';

export function Health() {
  const today = todayISO();
  const from21 = addDays(today, -20);
  const wellness = useLiveQuery(() => db.wellness.where('date').between(addDays(today, -59), today, true, true).toArray(), [today]);
  const weights = useLiveQuery(() => db.weights.where('date').between(addDays(today, -89), today, true, true).toArray(), [today]);
  const weekStart = startOfWeek(today);
  const weekActs = useLiveQuery(() => db.activities.where('start').aboveOrEqual(weekStart).toArray(), [weekStart]);

  const byDate = useMemo(() => new Map((wellness ?? []).map((w) => [w.date, w])), [wellness]);
  const last: WellnessDay | undefined = useMemo(() => {
    const list = (wellness ?? []).filter((w) => w.sleepSec || w.restingHr || w.hrvNightAvg);
    return list.sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  }, [wellness]);

  if (wellness === undefined || weights === undefined) return <main className="screen" />;

  const nights = rangeDays(addDays(today, -6), today)
    .reverse()
    .map((d) => {
      const w = byDate.get(d);
      return {
        date: d,
        start: w?.sleepStart,
        end: w?.sleepEnd,
        totalSec: w?.sleepSec,
        deepSec: w?.deepSec,
        lightSec: w?.lightSec,
        remSec: w?.remSec,
        awakeSec: w?.awakeSec,
      };
    });

  const hrv = rangeDays(from21, today).map((d) => {
    const w = byDate.get(d);
    return { date: d, value: w?.hrvNightAvg, low: w?.hrvBaselineLow, high: w?.hrvBaselineHigh };
  });

  const rhr7 = rangeDays(addDays(today, -7), addDays(today, -1))
    .map((d) => byDate.get(d)?.restingHr)
    .filter((n): n is number => n !== undefined);
  const rhrAvg = rhr7.length ? rhr7.reduce((a, b) => a + b, 0) / rhr7.length : undefined;

  const sortedW = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const trend = weightTrend(sortedW);

  const weekDays = rangeDays(weekStart, today);
  const steps = weekDays.map((d) => byDate.get(d)?.steps ?? 0);
  const zones = zoneTotals(weekActs ?? []);
  const vo2 = [...(wellness ?? [])].filter((w) => w.vo2max).sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.vo2max;

  const nothing = wellness.length === 0 && weights.length === 0;

  return (
    <main className="screen">
      <header className="topbar">
        <div className="topbar-title">
          <h1>Salute</h1>
          <SyncLine />
        </div>
        <Link href="/profilo" className="icon-btn" aria-label="Profilo e impostazioni">
          <UserCircle size={28} />
        </Link>
      </header>

      {nothing ? (
        <Empty
          action={
            <Link href="/profilo" className="btn">
              Collega Garmin
            </Link>
          }
        >
          Nessun dato di salute. Collega la sync Garmin o registra il peso dal +.
        </Empty>
      ) : (
        <>
          <ReadinessLine />

          <section className="section" aria-labelledby="h-sonno">
            <div className="section-head">
              <h2 id="h-sonno">Sonno</h2>
              <span className="num small">
                {last?.sleepSec ? fmtSleep(last.sleepSec) : 'n.d.'}
                {last?.sleepScore !== undefined && <span className="muted"> · punteggio {last.sleepScore}</span>}
              </span>
            </div>
            <SleepNights nights={nights} />
          </section>

          <section className="section" aria-labelledby="h-hrv">
            <div className="section-head">
              <h2 id="h-hrv">HRV notturna</h2>
              {last?.hrvStatus && <span className="tag">{hrvStatusIt(last.hrvStatus)}</span>}
            </div>
            {hrv.some((h) => h.value !== undefined) ? <HrvBand data={hrv} /> : <p className="muted small">Ancora nessuna notte con l'HRV.</p>}
          </section>

          <section className="section" aria-labelledby="h-rec">
            <h2 id="h-rec">Recupero</h2>
            <div className="panel">
              <div className="grid-3">
                <div className="metric">
                  <span className="metric-v">{last?.restingHr ?? 'n.d.'}</span>
                  <span className="metric-l">
                    FC a riposo{rhrAvg !== undefined && <> · media {fmtInt(rhrAvg)}</>}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-v">
                    {last?.bodyBatteryHigh ?? 'n.d.'}
                    {last?.bodyBatteryLow !== undefined && <span className="unit">/ {last.bodyBatteryLow}</span>}
                  </span>
                  <span className="metric-l">Body Battery max/min</span>
                </div>
                <div className="metric">
                  <span className="metric-v">{last?.stressAvg ?? 'n.d.'}</span>
                  <span className="metric-l">Stress medio</span>
                </div>
              </div>
            </div>
          </section>

          <section className="section" aria-labelledby="h-peso">
            <div className="section-head">
              <h2 id="h-peso">Peso</h2>
              <Link href="/salute/peso" className="btn btn--ghost">
                Registra <CaretRight size={16} />
              </Link>
            </div>
            {sortedW.length > 0 ? (
              <WeightChart points={sortedW.map((w) => ({ date: w.date, kg: w.kg }))} trend={trend} />
            ) : (
              <p className="muted small">Pesati la mattina, a digiuno: bastano 3-4 volte a settimana.</p>
            )}
          </section>

          <section className="section" aria-labelledby="h-sett">
            <h2 id="h-sett">Questa settimana</h2>
            <Corsia
              label="Passi"
              value={steps.reduce((a, b) => a + b, 0)}
              target={weekDays.length * 8000}
              segments={steps.map((s, i) => ({ id: weekDays[i], value: s }))}
              foot="Obiettivo indicativo: 8.000 al giorno."
            />
            <ZonesLane zones={zones} />
            <div className="split small">
              <span className="muted">VO2max</span>
              <span className="num">{vo2 !== undefined ? fmt1(vo2) : 'n.d.'}</span>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function hrvStatusIt(s: string): string {
  const m: Record<string, string> = {
    BALANCED: 'equilibrata',
    UNBALANCED: 'sbilanciata',
    LOW: 'bassa',
    POOR: 'scarsa',
    NONE: 'in calibrazione',
  };
  return m[s.toUpperCase()] ?? s.toLowerCase();
}

function zoneTotals(acts: Activity[]): number[] {
  const z = [0, 0, 0, 0, 0];
  for (const a of acts) a.hrZonesSec?.forEach((s, i) => (z[i] += s));
  return z;
}

const ZONE_TONES = [
  'color-mix(in oklch, var(--accent) 25%, var(--bg))',
  'color-mix(in oklch, var(--accent) 45%, var(--bg))',
  'color-mix(in oklch, var(--accent) 65%, var(--bg))',
  'color-mix(in oklch, var(--accent) 85%, var(--bg))',
  'var(--accent-strong)',
];

function ZonesLane({ zones }: { zones: number[] }) {
  const tot = zones.reduce((a, b) => a + b, 0);
  if (tot === 0) return null;
  return (
    <div className="corsia">
      <div className="corsia-head">
        <span className="corsia-label">Tempo nelle zone cardiache</span>
        <span className="corsia-value num">
          {fmtInt(tot / 60)}
          <span className="unit">min</span>
        </span>
      </div>
      <div className="corsia-track" style={{ height: 18 }} role="img" aria-label={zones.map((s, i) => `zona ${i + 1}: ${Math.round(s / 60)} minuti`).join(', ')}>
        <div className="corsia-lane">
          <div className="corsia-fill" style={{ width: '100%' }}>
            {zones.map((s, i) =>
              s > 0 ? <span key={i} className="corsia-seg" style={{ flex: `${s} 1 0`, background: ZONE_TONES[i] }} title={`Z${i + 1}`} /> : null,
            )}
          </div>
        </div>
      </div>
      <div className="corsia-foot cluster">
        {zones.map((s, i) => (
          <span key={i} className="num">
            Z{i + 1} {fmtInt(s / 60)}′
          </span>
        ))}
      </div>
    </div>
  );
}
