import { useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { Barcode, Camera, CaretLeft, CaretRight, CookingPot, ForkKnife, MagnifyingGlass, TextAa, UserCircle } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { FoodLogEntry, MealSlot } from '@/db/types';
import { SLOTS, entryTotals, slotForTime, slotLabel, useDayLog, useTargets, useTodayPlan, useWeekHistory } from '@/app/engine';
import { Corsia } from '@/components/Corsia';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/ui';
import { CheckInCard } from './CheckIn';
import { EntryEditor, cleanItem } from './parts';
import { seasonalProduce, monthOf, SEASON_SOURCE } from '@/lib/nutrition';
import { addDays, parseISODate, todayISO, nowTimeHHMM } from '@/lib/dates';
import { fmt1, fmtDayLong, fmtInt, fmtRelativeDay } from '@/lib/format';

export function Diet() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const today = todayISO();
  const date = new URLSearchParams(search).get('d') ?? today;
  const plan = useTodayPlan(date);
  const t = useTargets(date, plan);
  const log = useDayLog(date);
  const hist = useWeekHistory(date);
  const [hi, setHi] = useState<string | null>(null);
  const [edit, setEdit] = useState<FoodLogEntry | null>(null);
  const [why, setWhy] = useState(false);

  useEffect(() => setHi(null), [date]);

  const go = (d: string) => navigate(d === today ? '/dieta' : `/dieta?d=${d}`, { replace: true });
  const segs = (k: 'kcal' | 'protein' | 'carbs' | 'fat') => (log?.entries ?? []).map((e) => ({ id: String(e.id), value: entryTotals(e)[k], label: slotLabel(e.slot) }));
  const tot = log?.totals;

  return (
    <main className="screen">
      <header className="topbar">
        <div className="topbar-title">
          <h1>Dieta</h1>
          <div className="cluster" style={{ gap: 0 }}>
            <button type="button" className="icon-btn" aria-label="Giorno prima" onClick={() => go(addDays(date, -1))}>
              <CaretLeft size={18} />
            </button>
            <span className="small" style={{ minWidth: 0 }}>
              {date === today ? 'Oggi' : fmtRelativeDay(date, today) === 'ieri' ? 'Ieri' : fmtDayLong(parseISODate(date))}
            </span>
            <button type="button" className="icon-btn" aria-label="Giorno dopo" disabled={date >= today} onClick={() => go(addDays(date, 1))}>
              <CaretRight size={18} />
            </button>
          </div>
        </div>
        <Link href="/profilo" className="icon-btn" aria-label="Profilo e impostazioni">
          <UserCircle size={28} />
        </Link>
      </header>

      <section className="section" aria-label="Totali del giorno">
        <Corsia label="Calorie" value={tot?.kcal ?? 0} target={t?.day.kcal} unit="kcal" segments={segs('kcal')} history={hist?.map((h) => h.kcal)} highlight={hi} onSegment={setHi} />
        <Corsia label="Proteine" value={tot?.protein ?? 0} target={t?.day.protein} unit="g" segments={segs('protein')} history={hist?.map((h) => h.protein)} highlight={hi} onSegment={setHi} />
        <Corsia label="Carboidrati" value={tot?.carbs ?? 0} target={t?.day.carbs} unit="g" segments={segs('carbs')} history={hist?.map((h) => h.carbs)} highlight={hi} onSegment={setHi} compact />
        <Corsia label="Grassi" value={tot?.fat ?? 0} target={t?.day.fat} unit="g" segments={segs('fat')} history={hist?.map((h) => h.fat)} highlight={hi} onSegment={setHi} compact />
        {t ? (
          <button type="button" className="btn btn--ghost small" style={{ alignSelf: 'flex-start', padding: '0 8px', minHeight: 36 }} onClick={() => setWhy(true)}>
            {t.day.label}: {fmtInt(t.day.kcal)} kcal. Come li calcolo
          </button>
        ) : (
          t === null && (
            <Link href="/benvenuto" className="small">
              Inserisci i tuoi dati per avere gli obiettivi
            </Link>
          )
        )}
      </section>

      <div className="btn-row">
        <Link href={`/dieta/foto${date !== today ? `?d=${date}` : ''}`} className="btn btn--primary" style={{ flex: 2 }}>
          <Camera size={20} /> Fotografa
        </Link>
        <Link href={`/dieta/cerca${date !== today ? `?d=${date}` : ''}`} className="btn" aria-label="Cerca alimento">
          <MagnifyingGlass size={20} />
        </Link>
        <Link href={`/dieta/codice${date !== today ? `?d=${date}` : ''}`} className="btn" aria-label="Codice a barre">
          <Barcode size={20} />
        </Link>
        <Link href={`/dieta/testo${date !== today ? `?d=${date}` : ''}`} className="btn" aria-label="Scrivi il pasto">
          <TextAa size={20} />
        </Link>
      </div>

      <Link href={`/dieta/menu${date !== today ? `?d=${date}` : ''}`} className="row" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
        <CookingPot size={22} className="row-icon" />
        <div className="row-main">
          <span className="row-title">Menu del giorno</span>
          <span className="row-sub">Idee alla romana che rientrano nei tuoi numeri</span>
        </div>
        <CaretRight size={18} />
      </Link>

      {log && log.entries.length === 0 && (
        <div className="empty">
          <p>{date === today ? 'Nessun pasto oggi. Fotografa il primo.' : 'Nessun pasto registrato in questo giorno.'}</p>
        </div>
      )}

      {SLOTS.filter((s) => log?.bySlot.has(s.slot)).map((s) => {
        const entries = log!.bySlot.get(s.slot)!;
        const sum = entries.reduce((a, e) => a + entryTotals(e).kcal, 0);
        return (
          <section key={s.slot} className="section">
            <div className="section-head">
              <h2>{s.label}</h2>
              <span className="num small muted">{fmtInt(sum)} kcal</span>
            </div>
            <div className="list">
              {entries.map((e) => (
                <EntryRow key={e.id} e={e} dim={hi !== null && hi !== String(e.id)} onOpen={() => setEdit(e)} />
              ))}
            </div>
          </section>
        );
      })}

      <SavedMeals date={date} />
      <CheckInCard showInsufficient />
      <Season date={date} />

      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit ? slotLabel(edit.slot) : ''}>
        {edit && <EntryEditor entry={edit} onClose={() => setEdit(null)} />}
      </Sheet>

      <Sheet open={why} onClose={() => setWhy(false)} title="Come calcolo gli obiettivi">
        {t && (
          <div className="stack small">
            {[t.targets.bmr, t.targets.activityFactor, t.targets.exercise, t.targets.tdee, t.targets.adjustmentPct, t.targets.referenceWeightKg].map((x, i) => (
              <p key={i}>{x.why}</p>
            ))}
            {t.dayType && (
              <>
                <p>{t.targets.days[t.dayType].protein.why}</p>
                <p>{t.targets.days[t.dayType].fat.why}</p>
                <p>{t.targets.days[t.dayType].carbs.why}</p>
              </>
            )}
            {t.targets.monthlyGainKg && <p>{t.targets.monthlyGainKg.why}</p>}
            {t.targets.notes.map((n) => (
              <p key={n} className="muted">
                {n}
              </p>
            ))}
            <p className="muted">Le formule sono un punto di partenza: dalla terza settimana comanda il tuo peso reale, con la revisione del lunedì.</p>
          </div>
        )}
      </Sheet>
    </main>
  );
}

