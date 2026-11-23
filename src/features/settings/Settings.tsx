import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, ArrowSquareOut, CaretRight, FileArrowUp } from '@phosphor-icons/react';
import { db } from '@/db/db';
import { useProfile, useSetting, type ThemePref } from '@/app/hooks';
import { Segmented, useToast } from '@/components/ui';
import { SyncLine } from './SyncLine';
import { bundleUrlFrom, forgetPassphrase, setPassphrase, syncGarmin, type GarminConfig } from '@/app/garminSync';
import { downloadBlob, exportBackup, restoreBackup } from '@/app/backup';
import { clearDemo, loadDemo } from '@/app/demo';
import { ageFrom, todayISO } from '@/lib/dates';
import { REPO_NAME, REPO_OWNER, REPO_URL } from '@/app/config';
import { ATTRIBUTION } from '@/lib/nutrition/foodDb';
import { fmt1 } from '@/lib/format';

/** Riga sotto il campo del repository: l'indirizzo letto, o cosa non va nel testo scritto. */
function sourceHint(v: string): string {
  try {
    return 'Legge ' + bundleUrlFrom(v).replace('https://', '');
  } catch (e) {
    return (e as Error).message;
  }
}

const GOAL_IT = { massa: 'più muscolo', ricomposizione: 'ricomposizione', mantenimento: 'mantenimento', definizione: 'perdere grasso' } as const;

export function Settings() {
  const [, navigate] = useLocation();
  const profile = useProfile();
  return (
    <main className="screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => (history.length > 1 ? history.back() : navigate('/'))} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>Profilo</h1>
        </div>
      </header>

      <section className="section" aria-labelledby="h-prof">
        <h2 id="h-prof">I tuoi dati</h2>
        {profile ? (
          <Link href="/profilo/modifica" className="list" style={{ textDecoration: 'none' }}>
            <span className="row">
              <span className="row-main">
                <span className="row-title">{profile.name ?? 'Tu'}</span>
                <span className="row-sub num">
                  {profile.birthDate ? `${ageFrom(profile.birthDate, todayISO())} anni · ` : ''}
                  {profile.heightCm} cm · {fmt1(profile.weightKg)} kg · {GOAL_IT[profile.goal]}
                </span>
              </span>
              <CaretRight size={16} className="row-icon" />
            </span>
          </Link>
        ) : (
          <div className="panel">
            <p>Senza profilo l'app registra cibo e allenamenti, ma non calcola obiettivi.</p>
            <Link href="/benvenuto" className="btn btn--primary">
              Inserisci i tuoi dati
            </Link>
          </div>
        )}
      </section>

      <GarminSection />
      <FitSection />
      <GeminiSection />
      <BackupSection />
      <LookSection />
      <DemoSection />
      <AboutSection />
    </main>
  );
}

