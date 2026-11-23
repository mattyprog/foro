import { useState } from 'react';
import { db } from '@/db/db';
import type { WellnessDay } from '@/db/types';
import { useReadiness } from '@/app/engine';
import { SAFETY_MESSAGE } from '@/lib/health/readiness';
import { todayISO } from '@/lib/dates';

const FEELINGS: { id: string; label: string; v: Pick<WellnessDay, 'energy' | 'mood' | 'soreness'> }[] = [
  { id: 'bene', label: 'Bene', v: { energy: 4, mood: 4, soreness: 2 } },
  { id: 'normale', label: 'Normale', v: { energy: 3, mood: 3, soreness: 2 } },
  { id: 'stanco', label: 'Stanco', v: { energy: 2, mood: 3, soreness: 2 } },
  { id: 'dolori', label: 'Indolenzito', v: { energy: 3, mood: 3, soreness: 4 } },
  { id: 'a-pezzi', label: 'A pezzi', v: { energy: 1, mood: 2, soreness: 4 } },
];

export async function saveFeeling(v: Pick<WellnessDay, 'energy' | 'mood' | 'soreness'>, date = todayISO()) {
  const prev = await db.wellness.get(date);
  await db.wellness.put({ ...(prev ?? { date, source: 'manuale' }), ...v, date });
}

/** Semaforo di prontezza con il motivo in una riga, e la domanda "come ti senti" quando serve. */
export function ReadinessLine({ compact }: { compact?: boolean }) {
  const r = useReadiness();
  const [ask, setAsk] = useState(false);
  if (!r) return null;
  // Nessun dato di salute e nessuna sensazione: in Oggi non dico nulla, in Salute spiego cosa serve.
  const noData = r.livello === 'imparando' && r.dettagli.giorniDati === 0 && !r.dettagli.sensazione;
  if (noData && compact) return null;
  const motivo = noData
    ? `Il semaforo di prontezza parte con il Garmin: servono ${r.dettagli.giorniNecessari} giorni di sonno, HRV e FC a riposo.`
    : r.motivo;
  const level = r.livello === 'imparando' ? '' : `light--${r.livello}`;
  const showAsk = ask || !!r.dettagli.domanda || (!r.dettagli.sensazione && !compact);
  return (
    <div className="stack-sm">
      <div className="day-meta" style={{ alignItems: 'flex-start' }}>
        <span className={`light ${level}`} style={{ marginTop: 6 }} aria-hidden="true" />
        <span className="day-reason">
          {motivo}
        </span>
      </div>
      {showAsk && (
        <div className="cluster" role="group" aria-label={r.dettagli.domanda ?? 'Come ti senti oggi?'}>
          <span className="small muted">{r.dettagli.domanda ?? 'Come ti senti oggi?'}</span>
          {FEELINGS.map((f) => (
            <button key={f.id} type="button" className="chip" onClick={() => saveFeeling(f.v).then(() => setAsk(false))}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {!compact && r.dettagli.sensazione && !ask && (
        <button type="button" className="btn btn--ghost small" style={{ alignSelf: 'flex-start', minHeight: 36, padding: '0 8px' }} onClick={() => setAsk(true)}>
          Cambia come ti senti
        </button>
      )}
      {r.dettagli.sensazione === 'molto-male' && <p className="xs muted">{SAFETY_MESSAGE}</p>}
    </div>
  );
}
