import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, Camera, Images } from '@phosphor-icons/react';
import { addSpent } from './spend';
import type { MealSlot } from '@/db/types';
import { useSetting } from '@/app/hooks';
import { getFoodIndex, slotForTime } from '@/app/engine';
import { useToast } from '@/components/ui';
import { analyzePhoto, GeminiError, type MealAnalysis, type DraftItem } from '@/lib/nutrition';
import { DraftReview, SlotPicker, saveEntry } from './parts';
import { makeThumb } from './media';
import { todayISO } from '@/lib/dates';
import { fmt1 } from '@/lib/format';

type Phase = { k: 'pick' } | { k: 'busy' } | { k: 'review'; a: MealAnalysis } | { k: 'error'; msg: string };

export function PhotoFlow() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const date = new URLSearchParams(search).get('d') ?? todayISO();
  const toast = useToast();
  const [key, , loadingKey] = useSetting<string>('gemini.apiKey', '');
  const [model] = useSetting<string>('gemini.model', 'gemini-3.8-flash');
  const [phase, setPhase] = useState<Phase>({ k: 'pick' });
  const [img, setImg] = useState<{ blob: Blob; url: string } | null>(null);
  const [note, setNote] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [slot, setSlot] = useState<MealSlot>(slotForTime());
  const cam = useRef<HTMLInputElement>(null);
  const gal = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (img) URL.revokeObjectURL(img.url);
    },
    [img],
  );

  const run = async (blob: Blob) => {
    setPhase({ k: 'busy' });
    try {
      const index = await getFoodIndex();
      const a = await analyzePhoto(blob, { apiKey: key, model, index, note: note.trim() || undefined });
      await addSpent(a.cost.usd);
      if (a.notFood || a.items.length === 0) {
        setPhase({ k: 'error', msg: 'Non riconosco il piatto. Prova più vicino, o cerca gli alimenti a mano.' });
        return;
      }
      setItems(a.items);
      setPhase({ k: 'review', a });
    } catch (e) {
      const msg = e instanceof GeminiError ? e.message : 'Analisi non riuscita, nessun costo addebitato. Riprova o inserisci a mano.';
      setPhase({ k: 'error', msg });
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (img) URL.revokeObjectURL(img.url);
    setImg({ blob: f, url: URL.createObjectURL(f) });
    void run(f);
  };

  const save = async () => {
    if (!img || items.length === 0) return;
    const thumb = await makeThumb(img.blob);
    await saveEntry(date, slot, items, 'foto', thumb);
    const tot = items.reduce((a, i) => a + i.nutrients.protein, 0);
    toast(`Pasto salvato: ${fmt1(tot)} g di proteine.`);
    navigate(date === todayISO() ? '/dieta' : `/dieta?d=${date}`);
  };

  if (loadingKey) return <main className="screen screen--bare" />;

  return (
    <main className="screen screen--bare">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => history.back()} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>{phase.k === 'review' ? phase.a.dishName : 'Fotografa il piatto'}</h1>
          {phase.k === 'review' && (
            <span className="small muted">
              {phase.a.context === 'ristorante' ? 'Sembra un piatto da ristorante' : phase.a.context === 'casa' ? 'Sembra fatto in casa' : 'Controlla i grammi'} · costo {phase.a.cost.usd < 0.01 ? 'meno di un centesimo' : `${phase.a.cost.usd.toFixed(3)} $`}
            </span>
          )}
        </div>
      </header>

      {/* il valore si azzera: così anche la stessa foto scelta di nuovo riparte */}
      <input
        ref={cam}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={gal}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {!key ? (
        <div className="panel">
          <p>Per riconoscere il cibo dalle foto serve una chiave di Google AI Studio (circa mezzo centesimo a foto, sul tuo credito prepagato).</p>
          <div className="btn-row">
            <Link href="/profilo" className="btn btn--primary">
              Aggiungi la chiave
            </Link>
            <Link href="/dieta/cerca" className="btn">
              Cerca a mano
            </Link>
          </div>
        </div>
      ) : (
        <>
          {img ? (
            <div className="photo-stage" data-busy={phase.k === 'busy'}>
              <img src={img.url} alt="Foto del pasto" />
              {phase.k === 'busy' && <div className="photo-stage-caption" role="status">Riconosco gli alimenti e stimo i grammi…</div>}
            </div>
          ) : (
            <div className="stack">
              <p className="muted">Inquadra il piatto intero, dall'alto o a 45 gradi. Una forchetta accanto aiuta a capire le dimensioni.</p>
              <label className="field">
                <span className="field-label">Dettagli che la foto non dice (facoltativo)</span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="es. al ristorante, pasta integrale, senza olio" />
              </label>
              <button type="button" className="btn btn--primary btn--lg btn--block" onClick={() => cam.current?.click()}>
                <Camera size={22} /> Scatta la foto
              </button>
              <button type="button" className="btn btn--block" onClick={() => gal.current?.click()}>
                <Images size={20} /> Scegli dalla galleria
              </button>
            </div>
          )}

          {phase.k === 'error' && (
            <div className="stack">
              <p className="note note--error">{phase.msg}</p>
              <label className="field">
                <span className="field-label">Dettagli che la foto non dice (facoltativo)</span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="es. al ristorante, pasta integrale, senza olio" />
              </label>
              {img && (
                <button type="button" className="btn btn--primary" onClick={() => void run(img.blob)}>
                  Riprova con questa foto
                </button>
              )}
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => cam.current?.click()}>
                  <Camera size={20} /> Altra foto
                </button>
                <button type="button" className="btn" onClick={() => gal.current?.click()}>
                  <Images size={20} /> Galleria
                </button>
              </div>
              <Link href="/dieta/cerca" className="btn btn--ghost">
                Cerca a mano
              </Link>
            </div>
          )}

          {phase.k === 'review' && (
            <>
              <p className="small muted">Le calorie le calcola il database sui grammi: correggili se serve, poi salva.</p>
              <DraftReview items={items} onItems={setItems} questions={phase.a.questions} />
              <SlotPicker value={slot} onChange={setSlot} />
              <button type="button" className="btn btn--primary btn--lg btn--block" disabled={items.length === 0} onClick={save}>
                Salva il pasto
              </button>
            </>
          )}
        </>
      )}
    </main>
  );
}
