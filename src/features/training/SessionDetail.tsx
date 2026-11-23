import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Trash } from '@phosphor-icons/react';
import { db } from '@/db/db';
import { StepChart } from '@/components/charts/Charts';
import { useToast } from '@/components/ui';
import { detectSessionRecords, e1rmSeries } from '@/lib/training/records';
import { getExercise } from '@/lib/training/library';
import { groupSets, sessionTonnage } from './sessionStats';
import { parseISODate } from '@/lib/dates';
import { fmtDayLong, fmtDuration, fmtKg, fmt1, fmtTime } from '@/lib/format';

export function SessionDetail({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const toast = useToast();
  const s = useLiveQuery(() => db.sessions.get(id), [id], null);
  const all = useLiveQuery(() => db.sessions.toArray(), []);
  const tpl = useLiveQuery(() => (s?.templateId ? db.templates.get(s.templateId) : undefined), [s?.templateId]);
  const act = useLiveQuery(() => (s?.activityId ? db.activities.get(s.activityId) : undefined), [s?.activityId]);
  const [chartEx, setChartEx] = useState<string | null>(null);

  const groups = useMemo(() => (s ? groupSets(s.sets.filter((x) => x.done)) : []), [s]);
  const prKeys = useMemo(() => {
    if (!s || !all) return new Set<string>();
    const before = all.filter((h) => h.id !== s.id && h.endedAt && h.startedAt < s.startedAt);
    const hits = detectSessionRecords(s.sets, before);
    return new Set(hits.map((h) => `${h.exerciseId}|${h.kg}|${h.reps}`));
  }, [s, all]);

  if (s === null || !all) return <main className="screen" />;
  if (!s) return <main className="screen"><p>Seduta non trovata.</p></main>;

  const dur = s.endedAt ? (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000 : 0;
  const ton = sessionTonnage(s);
  const maxCols = Math.max(1, ...groups.map((g) => g.sets.length));
  const selEx = chartEx ?? groups[0]?.exerciseId;
  const series = selEx ? e1rmSeries(all, selEx).slice(-12) : [];

  return (
    <main className="screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => history.back()} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>{tpl?.name ?? 'Seduta libera'}</h1>
          <span className="small muted">
            {fmtDayLong(parseISODate(s.date))}, {fmtTime(new Date(s.startedAt))}
          </span>
        </div>
      </header>

      <section className="day">
        <span className="num-day">
          {fmt1(ton / 1000)}
          <span className="unit">t</span>
        </span>
        <p className="muted num">
          {fmtDuration(dur)} · {s.sets.filter((x) => x.done && x.type !== 'riscaldamento').length} serie
          {act?.avgHr ? ` · FC media ${act.avgHr}` : ''}
          {act?.calories ? ` · ${act.calories} kcal stimate` : ''}
        </p>
      </section>

      {groups.length > 0 && (
        <section className="section" aria-labelledby="h-serie">
          <h2 id="h-serie">Serie</h2>
          <div className="set-grid" style={{ ['--cols' as string]: maxCols }}>
            <div className="set-grid-row">
              <span className="set-grid-cell set-grid-cell--head">Esercizio</span>
              {Array.from({ length: maxCols }, (_, i) => (
                <span key={i} className="set-grid-cell set-grid-cell--head num">
                  {i + 1}
                </span>
              ))}
            </div>
            {groups.map((g) => {
              const ex = getExercise(g.exerciseId);
              return (
                <div key={g.exerciseId} className="set-grid-row">
                  <button type="button" className="set-grid-cell" style={{ border: 0, textAlign: 'left', fontWeight: selEx === g.exerciseId ? 700 : 500 }} onClick={() => setChartEx(g.exerciseId)}>
                    {ex?.name ?? g.exerciseId}
                  </button>
                  {Array.from({ length: maxCols }, (_, i) => {
                    const x = g.sets[i];
                    const pr = x && prKeys.has(`${x.exerciseId}|${x.kg}|${x.reps}`);
                    return (
                      <span key={i} className={`set-grid-cell num${pr ? ' set-grid-cell--pr' : ''}`} title={x?.rpe ? `RPE ${x.rpe}` : undefined}>
                        {x ? (ex?.timed ? `${x.reps}s` : `${fmtKg(x.kg)}×${x.reps}`) : ''}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {prKeys.size > 0 && <p className="xs muted">Le celle colorate sono record.</p>}
        </section>
      )}

      {series.length > 1 && (
        <section className="section">
          <h2>1RM stimato · {getExercise(selEx!)?.name}</h2>
          <StepChart data={series.map((p) => ({ date: p.date, value: p.best ?? p.e1rm, pr: p.isRecord }))} />
          <p className="xs muted">Stima di Epley sulla serie migliore di ogni seduta; oltre 12 ripetizioni non è affidabile.</p>
        </section>
      )}

      {s.note && <p className="note">{s.note}</p>}

      <button
        type="button"
        className="btn btn--ghost btn--danger"
        onClick={async () => {
          if (!confirm('Eliminare questa seduta? Record e progressione si ricalcolano senza.')) return;
          await db.sessions.delete(s.id!);
          toast('Seduta eliminata.');
          navigate('/allenamento');
        }}
      >
        <Trash size={18} /> Elimina la seduta
      </button>
    </main>
  );
}
