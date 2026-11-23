import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Trash } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { Activity, Lap } from '@/db/types';
import { RouteLine } from '@/components/charts/Charts';
import { useToast } from '@/components/ui';
import { fmtDayLong, fmtDuration, fmtInt, fmtKm, fmtPace, fmtTime, fmt1 } from '@/lib/format';
import { KIND_ICON } from './Training';

/** Giri da 1 km ricavati dalla serie del passo, quando l'attività non ha i giri. */
export function kmSplitsFromPace(series: [number, number][]): Lap[] {
  const out: Lap[] = [];
  let dist = 0;
  let lapStart = 0;
  let lastT = series[0]?.[0] ?? 0;
  for (const [t, pace] of series) {
    const dt = t - lastT;
    lastT = t;
    if (pace > 0 && dt > 0) dist += (dt / pace) * 1000;
    if (dist >= 1000 * (out.length + 1)) {
      const dur = t - lapStart;
      out.push({ distanceM: 1000, durationSec: dur, avgPaceSecPerKm: dur });
      lapStart = t;
    }
  }
  return out;
}

export function ActivityDetail({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const toast = useToast();
  const a = useLiveQuery(() => db.activities.get(id), [id], null);

  const laps = useMemo<Lap[]>(() => {
    if (!a) return [];
    if (a.laps && a.laps.length > 1) return a.laps;
    if (a.paceSeries && a.paceSeries.length > 10) return kmSplitsFromPace(a.paceSeries);
    return a.laps ?? [];
  }, [a]);

  if (a === null) return <main className="screen" />;
  if (!a)
    return (
      <main className="screen">
        <p>Attività non trovata.</p>
        <button className="btn" onClick={() => navigate('/allenamento')}>
          Torna allo storico
        </button>
      </main>
    );

  const Icon = KIND_ICON[a.kind];
  const d = new Date(a.start);
  const isRun = a.kind === 'corsa' && !!a.distanceM;
  const pace = isRun ? (a.avgPaceSecPerKm ?? (a.durationSec / a.distanceM!) * 1000) : undefined;

  const remove = async () => {
    if (!confirm('Eliminare questa attività dallo storico del telefono?')) return;
    await db.activities.delete(a.id);
    toast('Attività eliminata.');
    navigate('/allenamento');
  };

  return (
    <main className="screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => history.back()} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1 className="cluster" style={{ gap: 8 }}>
            <Icon size={24} /> {a.name}
          </h1>
          <span className="small muted">
            {fmtDayLong(d)}, {fmtTime(d)} · {a.source === 'garmin' ? 'Garmin' : a.source === 'fit' ? 'file FIT' : 'inserita a mano'}
          </span>
        </div>
      </header>

      {isRun ? <RunBody a={a} laps={laps} pace={pace!} /> : <OtherBody a={a} />}

      <button type="button" className="btn btn--ghost btn--danger" onClick={remove}>
        <Trash size={18} /> Elimina dal telefono
      </button>
    </main>
  );
}

function RunBody({ a, laps, pace }: { a: Activity; laps: Lap[]; pace: number }) {
  const lapPaces = laps.map((l) => l.avgPaceSecPerKm ?? (l.distanceM ? (l.durationSec / l.distanceM) * 1000 : 0)).filter((p) => p > 0);
  const fastest = Math.min(...lapPaces);
  const slowest = Math.max(...lapPaces);
  return (
    <>
      <section className="day">
        <span className="num-day">
          {fmtKm(a.distanceM!)}
          <span className="unit">km</span>
        </span>
        <div className="grid-3">
          <div className="metric">
            <span className="metric-v">{fmtPace(pace)}</span>
            <span className="metric-l">passo medio /km</span>
          </div>
          <div className="metric">
            <span className="metric-v">{fmtDuration(a.movingSec ?? a.durationSec)}</span>
            <span className="metric-l">tempo</span>
          </div>
          <div className="metric">
            <span className="metric-v">{a.avgHr ?? 'n.d.'}</span>
            <span className="metric-l">FC media{a.maxHr ? ` · max ${a.maxHr}` : ''}</span>
          </div>
        </div>
      </section>

      {laps.length > 0 && (
        <section className="section" aria-labelledby="h-km">
          <h2 id="h-km">Chilometri</h2>
          <div className="corsia">
            <div className="corsia-track" style={{ height: 18 }} role="img" aria-label="Passo di ogni chilometro: più intenso vuol dire più veloce">
              <div className="corsia-lane">
                <div className="corsia-fill" style={{ width: '100%' }}>
                  {laps.map((l, i) => {
                    const p = l.avgPaceSecPerKm ?? (l.distanceM ? (l.durationSec / l.distanceM) * 1000 : pace);
                    const t = slowest > fastest ? (slowest - p) / (slowest - fastest) : 0.5;
                    return (
                      <span
                        key={i}
                        className="corsia-seg"
                        style={{
                          flex: `${l.distanceM ?? 1000} 1 0`,
                          background: `color-mix(in oklch, var(--accent-strong) ${Math.round(35 + t * 65)}%, var(--bg))`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="corsia-foot">Più intenso il colore, più veloce il chilometro.</div>
          </div>
          <div className="list">
            {laps.map((l, i) => {
              const p = l.avgPaceSecPerKm ?? (l.distanceM ? (l.durationSec / l.distanceM) * 1000 : 0);
              return (
                <div key={i} className="row" style={{ minHeight: 44 }}>
                  <span className="num muted" style={{ width: 28 }}>
                    {i + 1}
                  </span>
                  <div className="row-main">
                    <span className="num">
                      {fmtPace(p)} /km
                      {p === fastest && lapPaces.length > 2 && <span className="tag tag--accent" style={{ marginLeft: 8 }}>il più veloce</span>}
                    </span>
                  </div>
                  <span className="num small muted">{l.distanceM && l.distanceM !== 1000 ? `${fmtKm(l.distanceM)} km · ` : ''}{l.avgHr ? `${l.avgHr} bpm` : ''}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <Extras a={a} />

      {a.track && a.track.length > 1 && (
        <section className="section" aria-labelledby="h-trk">
          <h2 id="h-trk">Percorso</h2>
          <RouteLine track={a.track} />
          <p className="xs muted">I primi e gli ultimi 300 m sono tagliati per non mostrare dove parti.</p>
        </section>
      )}
    </>
  );
}

function OtherBody({ a }: { a: Activity }) {
  const sets = a.exerciseSets ?? [];
  const ton = sets.reduce((s, x) => s + (x.kg ?? 0) * (x.reps ?? 0), 0);
  return (
    <>
      <section className="day">
        <span className="num-day">{fmtDuration(a.durationSec)}</span>
        <div className="grid-3">
          <div className="metric">
            <span className="metric-v">{a.avgHr ?? 'n.d.'}</span>
            <span className="metric-l">FC media</span>
          </div>
          <div className="metric">
            <span className="metric-v">{a.calories ?? 'n.d.'}</span>
            <span className="metric-l">kcal stimate</span>
          </div>
          <div className="metric">
            <span className="metric-v">{ton > 0 ? fmt1(ton / 1000) : 'n.d.'}</span>
            <span className="metric-l">tonnellate</span>
          </div>
        </div>
      </section>
      {sets.length > 0 && (
        <section className="section">
          <h2>Serie registrate dall'orologio</h2>
          <div className="list">
            {sets.map((s, i) => (
              <div key={i} className="row" style={{ minHeight: 44 }}>
                <div className="row-main">
                  <span className="row-title">{s.name}</span>
                </div>
                <span className="num">
                  {s.kg !== undefined ? `${fmt1(s.kg)} kg × ` : ''}
                  {s.reps ?? ''}
                  {s.durationSec && !s.reps ? fmtDuration(s.durationSec) : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="xs muted">L'orologio a volte sbaglia il nome dell'esercizio: per la progressione contano le sedute registrate in Foro.</p>
        </section>
      )}
      <Extras a={a} />
    </>
  );
}

function Extras({ a }: { a: Activity }) {
  const rows: [string, string][] = [];
  if (a.elevGainM) rows.push(['Dislivello positivo', `${fmtInt(a.elevGainM)} m`]);
  if (a.avgCadence) rows.push(['Cadenza media', `${fmtInt(a.avgCadence)} passi/min`]);
  if (a.aerobicTE) rows.push(['Effetto aerobico', fmt1(a.aerobicTE)]);
  if (a.anaerobicTE) rows.push(['Effetto anaerobico', fmt1(a.anaerobicTE)]);
  if (a.trainingLoad) rows.push(['Carico', fmtInt(a.trainingLoad)]);
  if (a.calories && a.kind === 'corsa') rows.push(['Calorie stimate', `${fmtInt(a.calories)} kcal`]);
  if (a.hrZonesSec?.some((s) => s > 0)) rows.push(['Zone (min)', a.hrZonesSec.map((s, i) => `Z${i + 1} ${Math.round(s / 60)}`).join(' · ')]);
  if (rows.length === 0) return null;
  return (
    <section className="section">
      <h2>Dettagli</h2>
      <div className="list">
        {rows.map(([k, v]) => (
          <div key={k} className="row" style={{ minHeight: 44 }}>
            <span className="row-main muted small">{k}</span>
            <span className="num small">{v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
