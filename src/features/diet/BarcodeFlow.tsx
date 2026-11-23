import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ArrowLeft, Camera } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { FoodItem, MealSlot } from '@/db/types';
import { useSetting } from '@/app/hooks';
import { invalidateFoodIndex, slotForTime } from '@/app/engine';
import { useToast } from '@/components/ui';
import { analyzeLabel, GeminiError, isValidBarcode, lookupBarcodeDetailed, OffError } from '@/lib/nutrition';
import { ItemEditor, SlotPicker, saveEntry } from './parts';
import { getDetector } from './scanner';
import { addSpent } from './spend';
import { todayISO } from '@/lib/dates';

type Phase =
  | { k: 'scan' }
  | { k: 'lookup'; code: string }
  | { k: 'found'; food: FoodItem }
  | { k: 'missing'; code: string; text: string }
  | { k: 'label'; code?: string };

export function BarcodeFlow() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const date = new URLSearchParams(useSearch()).get('d') ?? todayISO();
  const [key] = useSetting<string>('gemini.apiKey', '');
  const [model] = useSetting<string>('gemini.model', 'gemini-3.8-flash');
  const [phase, setPhase] = useState<Phase>({ k: 'scan' });
  const [manual, setManual] = useState('');
  const [camErr, setCamErr] = useState<string | null>(null);
  const [slot, setSlot] = useState<MealSlot>(slotForTime());
  const video = useRef<HTMLVideoElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);

  const lookup = async (code: string) => {
    setPhase({ k: 'lookup', code });
    const local = await db.foods.where('barcode').equals(code).first();
    if (local) return setPhase({ k: 'found', food: local });
    try {
      const r = await lookupBarcodeDetailed(code);
      if (r.status === 'trovato') {
        await db.foods.put({ ...r.food, barcode: code });
        invalidateFoodIndex();
        setPhase({ k: 'found', food: r.food });
      } else if (r.status === 'senza-valori') {
        setPhase({ k: 'missing', code, text: `${r.name ?? 'Prodotto'} trovato su Open Food Facts, ma senza valori nutrizionali.` });
      } else {
        setPhase({ k: 'missing', code, text: 'Prodotto non presente su Open Food Facts.' });
      }
    } catch (e) {
      setPhase({ k: 'missing', code, text: e instanceof OffError ? e.message : 'Open Food Facts non risponde. Sei offline?' });
    }
  };

  // fotocamera + lettore
  useEffect(() => {
    if (phase.k !== 'scan') return;
    let stream: MediaStream | null = null;
    let stop = false;
    let timer: number | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const det = await getDetector();
        const loop = async () => {
          if (stop) return;
          try {
            if (v.readyState >= 2) {
              const found = await det.detect(v);
              const hit = found.map((f) => f.rawValue).find((c) => isValidBarcode(c));
              if (hit) {
                navigator.vibrate?.(20);
                void lookup(hit);
                return;
              }
            }
          } catch {
            /* fotogramma non leggibile */
          }
          timer = window.setTimeout(loop, 250);
        };
        void loop();
      } catch {
        setCamErr('Fotocamera non disponibile: scrivi il codice qui sotto.');
      }
    })();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k]);

  const onLabel = async (f: File | undefined, code?: string) => {
    if (!f) return;
    if (!key) return toast('Per leggere le etichette serve la chiave di Gemini (Profilo).');
    setPhase({ k: 'label', code });
    try {
      const r = await analyzeLabel(f, { apiKey: key, model });
      await addSpent(r.cost.usd);
      const food: FoodItem = { ...r.food, barcode: code ?? r.food.barcode, id: code ? `off-${code}` : r.food.id };
      await db.foods.put(food);
      invalidateFoodIndex();
      r.warnings.forEach((w) => toast(w));
      setPhase({ k: 'found', food });
    } catch (e) {
      toast(e instanceof GeminiError ? e.message : 'Etichetta non leggibile. Riprova con più luce.');
      setPhase(code ? { k: 'missing', code, text: 'Riprova la foto o inserisci i valori a mano.' } : { k: 'scan' });
    }
  };

  return (
    <main className="screen screen--bare">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => history.back()} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>Codice a barre</h1>
        </div>
      </header>
      <input ref={labelInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onLabel(e.target.files?.[0], phase.k === 'missing' ? phase.code : undefined)} />

      {phase.k === 'scan' && (
        <>
          <div className="photo-stage">
            <video ref={video} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <div className="photo-stage-caption">{camErr ?? 'Inquadra il codice a barre, tenendolo fermo.'}</div>
          </div>
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const c = manual.replace(/\D/g, '');
              if (!isValidBarcode(c)) return toast('Codice non valido: controlla le cifre.');
              void lookup(c);
            }}
          >
            <label className="field">
              <span className="field-label">Oppure scrivi il codice</span>
              <input className="input input--num" inputMode="numeric" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="8076800195057" />
            </label>
            <button type="submit" className="btn">
              Cerca il codice
            </button>
          </form>
          <button type="button" className="btn btn--ghost" onClick={() => labelInput.current?.click()}>
            <Camera size={20} /> Fotografa l'etichetta nutrizionale
          </button>
        </>
      )}

      {phase.k === 'lookup' && <p className="status-line" role="status">Cerco {phase.code} su Open Food Facts…</p>}
      {phase.k === 'label' && <p className="status-line" role="status">Leggo l'etichetta…</p>}

      {phase.k === 'missing' && (
        <div className="stack">
          <p className="note note--warn">{phase.text}</p>
          <button type="button" className="btn btn--primary" onClick={() => labelInput.current?.click()}>
            <Camera size={20} /> Fotografa l'etichetta
          </button>
          <button type="button" className="btn" onClick={() => setPhase({ k: 'scan' })}>
            Scansiona un altro codice
          </button>
        </div>
      )}

      {phase.k === 'found' && (
        <div className="stack">
          <SlotPicker value={slot} onChange={setSlot} />
          <ItemEditor
            food={phase.food}
            onDone={async (item) => {
              await saveEntry(date, slot, [item], 'barcode');
              toast(`${item.name}: aggiunto.`);
              navigate(date === todayISO() ? '/dieta' : `/dieta?d=${date}`);
            }}
          />
        </div>
      )}
    </main>
  );
}
