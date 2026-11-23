import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, ArrowsClockwise, Check } from '@phosphor-icons/react';
import type { LoggedItem, MealSlot } from '@/db/types';
import { useProfile } from '@/app/hooks';
import { slotLabel, useFoodIndex, useTargets, useTodayPlan } from '@/app/engine';
import { useToast } from '@/components/ui';
import { buildDayMenu, type MenuMeal } from '@/lib/nutrition/mealPlan';
import { SEASON_SOURCE } from '@/lib/nutrition';
import { saveEntry } from './parts';
import { parseISODate, todayISO } from '@/lib/dates';
import { fmt1, fmtDayLong, fmtInt } from '@/lib/format';

/** Menu del giorno: un pasto per quota, costruito sui numeri di oggi, con frutta e verdura di stagione nel Lazio. */
export function MenuDay() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const date = new URLSearchParams(useSearch()).get('d') ?? todayISO();
  const profile = useProfile();
  const plan = useTodayPlan(date);
  const t = useTargets(date, plan);
  const index = useFoodIndex();
  const [avoid, setAvoid] = useState<Partial<Record<MealSlot, string[]>>>({});
  const [logged, setLogged] = useState<Set<MealSlot>>(new Set());

  const menu = useMemo(() => {
    if (!profile || !t || !index) return null;
    return buildDayMenu({
      date,
      target: { kcal: t.day.kcal, protein: t.day.protein, carbs: t.day.carbs, fat: t.day.fat },
      mealsPerDay: profile.mealsPerDay,
      diet: profile.diet,
      allergies: profile.allergies,
      excluded: profile.excludedFoods,
      get: (id) => index.get(id),
      avoid,
    });
  }, [profile, t, index, date, avoid]);

  const back = () => navigate(date === todayISO() ? '/dieta' : `/dieta?d=${date}`);

  const other = (m: MenuMeal) => setAvoid((a) => ({ ...a, [m.slot]: [...(a[m.slot] ?? []), m.templateId] }));

  const log = async (m: MenuMeal) => {
    const items: LoggedItem[] = m.items.map((i) => ({
      foodId: i.foodId,
      name: i.name,
      grams: i.grams,
      nutrients: i.nutrients,
      source: index?.get(i.foodId)?.source ?? 'ciqual',
      confidence: 'alta',
    }));
    await saveEntry(date, m.slot, items, 'manuale');
    setLogged((s) => new Set(s).add(m.slot));
    toast(`${slotLabel(m.slot)} registrata: ${fmtInt(m.totals.kcal)} kcal. Se hai cambiato i grammi, correggili nel diario.`);
  };

  return (
    <main className="screen screen--bare">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={back} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>Menu del giorno</h1>
          <span className="small muted">{date === todayISO() ? 'Oggi' : fmtDayLong(parseISODate(date))}</span>
        </div>
      </header>

      {profile === undefined || t === null ? (
        <div className="panel">
          <p>Il menu si costruisce sui tuoi obiettivi: prima servono i tuoi dati.</p>
          <Link href="/benvenuto" className="btn btn--primary">
            Inserisci i tuoi dati
          </Link>
        </div>
      ) : !menu ? (
        <p className="status-line" role="status">
          Preparo il menu…
        </p>
      ) : (
        <>
          <p className="muted">
            {t!.day.label}: {fmtInt(t!.day.kcal)} kcal e {fmtInt(t!.day.protein)} g di proteine, divisi in {menu.meals.length} pasti. Frutta e verdura di stagione nel
            Lazio. I grammi sono a crudo, salvo dove è scritto cotto o lessato.
          </p>

          {menu.meals.map((m) => (
            <section key={m.slot} className="section" aria-labelledby={`h-${m.slot}`}>
              <div className="section-head">
                <h2 id={`h-${m.slot}`}>{slotLabel(m.slot)}</h2>
                <span className="num small muted">
                  {fmtInt(m.totals.kcal)} kcal · {fmt1(m.totals.protein)} g prot.
                </span>
              </div>
              <div className="panel">
                <h3>{m.name}</h3>
                <ul className="menu-items">
                  {m.items.map((i) => (
                    <li key={i.foodId}>
                      <span>{i.name}</span>
                      <span className="num">{fmtInt(i.grams)} g</span>
                    </li>
                  ))}
                </ul>
                <div className="btn-row">
                  <button type="button" className="btn" onClick={() => other(m)} disabled={m.options < 2}>
                    <ArrowsClockwise size={18} /> Altra proposta
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => log(m)} disabled={logged.has(m.slot)}>
                    <Check size={18} /> {logged.has(m.slot) ? 'Registrato' : 'Mangiato'}
                  </button>
                </div>
              </div>
            </section>
          ))}

          {menu.missing.length > 0 && (
            <p className="note note--warn">
              Per {menu.missing.map((s) => slotLabel(s).toLowerCase()).join(' e ')} non ho proposte compatibili con le tue esclusioni: lì decidi tu, il diario conta lo stesso.
            </p>
          )}

          <div className="panel">
            <div className="split">
              <span className="corsia-label">Totale del menu</span>
              <span className="num">
                <strong>{fmtInt(menu.totals.kcal)} kcal</strong>
              </span>
            </div>
            <div className="grid-3 num small">
              <span>{fmt1(menu.totals.protein)} g prot.</span>
              <span>{fmt1(menu.totals.carbs)} g carb.</span>
              <span>{fmt1(menu.totals.fat)} g grassi</span>
            </div>
            <p className="xs muted">
              Obiettivo: {fmtInt(t!.day.kcal)} kcal, {fmtInt(t!.day.protein)} g proteine, {fmtInt(t!.day.carbs)} g carboidrati, {fmtInt(t!.day.fat)} g grassi.
            </p>
          </div>
          <p className="xs muted">Valori dal database di Foro (CIQUAL, USDA) sui grammi proposti. Stagionalità: {SEASON_SOURCE}.</p>
        </>
      )}
    </main>
  );
}
