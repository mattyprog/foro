import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, Check, Plus, Shuffle, SkipForward, Trash, X } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { GymSession } from '@/db/types';
import { useReadiness } from '@/app/engine';
import { Corsia } from '@/components/Corsia';
import { Sheet } from '@/components/Sheet';
import { Stepper } from '@/components/Stepper';
import { useToast } from '@/components/ui';
import {
  addExercise,
  addSet,
  adjustRest,
  applySuggestions,
  completeSet,
  editSet,
  finishSession,
  removeSet,
  restoreExercise,
  restRemainingSec,
  resumeSession,
  sessionProgress,
  skipExercise,
  skipRest,
  startFreeSession,
  startSession,
  substituteExercise,
  tickRest,
  toGymSession,
  uncompleteSet,
  withSessionId,
  type SessionState,
} from '@/lib/training/session';
import type { SessionMode } from '@/lib/training/types';
import type { SessionSummary } from '@/lib/training/session';
import { getExercise, isAssisted, substitutesFor } from '@/lib/training/library';
import { isDeloadWeek } from '@/lib/training/templates';
import { ExercisePicker } from './ExercisePicker';
import { fmtClock, fmtDuration, fmtKg, fmt1 } from '@/lib/format';
import { parseISODate, todayISO } from '@/lib/dates';
import { fmtDayLong as fmtDay } from '@/lib/format';
import { linkGymSessions } from '@/app/linkSessions';

/** Una seduta senza serie nuove da 6 ore è stata dimenticata aperta. */
const STALE_MS = 6 * 3600 * 1000;

let audio: AudioContext | null = null;
function beep(times = 1) {
  try {
    audio ??= new AudioContext();
    for (let i = 0; i < times; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + i * 0.25 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.25 + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.25);
      o.stop(audio.currentTime + i * 0.25 + 0.2);
    }
  } catch {
    /* audio non disponibile */
  }
}

function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const req = async () => {
      try {
        lock = await navigator.wakeLock?.request('screen');
      } catch {
        /* non supportato o negato */
      }
    };
    const onVis = () => document.visibilityState === 'visible' && req();
    void req();
    document.addEventListener('visibilitychange', onVis);
    document.documentElement.setAttribute('data-gym', 'on');
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.documentElement.removeAttribute('data-gym');
      void lock?.release().catch(() => {});
    };
  }, []);
}

