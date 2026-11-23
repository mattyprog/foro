import { useMemo, useState } from 'react';
import type { Exercise, MuscleGroup } from '@/db/types';
import { Sheet } from '@/components/Sheet';
import { MUSCLES, searchExercises } from '@/lib/training/library';

export function ExercisePicker({
  open,
  onClose,
  onPick,
  title = 'Aggiungi esercizio',
  only,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (e: Exercise) => void;
  title?: string;
  /** Se presente, mostra solo questi (es. sostituzioni). */
  only?: Exercise[];
}) {
  const [q, setQ] = useState('');
  const [muscle, setMuscle] = useState<MuscleGroup | null>(null);
  const list = useMemo(() => {
    if (only) return only;
    return searchExercises(q, muscle ? { muscle } : {}).slice(0, 60);
  }, [q, muscle, only]);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {!only && (
        <>
          <input className="input" placeholder="es. panca, lat machine, affondi" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {MUSCLES.map((m) => (
              <button key={m} type="button" className="chip" aria-pressed={muscle === m} onClick={() => setMuscle(muscle === m ? null : m)}>
                {m}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="list">
        {list.map((e) => (
          <button
            key={e.id}
            type="button"
            className="row"
            onClick={() => {
              onPick(e);
              setQ('');
            }}
          >
            <div className="row-main">
              <span className="row-title">{e.name}</span>
              <span className="row-sub">
                {e.primary.join(', ')} · {e.equipment}
              </span>
            </div>
          </button>
        ))}
        {list.length === 0 && <p className="row small muted">Nessun esercizio trovato.</p>}
      </div>
    </Sheet>
  );
}