function GarminSection() {
  const toast = useToast();
  const [cfg, setCfg] = useSetting<GarminConfig | null>('garmin.config', null);
  const [source, setSource] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const stored = useLiveQuery(async () => !!(await db.settings.get('garmin.passphrase')), []);
  const value = source ?? cfg?.source ?? `${REPO_OWNER}/${REPO_NAME}`;
  // la spunta riparte da quello che era stato scelto
  useEffect(() => {
    if (cfg) setRemember(cfg.remember);
  }, [cfg?.remember]);

  const onRemember = async (on: boolean) => {
    setRemember(on);
    if (cfg) await setCfg({ ...cfg, remember: on });
    if (!on && stored) {
      await forgetPassphrase();
      toast('Password tolta da questo telefono: vale fino alla chiusura dell’app.');
    }
  };

  const run = async () => {
    if (!value.trim()) return toast('Scrivi utente/repository, per esempio mattyprog/foro.');
    setBusy(true);
    try {
      await setCfg({ source: value.trim(), remember });
      if (pass) await setPassphrase(pass, remember);
      else if (!remember) await forgetPassphrase();
      const r = await syncGarmin(pass ? { passphrase: pass } : undefined);
      toast(r.added + r.updated > 0 ? `Garmin: ${r.added} attività nuove, ${r.updated} aggiornate.` : 'Garmin: già tutto aggiornato.');
      setPass('');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section" id="garmin" aria-labelledby="h-garmin">
      <div className="section-head">
        <h2 id="h-garmin">Garmin</h2>
      </div>
      <SyncLine />
      <div className="panel">
        <p className="small">
          La GitHub Action del repository scarica i dati del Venu 4 ogni 3 ore dall'API personale di Garmin e li pubblica cifrati. Qui li decifri con la stessa password.
        </p>
        <label className="field">
          <span className="field-label">Repository della sync</span>
          <input className="input" placeholder="utente/repository" value={value} onChange={(e) => setSource(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {value && (
            <span className="field-hint" style={{ overflowWrap: 'anywhere' }}>
              {sourceHint(value)}
            </span>
          )}
        </label>
        <label className="field">
          <span className="field-label">Password della sync</span>
          <input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="la stessa del secret SYNC_PASSPHRASE" />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => void onRemember(e.target.checked)} />
          <span className="small">Ricordala su questo telefono (così si aggiorna da sola all'apertura)</span>
        </label>
        <button type="button" className="btn btn--primary" onClick={run} disabled={busy}>
          {busy ? 'Scarico e decifro…' : 'Scarica i dati adesso'}
        </button>
        {stored && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={async () => {
              await forgetPassphrase(true);
              toast('Password della sync tolta: la sync si ferma finché non la reinserisci.');
            }}
          >
            Dimentica la password su questo telefono
          </button>
        )}
        <a className="small" href={`${REPO_URL}/blob/main/docs/GARMIN.md`} target="_blank" rel="noreferrer">
          Come si configura (10 minuti) <ArrowSquareOut size={14} style={{ display: 'inline', verticalAlign: '-2px' }} />
        </a>
      </div>
    </section>
  );
}

function FitSection() {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setBusy(true);
    try {
      const { importFitFiles } = await import('@/app/fitImport');
      const r = await importFitFiles(files);
      const parts = [`${r.added} importate`];
      if (r.duplicates) parts.push(`${r.duplicates} già presenti`);
      if (r.failed) parts.push(`${r.failed} non lette`);
      toast(`File FIT: ${parts.join(', ')}.`);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };
  return (
    <section className="section" id="fit" aria-labelledby="h-fit">
      <h2 id="h-fit">Importa file FIT</h2>
      <p className="small muted">Da Garmin Connect: apri l'attività, menu ⋯, «Esporta file originale». Funziona anche senza la sync.</p>
      <input ref={input} type="file" accept=".fit,.zip,application/octet-stream,application/zip" multiple hidden onChange={onFiles} />
      <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>
        <FileArrowUp size={20} /> {busy ? 'Leggo i file…' : 'Scegli file .fit o .zip'}
      </button>
    </section>
  );
}

function GeminiSection() {
  const toast = useToast();
  const [key, setKey] = useSetting<string>('gemini.apiKey', '');
  const [model, setModel] = useSetting<string>('gemini.model', 'gemini-3.8-flash');
  const [draft, setDraft] = useState('');
  const spent = useSetting<number>('gemini.spentUsd', 0)[0];
  return (
    <section className="section" aria-labelledby="h-gem">
      <h2 id="h-gem">Foto del cibo</h2>
      <div className="panel">
        <p className="small">
          Le foto le analizza Gemini con una tua chiave di Google AI Studio: individua alimenti e grammi, le calorie le calcola il database. Circa mezzo centesimo a foto, scalato dal tuo credito prepagato.
        </p>
        <label className="field">
          <span className="field-label">Chiave API {key ? '(salvata su questo telefono)' : ''}</span>
          <input className="input" type="password" autoComplete="off" value={draft} placeholder={key ? '••••••••••••' : 'incolla la chiave'} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!draft.trim()}
            onClick={async () => {
              await setKey(draft.trim());
              setDraft('');
              toast('Chiave salvata sul telefono.');
            }}
          >
            Salva chiave
          </button>
          {key && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={async () => {
                await db.settings.delete('gemini.apiKey');
                toast('Chiave rimossa.');
              }}
            >
              Rimuovi
            </button>
          )}
        </div>
        <label className="field">
          <span className="field-label">Modello</span>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="gemini-3.8-flash">Gemini 3.8 Flash (consigliato)</option>
            <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite (più economico, meno preciso)</option>
          </select>
        </label>
        {spent > 0 && <p className="xs muted num">Speso finora da questo telefono: circa {spent.toFixed(3).replace('.', ',')} $</p>}
        <a className="small" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          Crea una chiave dedicata a Foro <ArrowSquareOut size={14} style={{ display: 'inline', verticalAlign: '-2px' }} />
        </a>
      </div>
    </section>
  );
}