export function GymMode() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const tParam = new URLSearchParams(useSearch()).get('t');
  const history = useLiveQuery(() => db.sessions.orderBy('date').reverse().limit(400).toArray(), []);
  const program = useLiveQuery(() => db.programs.filter((p) => p.active).first(), []);
  const templates = useLiveQuery(() => (program ? db.templates.where('programId').equals(program.id).sortBy('order') : []), [program?.id]);
  const readiness = useReadiness();
  const [state, setState] = useState<SessionState | null>(null);
  const [checkedOpen, setCheckedOpen] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [idx, setIdx] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [edit, setEdit] = useState<string | null>(null);
  const [subst, setSubst] = useState(false);
  const [adding, setAdding] = useState(false);
  const loaded = useRef(false);
  useWakeLock();

  const past = useMemo(() => (history ?? []).filter((h) => h.endedAt), [history]);

  // riprendi una seduta aperta
  useEffect(() => {
    if (!history || loaded.current) return;
    loaded.current = true;
    (async () => {
      let open = await db.sessions.filter((s) => !s.endedAt).first();
      const lastAt = open ? Math.max(Date.parse(open.startedAt), ...open.sets.map((x) => (x.ts ? Date.parse(x.ts) : 0))) : 0;
      if (open && Date.now() - lastAt > STALE_MS) {
        // dimenticata aperta (nessuna serie da 6 ore): la chiudo all'ultima serie, o la scarto se è vuota
        if (open.sets.some((x) => x.done)) {
          await db.sessions.update(open.id!, { endedAt: open.sets.filter((x) => x.done).at(-1)?.ts ?? open.startedAt });
          toast(`Ho chiuso la seduta rimasta aperta di ${fmtDay(parseISODate(open.date)).toLowerCase()}.`);
        } else {
          await db.sessions.delete(open.id!);
        }
        open = undefined;
      }
      if (open) {
        const tpl = open.templateId ? await db.templates.get(open.templateId) : undefined;
        const st = resumeSession(open as GymSession, { history: past, template: tpl });
        if (st) {
          setState(st);
          setIdx(Math.max(0, st.exercises.findIndex((e) => !e.skipped && e.sets.some((x) => !x.done))));
        } else {
          // seduta non ricostruibile: la chiudo così com'è, senza perdere le serie salvate
          await db.sessions.update(open.id!, { endedAt: open.sets.at(-1)?.ts ?? open.startedAt });
        }
      }
      setCheckedOpen(true);
    })();
  }, [history, past]);

  // salva a ogni cambio
  useEffect(() => {
    if (state?.sessionId && !state.endedAt) void db.sessions.put(toGymSession(state));
  }, [state]);

  // orologio e segnali del recupero
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      setState((s) => {
        if (!s?.rest) return s;
        const r = tickRest(s, t);
        if (r.signals.includes('avviso-10s')) {
          navigator.vibrate?.(80);
        }
        if (r.signals.includes('fine')) {
          navigator.vibrate?.([200, 100, 200]);
          beep(2);
        }
        return r.signals.length ? r.state : s;
      });
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const begin = async (templateId: string | null, mode: SessionMode) => {
    let st: SessionState;
    if (templateId) {
      const tpl = await db.templates.get(templateId);
      if (!tpl) return toast('Seduta non trovata nella scheda.');
      st = startSession(tpl, past, Date.now(), { mode });
    } else {
      st = startFreeSession(Date.now(), { mode });
    }
    const id = (await db.sessions.add(toGymSession(st))) as number;
    st = withSessionId(st, id);
    setState(st);
    setIdx(0);
  };

  if (!checkedOpen || !history) return <main className="screen screen--bare" />;

  if (summary) return <Summary s={summary} onClose={() => navigate('/allenamento')} />;

  if (!state) {
    const suggestLight = readiness && readiness.consiglio !== 'normale';
    const deload = program ? isDeloadWeek(program, todayISO()) : false;
    const chosen = tParam ?? null;
    const forza = (templates ?? []).filter((t) => t.kind === 'forza');
    return (
      <main className="screen screen--bare">
        <header className="topbar">
          <button type="button" className="icon-btn" onClick={() => window.history.back()} aria-label="Indietro">
            <ArrowLeft size={22} />
          </button>
          <div className="topbar-title" style={{ flex: 1 }}>
            <h1>In palestra</h1>
          </div>
        </header>
        {suggestLight && <p className="note note--warn">{readiness!.motivo}</p>}
        {deload && <p className="note">Questa è una settimana di scarico della scheda: volume -50% e carico -10%.</p>}
        <StartChoices
          options={chosen ? forza.filter((t) => t.id === chosen) : forza}
          defaultMode={deload ? 'scarico' : suggestLight ? 'leggero' : 'normale'}
          onStart={begin}
        />
      </main>
    );
  }

  const ex = state.exercises[idx];
  const exInfo = ex ? getExercise(ex.exerciseId) : undefined;
  const prog = sessionProgress(state);
  const restLeft = restRemainingSec(state, now);
  const restTotal = state.rest?.durationSec ?? 0;
  const editSetObj = ex?.sets.find((s) => s.key === edit) ?? state.exercises.flatMap((e) => e.sets).find((s) => s.key === edit);
  const elapsed = (now - state.startedAt) / 1000;

  const done = (key: string) => {
    const set = ex.sets.find((s) => s.key === key)!;
    if (set.done) return setState(uncompleteSet(state, key));
    if (set.kg === undefined || set.reps === undefined) return setEdit(key);
    audio ??= new AudioContext();
    let next: SessionState;
    try {
      next = completeSet(state, key, Date.now());
    } catch (e) {
      toast((e as Error).message);
      return setEdit(key);
    }
    setState(next);
    // passa da solo al prossimo esercizio quando questo è finito
    const left = next.exercises[idx].sets.some((s) => !s.done);
    if (!left && idx < next.exercises.length - 1) setTimeout(() => setIdx(idx + 1), 400);
  };

  const finish = async () => {
    if (prog.done === 0) {
      if (!confirm('Nessuna serie fatta: la seduta non viene salvata. Uscire?')) return;
      return discard(false);
    }
    const r = finishSession(state, Date.now(), { history: past });
    await db.sessions.put(r.session);
    void linkGymSessions();
    setState(null);
    setSummary(r.summary);
  };

  const discard = async (ask = true) => {
    if (ask && !confirm('Annullare la seduta? Le serie segnate oggi non vengono salvate.')) return;
    if (state.sessionId !== undefined) await db.sessions.delete(state.sessionId);
    setState(null);
    navigate('/allenamento');
  };

  // serie non ancora fatte dove la progressione propone altri numeri
  const pending = ex ? ex.sets.filter((s) => !s.done && s.type !== 'riscaldamento' && s.suggestion && ((s.suggestion.kg !== undefined && s.suggestion.kg !== s.kg) || s.suggestion.repsTarget !== s.reps)) : [];
  const sg0 = pending[0]?.suggestion;
  const bodyweight = exInfo?.equipment === 'corpo-libero';
  const kgCell = (kg: number | undefined) => (kg === undefined ? '?' : bodyweight ? `+${fmtKg(kg)}` : fmtKg(kg));

  return (
    <main className="screen screen--bare" style={{ gap: 'var(--s-5)' }}>
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => navigate('/allenamento')} aria-label="Esci (la seduta resta aperta)">
          <X size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <span className="small muted num">
            {state.name ?? 'Seduta libera'} · {fmtDuration(elapsed)}
            {state.mode !== 'normale' && ` · ${state.mode}`}
          </span>
        </div>
        <button type="button" className="btn" onClick={finish}>
          Termina
        </button>
      </header>

      <Corsia compact label="Serie" value={prog.done} target={prog.planned + prog.extra} max={Math.max(prog.planned + prog.extra, prog.done, 1)} format={(n) => String(Math.round(n))} />

      {ex ? (
        <section className="section" aria-live="polite">
          <div className="split">
            <button type="button" className="icon-btn" aria-label="Esercizio precedente" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
              <ArrowLeft size={20} />
            </button>
            <span className="small muted num">
              Esercizio {idx + 1} di {state.exercises.length}
            </span>
            <button type="button" className="icon-btn" aria-label="Esercizio successivo" disabled={idx >= state.exercises.length - 1} onClick={() => setIdx(idx + 1)}>
              <ArrowRight size={20} />
            </button>
          </div>
          <h1 className="day-title" style={{ fontSize: 'var(--t-2xl)' }}>
            {exInfo?.name ?? ex.exerciseId}
          </h1>
          {exInfo?.cue && <p className="small muted">{exInfo.cue}</p>}
          {ex.lastTime && ex.lastTime.sets.length > 0 && (
            <p className="small num">
              Scorsa seduta: {ex.lastTime.sets.map((s) => (exInfo?.timed ? `${s.reps} s` : `${fmtKg(s.kg)}×${s.reps}`)).join(', ')}
            </p>
          )}
          {ex.motivo && <p className="small">{ex.motivo}</p>}
          {sg0 && !ex.skipped && (
            <button type="button" className="btn btn--primary" onClick={() => setState(applySuggestions(state, ex.key))}>
              Usa il suggerimento:{' '}
              {exInfo?.timed ? `${sg0.repsTarget} s` : sg0.kg !== undefined ? `${fmtKg(sg0.kg)} kg × ${sg0.repsTarget}` : `${sg0.repsTarget} ripetizioni`}
            </button>
          )}
          {ex.stalled && <span className="tag tag--warn">fermo da qualche seduta</span>}
          {ex.skipped && <p className="note">Esercizio saltato.</p>}

          <div>
            {ex.sets.map((s, i) => (
              <div key={s.key} className="gym-set" data-done={s.done}>
                <span className="gym-set-n">{s.type === 'riscaldamento' ? 'R' : i + 1 - ex.sets.filter((x, k) => k < i && x.type === 'riscaldamento').length}</span>
                <button type="button" className="gym-cell" onClick={() => setEdit(s.key)} aria-label={`Carico serie ${i + 1}`}>
                  {kgCell(s.kg)}
                  <small>kg</small>
                </button>
                <button type="button" className="gym-cell" onClick={() => setEdit(s.key)} aria-label={`Ripetizioni serie ${i + 1}`}>
                  {s.reps ?? `${s.repsMin}-${s.repsMax}`}
                  <small>{exInfo?.timed ? 's' : 'rip'}</small>
                </button>
                <button type="button" className="gym-done" aria-pressed={s.done} onClick={() => done(s.key)} aria-label={s.done ? 'Annulla serie' : 'Serie fatta'}>
                  <Check size={22} weight="bold" style={{ margin: '0 auto' }} />
                </button>
              </div>
            ))}
          </div>

          {restLeft !== undefined && restLeft > 0 && (
            <div className="rest" role="timer" aria-label="Recupero">
              <div className="rest-fill" style={{ width: `${restTotal ? (restLeft / restTotal) * 100 : 0}%` }} />
              <span className="num-big" style={{ fontSize: 'var(--t-2xl)' }}>
                {fmtClock(restLeft)}
              </span>
              <span className="cluster">
                <button type="button" className="btn" onClick={() => setState(adjustRest(state, -15, Date.now()))}>
                  -15
                </button>
                <button type="button" className="btn" onClick={() => setState(adjustRest(state, 15, Date.now()))}>
                  +15
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setState(skipRest(state))}>
                  Salta
                </button>
              </span>
            </div>
          )}

          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setState(addSet(state, ex.key))}>
              <Plus size={18} /> Serie
            </button>
            <button type="button" className="btn" onClick={() => setSubst(true)}>
              <Shuffle size={18} /> Sostituisci
            </button>
            {ex.skipped ? (
              <button type="button" className="btn" onClick={() => setState(restoreExercise(state, ex.key))}>
                <ArrowCounterClockwise size={18} /> Riprendi
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setState(skipExercise(state, ex.key))}>
                <SkipForward size={18} /> Salta
              </button>
            )}
          </div>
        </section>
      ) : (
        <p className="muted">Nessun esercizio: aggiungine uno.</p>
      )}

      <button type="button" className="btn btn--ghost" onClick={() => setAdding(true)}>
        <Plus size={18} /> Aggiungi un esercizio
      </button>
      <button type="button" className="btn btn--ghost btn--danger" onClick={() => discard()}>
        <Trash size={18} /> Annulla la seduta
      </button>

      <Sheet open={edit !== null && !!editSetObj} onClose={() => setEdit(null)} title="Serie">
        {editSetObj && (
          <SetEditor
            timed={!!exInfo?.timed}
            kgLabel={bodyweight ? 'Zavorra (kg in più)' : exInfo && isAssisted(exInfo) ? 'Aiuto della macchina' : 'Carico'}
            kg={editSetObj.kg ?? editSetObj.suggestion?.kg ?? editSetObj.previous?.kg ?? (bodyweight ? 0 : 20)}
            reps={editSetObj.reps ?? editSetObj.suggestion?.repsTarget ?? editSetObj.repsMax}
            rpe={editSetObj.rpe}
            note={editSetObj.note}
            step={exInfo?.defaultIncrementKg && exInfo.defaultIncrementKg < 2.5 ? exInfo.defaultIncrementKg : 1.25}
            onSave={(v, markDone) => {
              try {
                let next = editSet(state, editSetObj.key, v);
                if (markDone && !editSetObj.done) next = completeSet(next, editSetObj.key, Date.now(), v);
                setState(next);
                setEdit(null);
              } catch (e) {
                toast((e as Error).message);
              }
            }}
            onRemove={
              editSetObj.done
                ? undefined
                : () => {
                    setState(removeSet(state, editSetObj.key));
                    setEdit(null);
                  }
            }
          />
        )}
      </Sheet>

      <ExercisePicker
        open={subst}
        onClose={() => setSubst(false)}
        title="Sostituisci con"
        only={ex ? substitutesFor(ex.exerciseId, { limit: 12 }) : []}
        onPick={(e) => {
          try {
            setState(substituteExercise(state, ex.key, e.id, { history: past }));
          } catch (err) {
            toast((err as Error).message);
          }
          setSubst(false);
        }}
      />
      <ExercisePicker
        open={adding}
        onClose={() => setAdding(false)}
        onPick={(e) => {
          setState(addExercise(state, e.id, { history: past, afterKey: ex?.key }));
          setAdding(false);
          setIdx(Math.min(idx + 1, state.exercises.length));
        }}
      />
    </main>
  );
}

