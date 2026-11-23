import { useMemo } from 'react';
import { Link, useSearch, useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { Barbell, Bicycle, CaretRight, PersonSimpleRun, PersonSimpleWalk, SwimmingPool, Lightning, UserCircle } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { Activity, ActivityKind, GymSession } from '@/db/types';
import { Segmented, Empty } from '@/components/ui';
import { SyncLine } from '@/features/settings/SyncLine';
import { PlanTab } from './PlanTab';
import { addDays, startOfWeek, todayISO, toISODate, parseISODate } from '@/lib/dates';
import { fmtDayShort, fmtDuration, fmtKm, fmtPace, fmt1 } from '@/lib/format';
import { sessionTonnage } from './sessionStats';

export const KIND_ICON: Record<ActivityKind, typeof Barbell> = {
  corsa: PersonSimpleRun,
  forza: Barbell,
  camminata: PersonSimpleWalk,
  bici: Bicycle,
  nuoto: SwimmingPool,
  altro: Lightning,
};

type Item =
  | { type: 'act'; date: string; start: string; act: Activity }
  | { type: 'gym'; date: string; start: string; s: GymSession; act?: Activity };

export function Training() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const tab = new URLSearchParams(search).get('tab') === 'scheda' ? 'scheda' : 'storico';
  return (
    <main className="screen">
      <header className="topbar">
        <div className="topbar-title">
          <h1>Allenamento</h1>
          <SyncLine />
        </div>
        <Link href="/profilo" className="icon-btn" aria-label="Profilo e impostazioni">
          <UserCircle size={28} />
        </Link>
      </header>
      <Segmented
        label="Vista"
        value={tab}
        onChange={(v) => navigate(v === 'scheda' ? '/allenamento?tab=scheda' : '/allenamento', { replace: true })}
        options={[
          { value: 'storico', label: 'Storico' },
          { value: 'scheda', label: 'Scheda' },
        ]}
      />
      {tab === 'storico' ? <History /> : <PlanTab />}
    </main>
  );
}

function History() {
  const today = todayISO();
  const acts = useLiveQuery(() => db.activities.orderBy('start').reverse().limit(300).toArray(), []);
  const sessions = useLiveQuery(() => db.sessions.orderBy('date').reverse().limit(300).toArray(), []);

  const weeks = useMemo(() => {
    if (!acts || !sessions) return null;
    const linked = new Set(sessions.map((s) => s.activityId).filter(Boolean));
    const items: Item[] = [
      ...acts.filter((a) => !linked.has(a.id)).map((a) => ({ type: 'act' as const, date: toISODate(new Date(a.start)), start: a.start, act: a })),
      ...sessions
        .filter((s) => s.endedAt)
        .map((s) => ({ type: 'gym' as const, date: s.date, start: s.startedAt, s, act: acts.find((a) => a.id === s.activityId) })),
    ].sort((a, b) => b.start.localeCompare(a.start));
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      const w = startOfWeek(it.date);
      if (!groups.has(w)) groups.set(w, []);
      groups.get(w)!.push(it);
    }
    return [...groups.entries()];
  }, [acts, sessions]);

  if (!weeks) return null;
  if (weeks.length === 0)
    return (
      <Empty
        action={
          <div className="cluster">
            <Link href="/allenamento?tab=scheda" className="btn btn--primary">
              Apri la scheda
            </Link>
            <Link href="/profilo#fit" className="btn">
              Importa un file FIT
            </Link>
          </div>
        }
      >
        Ancora niente qui. Importa un file FIT o inizia la scheda.
      </Empty>
    );

  const thisWeek = startOfWeek(today);
  return (
    <div className="stack" style={{ gap: 'var(--s-8)' }}>
      {weeks.map(([w, items]) => (
        <section key={w} className="section">
          <div className="section-head">
            <h2>{w === thisWeek ? 'Questa settimana' : w === addDays(thisWeek, -7) ? 'Settimana scorsa' : `Settimana del ${fmtDayShort(parseISODate(w))}`}</h2>
            <span className="small muted num">{weekSummary(items)}</span>
          </div>
          <div className="list">
            {items.map((it) => (it.type === 'act' ? <ActRow key={it.act.id} a={it.act} /> : <GymRow key={`s${it.s.id}`} s={it.s} act={it.act} />))}
          </div>
        </section>
      ))}
    </div>
  );
}

function weekSummary(items: Item[]): string {
  let km = 0;
  let gym = 0;
  for (const it of items) {
    if (it.type === 'act' && it.act.kind === 'corsa') km += (it.act.distanceM ?? 0) / 1000;
    if (it.type === 'gym' || (it.type === 'act' && it.act.kind === 'forza')) gym++;
  }
  const parts = [];
  if (km > 0) parts.push(`${fmt1(km)} km`);
  if (gym > 0) parts.push(`${gym} ${gym === 1 ? 'seduta' : 'sedute'}`);
  return parts.join(' · ');
}

function ActRow({ a }: { a: Activity }) {
  const Icon = KIND_ICON[a.kind];
  const d = new Date(a.start);
  const key =
    a.kind === 'corsa' && a.distanceM
      ? `${fmtKm(a.distanceM)} km · ${fmtPace(a.avgPaceSecPerKm ?? (a.durationSec / a.distanceM) * 1000)} /km`
      : a.exerciseSets?.length
        ? `${a.exerciseSets.length} serie`
        : a.calories
          ? `${a.calories} kcal`
          : '';
  return (
    <Link href={`/allenamento/attivita/${encodeURIComponent(a.id)}`} className="row">
      <Icon size={22} className="row-icon" />
      <div className="row-main">
        <span className="row-title">{a.name}</span>
        <span className="row-sub">
          {fmtDayShort(d)} · {fmtDuration(a.durationSec)}
          {a.source === 'fit' && ' · da file FIT'}
        </span>
      </div>
      <span className="row-end num small">{key}</span>
      <CaretRight size={16} className="row-icon" />
    </Link>
  );
}

function GymRow({ s, act }: { s: GymSession; act?: Activity }) {
  const name = useLiveQuery(() => (s.templateId ? db.templates.get(s.templateId) : undefined), [s.templateId]);
  const dur = s.endedAt ? (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000 : 0;
  const ton = sessionTonnage(s);
  return (
    <Link href={`/allenamento/seduta/${s.id}`} className="row">
      <Barbell size={22} className="row-icon" />
      <div className="row-main">
        <span className="row-title">{name?.name ?? 'Seduta libera'}</span>
        <span className="row-sub">
          {fmtDayShort(parseISODate(s.date))} · {fmtDuration(dur)}
          {act?.avgHr && ` · FC media ${act.avgHr}`}
        </span>
      </div>
      <span className="row-end num small">{ton > 0 ? `${fmt1(ton / 1000)} t` : ''}</span>
      <CaretRight size={16} className="row-icon" />
    </Link>
  );
}