function EntryRow({ e, dim, onOpen }: { e: FoodLogEntry; dim: boolean; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!e.photoThumb) return;
    const u = URL.createObjectURL(e.photoThumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [e.photoThumb]);
  const n = entryTotals(e);
  const est = e.items.some((i) => i.confidence === 'bassa' || i.source === 'ai');
  return (
    <button type="button" className="row" onClick={onOpen} style={{ opacity: dim ? 0.45 : 1 }}>
      {url ? <img className="thumb" src={url} alt="" /> : <span className="thumb" style={{ display: 'grid', placeItems: 'center' }}><ForkKnife size={22} className="row-icon" /></span>}
      <div className="row-main">
        <span className="row-title">{e.items.map((i) => i.name).join(', ')}</span>
        <span className="row-sub">
          {e.time} · {e.items.reduce((a, i) => a + i.grams, 0)} g{est ? ' · stima' : e.method === 'foto' ? ' · da foto, grammi confermati' : ''}
        </span>
      </div>
      <span className="row-end num small">
        {fmtInt(n.kcal)} kcal
        <span className="muted">{fmt1(n.protein)} g prot.</span>
      </span>
    </button>
  );
}

function SavedMeals({ date }: { date: string }) {
  const toast = useToast();
  const meals = useLiveQuery(() => db.savedMeals.orderBy('uses').reverse().limit(6).toArray(), []);
  if (!meals || meals.length === 0) return null;
  const add = async (id: number) => {
    const m = meals.find((x) => x.id === id)!;
    const slot: MealSlot = slotForTime();
    await db.foodLog.add({ date, time: nowTimeHHMM(), slot, items: m.items.map(cleanItem), method: 'ripeti', createdAt: new Date().toISOString() });
    await db.savedMeals.update(id, { uses: m.uses + 1, lastUsed: new Date().toISOString() });
    toast(`${m.name}: aggiunto a ${slotLabel(slot).toLowerCase()}.`);
  };
  return (
    <section className="section" aria-labelledby="h-saved">
      <h2 id="h-saved">Pasti salvati</h2>
      <div className="chips">
        {meals.map((m) => (
          <button key={m.id} type="button" className="chip" onClick={() => add(m.id!)}>
            {m.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function Season({ date }: { date: string }) {
  const m = monthOf(date);
  const s = seasonalProduce(m);
  const month = parseISODate(date).toLocaleDateString('it-IT', { month: 'long' });
  if (!s) return null;
  return (
    <section className="section" aria-labelledby="h-season">
      <h2 id="h-season">Di stagione nel Lazio a {month}</h2>
      <p className="small">
        <strong>Verdura:</strong> {s.verdura.map((x) => x.nome).join(', ')}.
      </p>
      <p className="small">
        <strong>Frutta:</strong> {s.frutta.map((x) => x.nome).join(', ')}.
      </p>
      <p className="xs muted">Indicativo, fonte: {SEASON_SOURCE}.</p>
    </section>
  );
}
