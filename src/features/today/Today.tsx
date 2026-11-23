import { Link, useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { Barbell, PersonSimpleRun, UserCircle, CaretRight } from '@phosphor-icons/react';
import { db } from '@/db/db';
import { useProfile } from '@/app/hooks';
import { slotLabel, entryTotals, useDayLog, useTargets, useTodayPlan, useWeekHistory } from '@/app/engine';
import { Corsia } from '@/components/Corsia';
import { SyncLine } from '@/features/settings/SyncLine';
import { ReadinessLine } from '@/features/health/ReadinessLine';
import { CheckInCard } from '@/features/diet/CheckIn';
import { estimateMinutes, templateSummary } from '@/features/training/PlanTab';
import { todayISO, parseISODate } from '@/lib/dates';
import { fmt1, fmtDayLong, fmtInt, fmtSleep } from '@/lib/format';

export function Today() {
  const today = todayISO();
  const [, navigate] = useLocation();
  const profile = useProfile();
  const plan = useTodayPlan(today);
  const t = useTargets(today, plan);
  const log = useDayLog(today);
  const hist = useWeekHistory(today);
  const sleep = useLiveQuery(() => db.wellness.get(today), [today]);
  const open = useLiveQuery(() => db.sessions.filter((s) => !s.endedAt).first(), []);
  const demo = useLiveQuery(() => db.settings.get('demo.loaded'), []);

  const tot = log?.totals;
  const segs = (key: 'kcal' | 'protein' | 'carbs' | 'fat') =>
    (log?.entries ?? []).map((e) => ({ id: String(e.id), value: entryTotals(e)[key], label: slotLabel(e.slot) }));

  const item = plan?.items.find((i) => i.status !== 'fatta') ?? plan?.items[0];
  const dayTitle = plan === null ? 'Nessuna scheda' : !plan ? '' : plan.riposo ? 'Riposo' : item ? item.template.name : 'Fatto';

  return (
    <main className="screen">
      <header className="topbar">
        <div className="topbar-title">
          <span className="small muted">{fmtDayLong(parseISODate(today))}</span>
          <SyncLine />
        </div>
        <Link href="/profilo" className="icon-btn" aria-label="Profilo e impostazioni">
          <UserCircle size={28} />
        </Link>
      </header>

      {demo && (
        <Link href="/profilo" className="demo-flag" style={{ textDecoration: 'none' }}>
          Stai guardando dati di prova. Si cancellano da Profilo.
        </Link>
      )}

      <section className="day" aria-labelledby="h-oggi">
        <h1 id="h-oggi" className="day-title">
          {dayTitle}
        </h1>
        {plan && !plan.riposo && (
          <p className="muted">
            {item && item.kind === 'forza' && plan.motivo === `Oggi: ${item.template.name}.`
              ? `${templateSummary(item.template)} · circa ${estimateMinutes(item.template)} minuti`
              : plan.motivo}
          </p>
        )}
        {plan?.riposo && <p className="muted">{plan.motivo}</p>}
        <ReadinessLine compact />
        {open ? (
          <button type="button" className="btn btn--primary btn--lg" onClick={() => navigate('/palestra')}>
            <Barbell size={22} /> Riprendi la seduta
          </button>
        ) : plan === null ? (
          <Link href="/allenamento?tab=scheda" className="btn btn--lg">
            Scegli una scheda di partenza
          </Link>
        ) : item && item.status !== 'fatta' ? (
          item.kind === 'forza' ? (
            <button type="button" className="btn btn--primary btn--lg" onClick={() => navigate(`/palestra?t=${encodeURIComponent(item.template.id)}`)}>
              <Barbell size={22} /> Inizia {item.template.name}
            </button>
          ) : (
            <div className="panel">
              <div className="cluster">
                <PersonSimpleRun size={22} />
                <strong>{item.template.name}</strong>
              </div>
              {item.template.run && <p className="small muted">{runLine(item.template.run)}</p>}
              <p className="xs muted">La registra il Venu 4: comparirà nello storico dopo la sync.</p>
            </div>
          )
        ) : null}
        {plan?.avvisi.map((a) => (
          <p key={a} className="note note--warn">
            {a}
          </p>
        ))}
      </section>

      <section className="section" aria-labelledby="h-cibo">
        <div className="section-head">
          <h2 id="h-cibo">Da mangiare oggi</h2>
          {t && <span className="small muted">{t.day.label}</span>}
        </div>
        {profile === undefined || t === null ? (
          <div className="panel">
            <p className="small">Senza i tuoi dati non calcolo gli obiettivi. Il diario funziona lo stesso.</p>
            <Link href="/benvenuto" className="btn btn--primary">
              Inserisci i tuoi dati
            </Link>
          </div>
        ) : null}
        <Corsia label="Calorie" value={tot?.kcal ?? 0} target={t?.day.kcal} unit="kcal" segments={segs('kcal')} history={hist?.map((h) => h.kcal)} />
        <Corsia label="Proteine" value={tot?.protein ?? 0} target={t?.day.protein} unit="g" segments={segs('protein')} history={hist?.map((h) => h.protein)} />
        <Corsia label="Carboidrati" value={tot?.carbs ?? 0} target={t?.day.carbs} unit="g" segments={segs('carbs')} history={hist?.map((h) => h.carbs)} compact />
        <Corsia label="Grassi" value={tot?.fat ?? 0} target={t?.day.fat} unit="g" segments={segs('fat')} history={hist?.map((h) => h.fat)} compact />
        {t && tot && (
          <p className="small">
            {remainingLine(t.day.kcal - tot.kcal, t.day.protein - tot.protein)}
          </p>
        )}
        {log && log.entries.length > 0 && (
          <div className="list">
            {log.entries.map((e) => {
              const n = entryTotals(e);
              return (
                <Link key={e.id} href="/dieta" className="row">
                  <div className="row-main">
                    <span className="row-title">{slotLabel(e.slot)}</span>
                    <span className="row-sub">{e.items.map((i) => i.name).join(', ')}</span>
                  </div>
                  <span className="row-end num small">
                    {fmtInt(n.kcal)} kcal
                    <span className="muted">{fmt1(n.protein)} g prot.</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        {log && log.entries.length === 0 && <p className="small muted">Nessun pasto oggi. Fotografa il primo dal +.</p>}
      </section>

      <CheckInCard />

      <section className="section" aria-labelledby="h-notte">
        <div className="section-head">
          <h2 id="h-notte">Stanotte</h2>
          <Link href="/salute" className="btn btn--ghost">
            Salute <CaretRight size={16} />
          </Link>
        </div>
        {sleep?.sleepSec ? (
          <div className="grid-3">
            <div className="metric">
              <span className="metric-v">{fmtSleep(sleep.sleepSec)}</span>
              <span className="metric-l">sonno{sleep.sleepScore !== undefined ? ` · punteggio ${sleep.sleepScore}` : ''}</span>
            </div>
            <div className="metric">
              <span className="metric-v">{sleep.hrvNightAvg ?? 'n.d.'}</span>
              <span className="metric-l">HRV ms</span>
            </div>
            <div className="metric">
              <span className="metric-v">{sleep.restingHr ?? 'n.d.'}</span>
              <span className="metric-l">FC a riposo</span>
            </div>
          </div>
        ) : (
          <p className="small muted">Nessun dato del sonno per stanotte.{` `}Arriva con la sync Garmin.</p>
        )}
        {t?.trendKg !== undefined && (
          <Link href="/salute/peso" className="split small" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="muted">Peso, tendenza</span>
            <span className="num">{fmt1(t.trendKg)} kg</span>
          </Link>
        )}
      </section>
    </main>
  );
}

function remainingLine(kcal: number, prot: number): string {
  const k = Math.round(kcal);
  const p = Math.round(prot);
  if (k <= 0 && p <= 0) return 'Obiettivi di oggi raggiunti.';
  const parts: string[] = [];
  parts.push(k > 0 ? `Ti mancano ${fmtInt(k)} kcal` : `Sei sopra di ${fmtInt(-k)} kcal`);
  if (p > 0) parts.push(`${fmtInt(p)} g di proteine`);
  return parts.join(' e ') + '.';
}

function runLine(r: NonNullable<import('@/db/types').WorkoutTemplate['run']>): string {
  const bits: string[] = [];
  if (r.targetMinutes) bits.push(`${r.targetMinutes} minuti`);
  if (r.targetKm) bits.push(`${fmt1(r.targetKm)} km`);
  if (r.zone) bits.push(`zona ${r.zone}`);
  if (r.note) bits.push(r.note);
  return bits.join(' · ');
}