function StartChoices({ options, defaultMode, onStart }: { options: { id: string; name: string }[]; defaultMode: SessionMode; onStart: (id: string | null, m: SessionMode) => void }) {
  const [mode, setMode] = useState<SessionMode>(defaultMode);
  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="Tipo di seduta">
        {(['normale', 'leggero', 'scarico'] as SessionMode[]).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === 'leggero' ? 'Leggera' : m === 'scarico' ? 'Scarico' : 'Normale'}
          </button>
        ))}
      </div>
      <p className="xs muted">Leggera: un terzo di serie in meno, niente aumenti di carico. Scarico: metà delle serie e carico -10%.</p>
      {options.map((t) => (
        <button key={t.id} type="button" className="btn btn--primary btn--lg btn--block" onClick={() => onStart(t.id, mode)}>
          Inizia {t.name}
        </button>
      ))}
      <button type="button" className="btn btn--block" onClick={() => onStart(null, mode)}>
        Seduta libera
      </button>
    </div>
  );
}

function SetEditor({
  kg,
  kgLabel,
  reps,
  rpe,
  note,
  timed,
  step,
  onSave,
  onRemove,
}: {
  kg: number;
  kgLabel: string;
  reps: number;
  rpe?: number;
  note?: string;
  timed: boolean;
  step: number;
  onSave: (v: { kg: number; reps: number; rpe: number | null; note: string | null }, markDone: boolean) => void;
  onRemove?: () => void;
}) {
  const [k, setK] = useState(kg);
  const [r, setR] = useState(reps);
  const [e, setE] = useState<number | undefined>(rpe);
  const [n, setN] = useState(note ?? '');
  return (
    <div className="stack">
      <Stepper big label={kgLabel} value={k} onChange={setK} step={step} dragStep={step} min={0} max={500} unit="kg" format={fmtKg} />
      <Stepper big label={timed ? 'Secondi' : 'Ripetizioni'} value={r} onChange={setR} step={1} min={0} max={timed ? 600 : 100} unit={timed ? 's' : 'rip'} />
      <div className="field">
        <span className="field-label">RPE (quanto era dura)</span>
        <div className="chips">
          {[6, 7, 7.5, 8, 8.5, 9, 10].map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={e === v} onClick={() => setE(e === v ? undefined : v)}>
              {fmt1(v)}
            </button>
          ))}
        </div>
        <span className="field-hint">10 = cedimento, 8 = ne avevi ancora due.</span>
      </div>
      <input className="input" value={n} onChange={(x) => setN(x.target.value)} placeholder="Nota (facoltativa)" />
      <div className="btn-row">
        <button type="button" className="btn btn--primary btn--lg" onClick={() => onSave({ kg: k, reps: r, rpe: e ?? null, note: n.trim() || null }, true)}>
          Fatto
        </button>
        <button type="button" className="btn btn--lg" onClick={() => onSave({ kg: k, reps: r, rpe: e ?? null, note: n.trim() || null }, false)}>
          Solo salva
        </button>
      </div>
      {onRemove && (
        <button type="button" className="btn btn--ghost btn--danger" onClick={onRemove}>
          <Trash size={18} /> Togli questa serie
        </button>
      )}
    </div>
  );
}

function Summary({ s, onClose }: { s: SessionSummary; onClose: () => void }) {
  return (
    <main className="screen screen--bare">
      <section className="day">
        <h1 className="day-title">Seduta chiusa</h1>
        <p className="num">
          {fmtDuration(s.durataSec)} · {fmt1(s.tonnellaggioKg / 1000)} t sollevate · {s.serieFatte} serie su {s.seriePianificate}
        </p>
      </section>
      {s.recordTesti.length > 0 && (
        <section className="section">
          <h2>Record</h2>
          {s.recordTesti.map((t) => (
            <p key={t} className="note note--ok">
              {t}
            </p>
          ))}
        </section>
      )}
      <section className="section">
        <h2>Esercizi</h2>
        <div className="list">
          {s.perEsercizio.map((e) => (
            <div key={e.exerciseId} className="row">
              <div className="row-main">
                <span className="row-title">{e.nome}</span>
                <span className="row-sub num">
                  {e.serieFatte} serie{e.migliorSerie ? ` · migliore ${fmtKg(e.migliorSerie.kg)}×${e.migliorSerie.reps}` : ''}
                  {e.sostituisce ? ` · al posto di ${e.sostituisce}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onClose}>
        Chiudi
      </button>
    </main>
  );
}
