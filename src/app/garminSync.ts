import { db, getSetting, setSetting } from '@/db/db';
import type { GarminStatus } from '@/features/settings/SyncLine';
import { envelopeUrl, fetchBundle, fetchSyncMeta } from '@/lib/garmin/fetchBundle';
import { decryptEnvelope } from '@/lib/garmin/envelope';
import { importBundle, LAST_BUNDLE_KEY } from '@/lib/garmin/importBundle';
import { linkGymSessions } from '@/app/linkSessions';

export interface GarminConfig {
  /** 'utente/repo' su GitHub, oppure un URL completo della busta. */
  source: string;
  remember: boolean;
}

export function bundleUrlFrom(source: string): string {
  const s = source.trim();
  if (/^https:\/\//.test(s)) return s;
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(s);
  if (!m) throw new Error('Scrivi il repository come utente/nome, per esempio mattyprog/foro.');
  return envelopeUrl(m[1], m[2]);
}

/** Password della sync: in memoria per la sessione, salvata sul dispositivo solo se l'utente lo chiede. */
let sessionPass: string | null = null;

export async function getPassphrase(): Promise<string | null> {
  if (sessionPass) return sessionPass;
  return (await getSetting<string | null>('garmin.passphrase', null)) ?? null;
}

export async function setPassphrase(p: string, remember: boolean) {
  sessionPass = p;
  if (remember) await setSetting('garmin.passphrase', p);
  else await db.settings.delete('garmin.passphrase');
}

/** Toglie la password salvata sul telefono; con `everywhere` anche quella in memoria (la sync si ferma). */
export async function forgetPassphrase(everywhere = false) {
  await db.settings.delete('garmin.passphrase');
  if (everywhere) sessionPass = null;
}

function messageFor(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  const msg = (e as { message?: string })?.message ?? '';
  if (/WrongPass/i.test(name)) return 'Password della sync sbagliata.';
  if (/NotFound|404/i.test(name + msg)) return 'Nessun dato pubblicato: la prima sync non è ancora partita.';
  if (/Corrupt/i.test(name)) return 'Il file della sync è danneggiato. Rilancia la Action.';
  if (/Version/i.test(name)) return 'Il file della sync è di una versione più nuova: aggiorna l’app.';
  if (/Network|Timeout|fetch/i.test(name + msg) || !navigator.onLine) return 'Garmin non raggiungibile: sei offline?';
  return 'Sync non riuscita. Riprova.';
}

/**
 * Scarica la busta cifrata pubblicata dalla Action, la decifra sul telefono e la importa.
 * Restituisce i conteggi oppure lancia un errore con messaggio in italiano.
 */
export async function syncGarmin(opts?: { passphrase?: string }): Promise<{ added: number; updated: number }> {
  const cfg = await getSetting<GarminConfig | null>('garmin.config', null);
  const prev = await getSetting<GarminStatus>('garmin.status', { state: 'off' });
  if (!cfg?.source) throw new Error('Configura prima il repository della sync.');
  const pass = opts?.passphrase ?? (await getPassphrase());
  if (!pass) throw new Error('Inserisci la password della sync.');
  await setSetting('garmin.status', { ...prev, state: 'busy' } satisfies GarminStatus);
  try {
    const env = await fetchBundle(bundleUrlFrom(cfg.source));
    const bundle = await decryptEnvelope(env, pass);
    const res = await importBundle(db, bundle);
    await linkGymSessions(db);
    const status: GarminStatus = {
      state: 'ok',
      dataAt: bundle.generatedAt ?? env.generatedAt,
      checkedAt: new Date().toISOString(),
    };
    await setSetting('garmin.status', status);
    return { added: res.activities.added, updated: res.activities.updated };
  } catch (e) {
    const message = messageFor(e);
    await setSetting('garmin.status', { ...prev, state: 'error', message, checkedAt: new Date().toISOString() } satisfies GarminStatus);
    throw new Error(message, { cause: e });
  }
}

/**
 * Vero se su GitHub c'è un pacchetto più nuovo dell'ultimo importato. Legge solo meta.json (pochi byte):
 * così all'apertura non si riscarica e non si decifra la busta quando non è cambiato niente.
 */
export async function hasNewBundle(source: string): Promise<boolean> {
  const last = await getSetting<string | null>(LAST_BUNDLE_KEY, null);
  if (!last) return true;
  try {
    const meta = await fetchSyncMeta(bundleUrlFrom(source));
    return Date.parse(meta.generatedAt) > Date.parse(last);
  } catch {
    return true; // meta.json mancante o illeggibile: si prova la busta, che dà l'errore giusto
  }
}

/** All'apertura: se la sync è configurata e l'ultimo controllo ha più di 30 minuti, riprova in silenzio. */
export async function maybeAutoSync(): Promise<void> {
  const cfg = await getSetting<GarminConfig | null>('garmin.config', null);
  if (!cfg?.source || !(await getPassphrase())) return;
  const st = await getSetting<GarminStatus>('garmin.status', { state: 'off' });
  if (st.checkedAt && Date.now() - new Date(st.checkedAt).getTime() < 30 * 60 * 1000) return;
  if (!(await hasNewBundle(cfg.source))) {
    await setSetting('garmin.status', { ...st, state: st.state === 'error' ? 'error' : 'ok', checkedAt: new Date().toISOString() } satisfies GarminStatus);
    return;
  }
  try {
    await syncGarmin();
  } catch {
    /* lo stato d'errore è già salvato e mostrato nella riga di sync */
  }
}
