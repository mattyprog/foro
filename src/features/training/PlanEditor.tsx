import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowLeft, ArrowUp, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { PlannedExercise, ProgressionRule, RunType, WorkoutTemplate } from '@/db/types';
import { Sheet } from '@/components/Sheet';
import { Stepper } from '@/components/Stepper';
import { useToast } from '@/components/ui';
import { buildPlannedExercise, getExercise } from '@/lib/training/library';
import { ExercisePicker } from './ExercisePicker';
import { DAYS, activateProgram, exerciseLine } from './PlanTab';
import { fmtClock, fmtKg } from '@/lib/format';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

async function touch(programId: string) {
  await db.programs.update(programId, { updatedAt: new Date().toISOString() });
}

export function PlanEditor({ programId }: { programId: string }) {
  const [, navigate] = useLocation();
  const toast = useToast();
  const program = useLiveQuery(() => db.programs.get(programId), [programId], null);
  const templates = useLiveQuery(() => db.templates.where('programId').equals(programId).sortBy('order'), [programId]);
  const [sel, setSel] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (templates && templates.length > 0 && (!sel || !templates.some((t) => t.id === sel))) setSel(templates[0].id);
  }, [templates, sel]);

  if (program === null || !templates) return <main className="screen" />;
  if (!program) {
    return (
      <main className="screen">
        <p>Scheda non trovata.</p>
      </main>
    );
  }
  const t = templates.find((x) => x.id === sel);

  const saveT = async (next: WorkoutTemplate) => {
    await db.templates.put(next);
    await touch(programId);
  };
  const move = (i: number, d: -1 | 1) => {
    if (!t) return;
    const ex = [...t.exercises];
    const j = i + d;
    if (j < 0 || j >= ex.length) return;
    [ex[i], ex[j]] = [ex[j], ex[i]];
    void saveT({ ...t, exercises: ex });
  };
  const addTemplate = async (kind: 'forza' | 'corsa') => {
    const id = uid();
    const tpl: WorkoutTemplate = {
      id,
      programId,
      name: kind === 'corsa' ? 'Corsa facile' : `Seduta ${String.fromCharCode(65 + templates.filter((x) => x.kind === 'forza').length)}`,
      kind,
      order: templates.length,
      exercises: [],
      run: kind === 'corsa' ? { type: 'facile', targetMinutes: 25, zone: 2 } : undefined,
    };
    await db.templates.add(tpl);
    await touch(programId);
    setSel(id);
  };

  return (
    <main className="screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => navigate('/allenamento?tab=scheda')} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <input
            className="input"
            style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--t-lg)' }}
            value={name ?? program.name}
            onChange={(e) => setName(e.target.value)}
            onBlur={async () => {
              if (name && name.trim() && name !== program.name) await db.programs.update(programId, { name: name.trim(), updatedAt: new Date().toISOString() });
            }}
            aria-label="Nome della scheda"
          />
        </div>
      </header>
      {!program.active && (
        <button type="button" className="btn btn--primary" onClick={() => activateProgram(programId).then(() => toast('Scheda attiva.'))}>
          Rendi attiva questa scheda
        </button>
      )}

      <div className="seg" role="tablist" aria-label="Sedute della scheda" style={{ gridAutoColumns: 'minmax(0, 1fr)' }}>
        {templates.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={x.id === sel} aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>
            {x.name.length > 12 ? x.name.slice(0, 11) + '…' : x.name}
          </button>
        ))}
      </div>

      {t && (
        <section className="section">
          <label className="field">
            <span className="field-label">Nome della seduta</span>
            <input className="input" defaultValue={t.name} key={t.id + 'n'} onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && saveT({ ...t, name: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span className="field-label">Giorno</span>
            <select
              className="select"
              value={t.dayOfWeek ?? ''}
              onChange={(e) => saveT({ ...t, dayOfWeek: e.target.value === '' ? undefined : Number(e.target.value) })}
            >
              <option value="">A rotazione</option>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          {t.kind === 'forza' ? (
            <>
              <div className="list">
                {t.exercises.map((pe, i) => {
                  const ex = getExercise(pe.exerciseId);
                  return (
                    <div key={`${pe.exerciseId}-${i}`} className="row">
                      <div className="row-main">
                        <span className="row-title">{ex?.name ?? pe.exerciseId}</span>
                        <span className="row-sub num">
                          {exerciseLine(pe)} · +{fmtKg(pe.incrementKg)} kg
                        </span>
                      </div>
                      <button type="button" className="icon-btn" aria-label="Sposta su" disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp size={18} />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Sposta giù" disabled={i === t.exercises.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown size={18} />
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Modifica ${ex?.name ?? ''}`} onClick={() => setEditIdx(i)}>
                        <PencilSimple size={18} />
                      </button>
                    </div>
                  );
                })}
                {t.exercises.length === 0 && <p className="row small muted">Nessun esercizio: aggiungine uno.</p>}
              </div>
              <button type="button" className="btn" onClick={() => setPicker(true)}>
                <Plus size={18} /> Aggiungi esercizio
              </button>
            </>
          ) : (
            <RunEditor t={t} onSave={saveT} />
          )}

          <button
            type="button"
            className="btn btn--ghost btn--danger"
            onClick={async () => {
              if (!confirm(`Eliminare la seduta ${t.name}?`)) return;
              await db.templates.delete(t.id);
              await touch(programId);
            }}
          >
            <Trash size={18} /> Elimina questa seduta
          </button>
        </section>
      )}

      <div className="btn-row">
        <button type="button" className="btn" onClick={() => addTemplate('forza')}>
          <Plus size={18} /> Seduta di pesi
        </button>
        <button type="button" className="btn" onClick={() => addTemplate('corsa')}>
          <Plus size={18} /> Corsa
        </button>
      </div>

      <button
        type="button"
        className="btn btn--ghost btn--danger"
        onClick={async () => {
          if (!confirm(`Eliminare la scheda ${program.name}? Le sedute già fatte restano nello storico.`)) return;
          await db.transaction('rw', db.programs, db.templates, async () => {
            await db.templates.where('programId').equals(programId).delete();
            await db.programs.delete(programId);
          });
          navigate('/allenamento?tab=scheda');
        }}
      >
        Elimina la scheda
      </button>

      <ExercisePicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(ex) => {
          if (t) void saveT({ ...t, exercises: [...t.exercises, buildPlannedExercise(ex, { sets: 3 })] });
          setPicker(false);
        }}
      />

      <Sheet open={editIdx !== null} onClose={() => setEditIdx(null)} title={t && editIdx !== null ? getExercise(t.exercises[editIdx]?.exerciseId)?.name : ''}>
        {t && editIdx !== null && t.exercises[editIdx] && (
          <ExerciseEditor
            pe={t.exercises[editIdx]}
            onSave={(pe) => {
              const ex = [...t.exercises];
              ex[editIdx] = pe;
              void saveT({ ...t, exercises: ex });
              setEditIdx(null);
            }}
            onRemove={() => {
              void saveT({ ...t, exercises: t.exercises.filter((_, k) => k !== editIdx) });
              setEditIdx(null);
            }}
          />
        )}
      </Sheet>
    </main>
  );
}

function ExerciseEditor({ pe, onSave, onRemove }: { pe: PlannedExercise; onSave: (p: PlannedExercise) => void; onRemove: () => void }) {
  const work = pe.sets.filter((s) => s.type !== 'riscaldamento');
  const warm = pe.sets.filter((s) => s.type === 'riscaldamento');
  const s0 = work[0] ?? { reps: [8, 12] as [number, number], restSec: 90 };
  const [nSets, setNSets] = useState(work.length || 3);
  const [nWarm, setNWarm] = useState(warm.length);
  const [rMin, setRMin] = useState(s0.reps[0]);
  const [rMax, setRMax] = useState(s0.reps[1]);
  const [rest, setRest] = useState(s0.restSec);
  const [rpe, setRpe] = useState<number | undefined>(s0.rpe);
  const [inc, setInc] = useState(pe.incrementKg);
  const [prog, setProg] = useState<ProgressionRule>(pe.progression);
  const [note, setNote] = useState(pe.note ?? '');
  const save = () => {
    const ws = warm[0] ?? { reps: [8, 8] as [number, number], restSec: 60, type: 'riscaldamento' as const };
    onSave({
      ...pe,
      sets: [
        ...Array.from({ length: nWarm }, () => ({ ...ws, type: 'riscaldamento' as const })),
        ...Array.from({ length: nSets }, () => ({ reps: [Math.min(rMin, rMax), Math.max(rMin, rMax)] as [number, number], restSec: rest, rpe, type: 'normale' as const })),
      ],
      incrementKg: inc,
      progression: prog,
      note: note.trim() || undefined,
    });
  };
  return (
    <div className="stack">
      <div className="grid-2">
        <div className="field">
          <span className="field-label">Serie allenanti</span>
          <Stepper label="Serie" value={nSets} onChange={setNSets} step={1} min={1} max={8} />
        </div>
        <div className="field">
          <span className="field-label">Riscaldamento</span>
          <Stepper label="Serie di riscaldamento" value={nWarm} onChange={setNWarm} step={1} min={0} max={4} />
        </div>
        <div className="field">
          <span className="field-label">Ripetizioni min</span>
          <Stepper label="Ripetizioni minime" value={rMin} onChange={setRMin} step={1} min={1} max={30} />
        </div>
        <div className="field">
          <span className="field-label">Ripetizioni max</span>
          <Stepper label="Ripetizioni massime" value={rMax} onChange={setRMax} step={1} min={1} max={30} />
        </div>
        <div className="field">
          <span className="field-label">Recupero</span>
          <Stepper label="Recupero" value={rest} onChange={setRest} step={15} min={15} max={600} format={fmtClock} />
        </div>
        <div className="field">
          <span className="field-label">Incremento</span>
          <Stepper label="Incremento di carico" value={inc} onChange={setInc} step={0.5} min={0} max={10} unit="kg" format={fmtKg} />
        </div>
      </div>
      <div className="field">
        <span className="field-label">RPE obiettivo</span>
        <div className="chips">
          {[undefined, 6, 7, 7.5, 8, 9].map((v) => (
            <button key={String(v)} type="button" className="chip" aria-pressed={rpe === v} onClick={() => setRpe(v)}>
              {v === undefined ? 'nessuno' : String(v).replace('.', ',')}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Progressione</span>
        <div className="seg" role="group" aria-label="Progressione">
          {(['doppia', 'lineare', 'rpe', 'nessuna'] as ProgressionRule[]).map((p) => (
            <button key={p} type="button" aria-pressed={prog === p} onClick={() => setProg(p)}>
              {p === 'rpe' ? 'a RPE' : p}
            </button>
          ))}
        </div>
        <span className="field-hint">Doppia: quando tutte le serie arrivano al massimo delle ripetizioni con RPE 8 o meno, il carico sale e si riparte dal minimo.</span>
      </div>
      <label className="field">
        <span className="field-label">Nota</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="es. presa stretta, panca a 30 gradi" />
      </label>
      <button type="button" className="btn btn--primary btn--lg" onClick={save}>
        Salva
      </button>
      <button type="button" className="btn btn--ghost btn--danger" onClick={onRemove}>
        Togli dalla seduta
      </button>
    </div>
  );
}

function RunEditor({ t, onSave }: { t: WorkoutTemplate; onSave: (t: WorkoutTemplate) => void }) {
  const r = t.run ?? { type: 'facile' as RunType };
  return (
    <div className="stack">
      <div className="field">
        <span className="field-label">Tipo</span>
        <div className="chips">
          {(['facile', 'lungo', 'recupero', 'progressivo', 'tempo', 'ripetute'] as RunType[]).map((k) => (
            <button key={k} type="button" className="chip" aria-pressed={r.type === k} onClick={() => onSave({ ...t, run: { ...r, type: k } })}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <span className="field-label">Minuti</span>
          <Stepper label="Minuti" value={r.targetMinutes ?? 25} onChange={(v) => onSave({ ...t, run: { ...r, targetMinutes: v } })} step={5} min={10} max={180} />
        </div>
        <div className="field">
          <span className="field-label">Zona cardiaca</span>
          <Stepper label="Zona" value={r.zone ?? 2} onChange={(v) => onSave({ ...t, run: { ...r, zone: v as 1 | 2 | 3 | 4 | 5 } })} step={1} min={1} max={5} />
        </div>
      </div>
      <p className="xs muted">L'API di Garmin è in sola lettura: la corsa non arriva sull'orologio, la registri come sempre e Foro la ritrova nello storico.</p>
    </div>
  );
}
