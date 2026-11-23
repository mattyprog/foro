import { Link } from 'wouter';
import { useSetting } from '@/app/hooks';
import { fmtAgo, fmtTime } from '@/lib/format';

export interface GarminStatus {
  state: 'off' | 'busy' | 'ok' | 'error';
  /** Istante in cui la Action ha generato i dati. */
  dataAt?: string;
  /** Ultimo controllo dal telefono. */
  checkedAt?: string;
  message?: string;
}

/** Riga di stato della sincronizzazione Garmin, senza spinner. */
export function SyncLine() {
  const [st] = useSetting<GarminStatus>('garmin.status', { state: 'off' });
  if (st.state === 'off')
    return (
      <Link href="/profilo#garmin" className="status-line" style={{ textDecoration: 'none' }}>
        <span className="status-dot" aria-hidden="true" />
        Garmin non collegato
      </Link>
    );
  if (st.state === 'busy')
    return (
      <span className="status-line" role="status">
        <span className="status-dot status-dot--busy" aria-hidden="true" />
        Garmin: aggiornamento in corso{st.dataAt ? `, ultimo alle ${fmtTime(new Date(st.dataAt))}` : ''}
      </span>
    );
  if (st.state === 'error')
    return (
      <Link href="/profilo#garmin" className="status-line" style={{ textDecoration: 'none' }}>
        <span className="status-dot status-dot--error" aria-hidden="true" />
        {st.message ?? 'Garmin non risponde.'}
        {st.dataAt ? ` Ultimi dati di ${fmtAgo(new Date(st.dataAt))}.` : ''}
      </Link>
    );
  const at = st.dataAt ? new Date(st.dataAt) : undefined;
  const stale = at ? Date.now() - at.getTime() > 8 * 3600 * 1000 : true;
  return (
    <span className="status-line">
      <span className={`status-dot ${stale ? 'status-dot--warn' : 'status-dot--ok'}`} aria-hidden="true" />
      {at ? `Garmin: dati delle ${fmtTime(at)}${stale ? `, ${fmtAgo(at)}` : ''}` : 'Garmin collegato'}
    </span>
  );
}
