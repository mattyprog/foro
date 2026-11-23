import { useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Trash, X } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { FoodItem, FoodLogEntry, LogMethod, LoggedItem, MealSlot } from '@/db/types';
import { SLOTS, getFoodIndex, slotLabel, useFoodIndex } from '@/app/engine';
import { Stepper } from '@/components/Stepper';
import { Sheet } from '@/components/Sheet';
import { draftTotals, rescaleDraft, replaceDraftFood, roundNutrients, scaleNutrients, type DraftItem, type ClarifyingQuestion } from '@/lib/nutrition';
import { SOURCE_LABEL } from '@/lib/nutrition/drafts';
import { nowTimeHHMM } from '@/lib/dates';
import { answerItems } from './draftAnswer';
import { fmt1, fmtInt } from '@/lib/format';

export function SlotPicker({ value, onChange }: { value: MealSlot; onChange: (s: MealSlot) => void }) {
  return (
    <div className="seg" role="group" aria-label="Pasto">
      {SLOTS.map((s) => (
        <button key={s.slot} type="button" aria-pressed={s.slot === value} onClick={() => onChange(s.slot)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

export async function saveEntry(date: string, slot: MealSlot, items: LoggedItem[], method: LogMethod, photoThumb?: Blob): Promise<number> {
  const now = new Date();
  const entry: FoodLogEntry = {
    date,
    time: nowTimeHHMM(now),
    slot,
    items: items.map(cleanItem),
    method,
    photoThumb,
    createdAt: now.toISOString(),
  };
  return (await db.foodLog.add(entry)) as number;
}

/** Da una bozza a una voce del diario: solo i campi del contratto. */
export function cleanItem(i: LoggedItem): LoggedItem {
  return {
    foodId: i.foodId,
    name: i.name,
    grams: Math.round(i.grams),
    nutrients: roundNutrients(i.nutrients),
    source: i.source,
    confidence: i.confidence,
    gramsRange: i.gramsRange,
  };
}

export function itemFromFood(food: FoodItem, grams: number): LoggedItem {
  return { foodId: food.id, name: food.name, grams, nutrients: scaleNutrients(food.per100g, grams), source: food.source, confidence: 'alta' };
}

function Conf({ level }: { level?: 'alta' | 'media' | 'bassa' }) {
  if (!level) return null;
  return (
    <span className="conf" data-level={level} title={`fiducia ${level}`} aria-label={`fiducia ${level}`}>
      <i />
      <i />
      <i />
    </span>
  );
}

/* ------------------------------------------------- Scelta alimento */

export function FoodResults({ query, onPick, limit = 30 }: { query: string; onPick: (f: FoodItem) => void; limit?: number }) {
  const index = useFoodIndex();
  const results = useMemo(() => (index && query.trim().length >= 2 ? index.search(query, { limit }) : []), [index, query, limit]);
  if (!index) return <p className="small muted">Carico il database degli alimenti…</p>;
  if (query.trim().length < 2) return null;
  if (results.length === 0) return <p className="small muted">Nessun alimento trovato. Prova con un nome più semplice, o scansiona il codice a barre.</p>;
  return (
    <div className="list">
      {results.map((r) => (
        <button key={r.item.id} type="button" className="row" onClick={() => onPick(r.item)}>
          <div className="row-main">
            <span className="row-title">{r.item.name}</span>
            <span className="row-sub">
              {r.item.brand ? `${r.item.brand} · ` : ''}
              {SOURCE_LABEL[r.item.source]}
            </span>
          </div>
          <span className="row-end num small">
            {fmtInt(r.item.per100g.kcal)} kcal
            <span className="muted">{fmt1(r.item.per100g.protein)} g prot. / 100 g</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function FoodPickerSheet({ open, onClose, onPick, title = 'Scegli alimento' }: { open: boolean; onClose: () => void; onPick: (f: FoodItem) => void; title?: string }) {
  const [q, setQ] = useState('');
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <label className="field">
        <span className="visually-hidden">Cerca</span>
        <input className="input" autoFocus placeholder="es. petto di pollo, supplì, ricotta" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
      </label>
      <FoodResults
        query={q}
        onPick={(f) => {
          onPick(f);
          setQ('');
        }}
      />
    </Sheet>
  );
}

/* ------------------------------------------------- Grammi di un alimento */

export function ItemEditor({ food, initialGrams, onDone, cta = 'Aggiungi' }: { food: FoodItem; initialGrams?: number; onDone: (item: LoggedItem) => void; cta?: string }) {
  const [g, setG] = useState(initialGrams ?? food.portions?.[0]?.grams ?? 100);
  const n = scaleNutrients(food.per100g, g);
  return (
    <div className="stack">
      <div className="stack-sm">
        <h3>{food.name}</h3>
        <span className="small muted">
          {food.brand ? `${food.brand} · ` : ''}
          {SOURCE_LABEL[food.source]} · {fmtInt(food.per100g.kcal)} kcal per 100 g
        </span>
      </div>
      {food.portions && food.portions.length > 0 && (
        <div className="chips">
          {food.portions.map((p) => (
            <button key={p.label} type="button" className="chip" aria-pressed={p.grams === g} onClick={() => setG(p.grams)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <Stepper big label="Grammi" value={g} onChange={setG} step={10} dragStep={5} min={1} max={3000} unit="g" />
      <div className="grid-2 num">
        <span>
          <strong>{fmtInt(n.kcal)}</strong> kcal
        </span>
        <span>
          <strong>{fmt1(n.protein)}</strong> g proteine
        </span>
        <span className="muted">{fmt1(n.carbs)} g carboidrati</span>
        <span className="muted">{fmt1(n.fat)} g grassi</span>
      </div>
      <button type="button" className="btn btn--primary btn--lg btn--block" onClick={() => onDone(itemFromFood(food, g))}>
        {cta}
      </button>
    </div>
  );
}

/* ------------------------------------------------- Revisione delle bozze */

export function DraftReview({
  items,
  onItems,
  questions = [],
}: {
  items: DraftItem[];
  onItems: (d: DraftItem[]) => void;
  questions?: ClarifyingQuestion[];
}) {
  const [picker, setPicker] = useState<{ mode: 'replace'; index: number } | { mode: 'add' } | null>(null);
  const [answered, setAnswered] = useState<Record<string, number>>({});
  const totals = draftTotals(items);

  // la voce a cui si riferisce ogni domanda, fissata quando arriva l'analisi: gli indici cambiano se togli una voce
  const anchors = useMemo(() => {
    const m = new Map<string, DraftItem>();
    for (const q of questions) if (q.itemIndex !== undefined && items[q.itemIndex]) m.set(q.id, items[q.itemIndex]);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions]);
  useEffect(() => setAnswered({}), [questions]);

  const answer = (q: ClarifyingQuestion, grams: number) => {
    setAnswered((a) => ({ ...a, [q.id]: grams }));
    onItems(answerItems(items, anchors.get(q.id), grams));
  };

  const replace = (i: number, f: FoodItem) => {
    const next = [...items];
    next[i] = replaceDraftFood(items[i], f);
    onItems(next);
  };

  return (
    <div className="stack">
      <div className="list">
        {items.map((d, i) => (
          <div key={i} className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="split" style={{ alignItems: 'flex-start' }}>
              <div className="row-main">
                <span className="row-title" style={{ whiteSpace: 'normal' }}>
                  {d.name}
                </span>
                <span className="row-sub" style={{ whiteSpace: 'normal' }}>
                  {d.inputName !== d.name ? `«${d.inputName}» · ` : ''}
                  {SOURCE_LABEL[d.source]} <Conf level={d.confidence} />
                </span>
              </div>
              <button type="button" className="icon-btn" aria-label={`Togli ${d.name}`} onClick={() => onItems(items.filter((_, k) => k !== i))}>
                <X size={20} />
              </button>
            </div>
            <Stepper label={`Grammi di ${d.name}`} value={Math.round(d.grams)} onChange={(g) => onItems(items.map((x, k) => (k === i ? rescaleDraft(x, g) : x)))} step={10} dragStep={5} min={1} max={3000} unit="g" />
            <div className="split small">
              <span className="num">
                {fmtInt(d.nutrients.kcal)} kcal
                {Math.round(d.kcalRange[0]) !== Math.round(d.kcalRange[1]) && (
                  <span className="muted">
                    {' '}
                    ({fmtInt(d.kcalRange[0])}-{fmtInt(d.kcalRange[1])})
                  </span>
                )}
              </span>
              <span className="num muted">{fmt1(d.nutrients.protein)} g prot.</span>
            </div>
            {d.confidence === 'bassa' && <p className="xs muted">Stima incerta sui grammi: controlla prima di salvare.</p>}
            {d.alternatives.length > 0 && (
              <div className="chips">
                {d.alternatives.slice(0, 3).map((a) => (
                  <button
                    key={a.foodId}
                    type="button"
                    className="chip"
                    onClick={async () => {
                      const f = await getFoodIndex();
                      const food = f.get(a.foodId);
                      if (food) replace(i, food);
                    }}
                  >
                    {a.name}
                  </button>
                ))}
                <button type="button" className="chip" onClick={() => setPicker({ mode: 'replace', index: i })}>
                  <MagnifyingGlass size={14} style={{ display: 'inline', verticalAlign: '-2px' }} /> altro
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {questions.map((q) => (
        <div key={q.id} className="panel">
          <p className="small">{q.text}</p>
          {q.options && (
            <div className="chips">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  className="chip"
                  aria-pressed={answered[q.id] === o.grams}
                  onClick={() => answer(q, o.grams)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <button type="button" className="btn" onClick={() => setPicker({ mode: 'add' })}>
        Aggiungi un alimento che manca
      </button>

      <div className="panel">
        <div className="split">
          <span className="corsia-label">Totale</span>
          <span className="num">
            <strong>{fmtInt(totals.kcal)} kcal</strong>
            {Math.round(totals.kcalRange[0]) !== Math.round(totals.kcalRange[1]) && (
              <span className="muted small">
                {' '}
                tra {fmtInt(totals.kcalRange[0])} e {fmtInt(totals.kcalRange[1])}
              </span>
            )}
          </span>
        </div>
        <div className="grid-3 num small">
          <span>{fmt1(totals.protein)} g prot.</span>
          <span>{fmt1(totals.carbs)} g carb.</span>
          <span>{fmt1(totals.fat)} g grassi</span>
        </div>
      </div>

      <FoodPickerSheet
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={picker?.mode === 'add' ? 'Aggiungi alimento' : 'Cambia alimento'}
        onPick={(f) => {
          if (!picker) return;
          if (picker.mode === 'replace') replace(picker.index, f);
          else {
            const g = f.portions?.[0]?.grams ?? 100;
            const n = scaleNutrients(f.per100g, g);
            onItems([
              ...items,
              {
                foodId: f.id,
                name: f.name,
                inputName: f.name,
                grams: g,
                gramsRange: [g, g],
                kcalRange: [n.kcal, n.kcal],
                nutrients: n,
                per100g: f.per100g,
                source: f.source,
                confidence: 'alta',
                kind: 'alimento',
                alternatives: [],
                why: 'aggiunto a mano',
              },
            ]);
          }
          setPicker(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------- Modifica di una voce */

export function EntryEditor({ entry, onClose }: { entry: FoodLogEntry; onClose: () => void }) {
  const [items, setItems] = useState<LoggedItem[]>(entry.items);
  const [slot, setSlot] = useState<MealSlot>(entry.slot);
  const per100 = (i: LoggedItem) => (i.grams > 0 ? scaleNutrients(i.nutrients, 10000 / i.grams) : i.nutrients);
  const save = async () => {
    if (items.length === 0) await db.foodLog.delete(entry.id!);
    else await db.foodLog.update(entry.id!, { items: items.map(cleanItem), slot });
    onClose();
  };
  const saveAsMeal = async () => {
    const name = prompt('Nome del pasto salvato', items.map((i) => i.name).join(', ').slice(0, 40));
    if (!name) return;
    await db.savedMeals.add({ name, items: items.map(cleanItem), uses: 0 });
  };
  return (
    <div className="stack">
      <SlotPicker value={slot} onChange={setSlot} />
      <div className="list">
        {items.map((it, k) => (
          <div key={k} className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="split">
              <span className="row-title">{it.name}</span>
              <button type="button" className="icon-btn" aria-label={`Togli ${it.name}`} onClick={() => setItems(items.filter((_, j) => j !== k))}>
                <Trash size={18} />
              </button>
            </div>
            <Stepper
              label={`Grammi di ${it.name}`}
              value={Math.round(it.grams)}
              onChange={(g) => setItems(items.map((x, j) => (j === k ? { ...x, grams: g, nutrients: scaleNutrients(per100(x), g) } : x)))}
              step={10}
              dragStep={5}
              min={1}
              max={3000}
              unit="g"
            />
            <span className="small num muted">
              {fmtInt(it.nutrients.kcal)} kcal · {fmt1(it.nutrients.protein)} g prot.
            </span>
          </div>
        ))}
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn--primary" onClick={save}>
          Salva
        </button>
        <button type="button" className="btn" onClick={saveAsMeal}>
          Salva come pasto
        </button>
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--danger"
        onClick={async () => {
          await db.foodLog.delete(entry.id!);
          onClose();
        }}
      >
        Elimina {slotLabel(entry.slot).toLowerCase()}
      </button>
    </div>
  );
}
