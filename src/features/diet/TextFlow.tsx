import { useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ArrowLeft } from '@phosphor-icons/react';
import type { MealSlot } from '@/db/types';
import { useSetting } from '@/app/hooks';
import { getFoodIndex, slotForTime } from '@/app/engine';
import { useToast } from '@/components/ui';
import { GeminiError, parseText, type DraftItem, type ClarifyingQuestion } from '@/lib/nutrition';
import { DraftReview, SlotPicker, saveEntry } from './parts';
import { addSpent } from './spend';
import { todayISO } from '@/lib/dates';

export function TextFlow() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const date = new URLSearchParams(useSearch()).get('d') ?? todayISO();
  const [key] = useSetting<string>('gemini.apiKey', '');
  const [model] = useSetting<string>('gemini.model', 'gemini-3.8-flash');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<DraftItem[] | null>(null);
  const [questions, setQuestions] = useState<ClarifyingQuestion[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [slot, setSlot] = useState<MealSlot>(slotForTime());

  const run = async () => {
    setBusy(true);
    try {
      const index = await getFoodIndex();
      const r = await parseText(text, { apiKey: key || undefined, model, index });
      if (r.cost) await addSpent(r.cost.usd);
      setItems(r.items);
      setQuestions(r.questions);
      setUnmatched(r.unmatched);
    } catch (e) {
      toast(e instanceof GeminiError ? e.message : 'Non sono riuscito a leggere il pasto. Prova con grammi e nomi semplici.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen screen--bare">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => history.back()} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>Scrivi il pasto</h1>
        </div>
      </header>
      <label className="field">
        <span className="field-label">Cosa hai mangiato?</span>
        <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="es. 80 g di pasta, 150 g di petto di pollo, un cucchiaio d'olio, una mela" />
        <span className="field-hint">Con i grammi lo calcolo sul telefono, gratis. {key ? 'Se serve, chiedo a Gemini.' : ''}</span>
      </label>
      <button type="button" className="btn btn--primary" disabled={busy || text.trim().length < 3} onClick={run}>
        {busy ? 'Leggo…' : 'Calcola'}
      </button>
      {unmatched.length > 0 && <p className="note note--warn">Non ho trovato: {unmatched.join(', ')}. Aggiungili a mano qui sotto.</p>}
      {items && (
        <>
          <DraftReview items={items} onItems={setItems} questions={questions} />
          <SlotPicker value={slot} onChange={setSlot} />
          <button
            type="button"
            className="btn btn--primary btn--lg btn--block"
            disabled={items.length === 0}
            onClick={async () => {
              await saveEntry(date, slot, items, 'testo');
              toast('Pasto salvato.');
              navigate(date === todayISO() ? '/dieta' : `/dieta?d=${date}`);
            }}
          >
            Salva il pasto
          </button>
        </>
      )}
    </main>
  );
}