function BackupSection() {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const last = useSetting<string | null>('backup.lastAt', null);
  const doExport = async () => {
    if (pass.length < 8) return toast('Scegli una password di almeno 8 caratteri.');
    const { blob, filename } = await exportBackup(pass);
    downloadBlob(blob, filename);
    await last[1](new Date().toISOString());
    toast('Backup cifrato scaricato. Tienilo su Drive o iCloud.');
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!pass) return toast('Scrivi prima la password del backup.');
    if (!confirm('Il ripristino sostituisce i dati di questo telefono con quelli del backup. Continuare?')) return;
    try {
      const n = await restoreBackup(await f.text(), pass);
      toast(`Ripristinati ${n} elementi.`);
    } catch (err) {
      toast((err as Error).name === 'WrongPassphraseError' ? 'Password del backup sbagliata.' : (err as Error).message || 'Backup non leggibile.');
    }
  };
  return (
    <section className="section" aria-labelledby="h-bak">
      <h2 id="h-bak">Copia di sicurezza</h2>
      <div className="panel">
        <p className="small">I dati vivono solo su questo telefono. Una copia cifrata ogni settimana ti salva se cambi telefono o il browser li cancella.</p>
        <label className="field">
          <span className="field-label">Password del backup</span>
          <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <div className="btn-row">
          <button type="button" className="btn btn--primary" onClick={doExport}>
            Scarica backup
          </button>
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            Ripristina
          </button>
        </div>
        <input ref={input} type="file" accept="application/json,.json" hidden onChange={onFile} />
        {last[0] && <p className="xs muted">Ultimo backup: {new Date(last[0]).toLocaleDateString('it-IT')}</p>}
      </div>
    </section>
  );
}

function LookSection() {
  const [theme, setTheme] = useSetting<ThemePref>('theme', 'system');
  return (
    <section className="section" aria-labelledby="h-look">
      <h2 id="h-look">Aspetto</h2>
      <Segmented
        label="Tema"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'system', label: 'Come il telefono' },
          { value: 'light', label: 'Travertino' },
          { value: 'dark', label: 'Sampietrino' },
        ]}
      />
    </section>
  );
}

function DemoSection() {
  const toast = useToast();
  const demo = useLiveQuery(() => db.settings.get('demo.loaded'), []);
  return (
    <section className="section" aria-labelledby="h-demo">
      <h2 id="h-demo">Dati di prova</h2>
      <p className="small muted">Un mese di dati inventati per vedere com'è l'app piena. Si cancellano senza toccare i tuoi.</p>
      {demo ? (
        <button
          type="button"
          className="btn btn--danger"
          onClick={async () => {
            await clearDemo();
            toast('Dati di prova cancellati.');
          }}
        >
          Cancella i dati di prova
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await loadDemo();
            toast('Dati di prova caricati.');
          }}
        >
          Carica i dati di prova
        </button>
      )}
    </section>
  );
}

function AboutSection() {
  return (
    <section className="section" aria-labelledby="h-about">
      <h2 id="h-about">Fonti e avvertenze</h2>
      <div className="stack-sm small muted">
        <p>{ATTRIBUTION}</p>
        <p>Dati Garmin: Garmin Connect Personal API, in sola lettura.</p>
        <p>Foro non è un dispositivo medico e non sostituisce medico o nutrizionista. Se hai dolore al petto, svenimenti o sintomi nuovi, parlane con un medico.</p>
      </div>
    </section>
  );
}
