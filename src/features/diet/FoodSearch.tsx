import { useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { FoodItem, MealSlot } from '@/db/types';
import { slotForTime, useFoodIndex } from '@/app/engine';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/ui';
import { FoodResults, ItemEditor, SlotPicker, saveEntry } from './parts';
import { addDays, todayISO } from '@/lib/dates';

const ROMANI = ['carbonara', 'cacio e pepe', 'amatriciana', 'gricia', 'supplì', 'pizza bianca', 'trapizzino', 'carciofi alla romana', 'puntarelle', 'saltimbocca', 'pasta e ceci', 'maritozzo'];

export function FoodSearch() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const date = new URLSearchParams(useSearch()).get('d') ?? todayISO();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<FoodItem | null>(null);
  const [slot, setSlot] = useState<MealSlot>(slotForTime());
  const [added, setAdded] = useState(0);
  const index = useFoodIndex();
  const recentRows = useLiveQuery(() => db.foodLog.where('date').between(addDays(todayISO(), -30), todayISO(), true, true).reverse().toArray(), []);
  const recent = useMemo(() => {
    if (!recentRows || !index) return [];
    const seen = new Set<string>();
    const out: FoodItem[] = [];
    for (const e of recentRows)
      for (const i of e.items) {
        if (!i.foodId || seen.has(i.foodId)) continue;
        const f = index.get(i.foodId);
        if (f) {
          seen.add(i.foodId);
          out.push(f);
        }
      }
    return out.slice(0, 10);
  }, [recentRows, index]);

  const back = () => navigate(date === todayISO() ? '/dieta' : `/dieta?d=${date}`);

  return (
    <main className="screen screen--bare">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={back} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>Cerca alimento</h1>
        </div>
        {added > 0 && (
          <button type="button" className="btn btn--primary" onClick={back}>
            Fatto ({added})
          </button>
        )}
      </header>

      <label className="field">
        <span className="visually-hidden">Cerca</span>
        <input className="input" autoFocus placeholder="es. petto di pollo, mozzarella, supplì" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
      </label>

      {q.trim().length < 2 ? (
        <>
          {recent.length > 0 && (
            <section className="section">
              <h2>Recenti</h2>
              <div className="list">
                {recent.map((f) => (
                  <button key={f.id} type="button" className="row" onClick={() => setPick(f)}>
                    <span className="row-main">
                      <span className="row-title">{f.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="section">
            <h2>Piatti romani</h2>
            <div className="chips">
              {ROMANI.map((r) => (
                <button key={r} type="button" className="chip" onClick={() => setQ(r)}>
                  {r}
                </button>
              ))}
            </div>
            <p className="xs muted">Calcolati da ricetta con porzioni da trattoria: puoi correggere i grammi.</p>
          </section>
        </>
      ) : (
        <FoodResults query={q} onPick={setPick} />
      )}

      <Sheet open={pick !== null} onClose={() => setPick(null)} title="Quanto ne hai mangiato?">
        {pick && (
          <div className="stack">
            <SlotPicker value={slot} onChange={setSlot} />
            <ItemEditor
              food={pick}
              onDone={async (item) => {
                await saveEntry(date, slot, [item], 'manuale');
                setAdded((n) => n + 1);
                setPick(null);
                toast(`${item.name}: aggiunto.`);
              }}
            />
          </div>
        )}
      </Sheet>
    </main>
  );
}
