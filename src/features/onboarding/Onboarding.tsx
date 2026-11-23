import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft } from '@phosphor-icons/react';
import { db, setSetting } from '@/db/db';
import type { DailyActivity, DietStyle, Experience, Goal, Profile, Sex } from '@/db/types';
import { Corsia } from '@/components/Corsia';
import { Stepper } from '@/components/Stepper';
import { fmt1 } from '@/lib/format';
import { todayISO } from '@/lib/dates';

const ALLERGIE = ['lattosio', 'glutine', 'frutta a guscio', 'uova', 'pesce', 'crostacei', 'soia', 'arachidi'];

type Draft = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>;

const EMPTY: Draft = {
  name: '',
  sex: 'M',
  birthDate: '',
  heightCm: 175,
  weightKg: 70,
  bodyFatPct: undefined,
  goal: 'massa',
  experience: 'nuovo',
  gymDaysPerWeek: 3,
  runDaysPerWeek: 2,
  dailyActivity: 'leggero',
  mealsPerDay: 4,
  diet: 'onnivora',
  allergies: [],
  excludedFoods: [],
  notes: '',
};

function Choice<T extends string>({ value, current, onPick, title, sub }: { value: T; current: T; onPick: (v: T) => void; title: string; sub?: string }) {
  return (
    <button type="button" className="choice" aria-pressed={value === current} onClick={() => onPick(value)}>
      <span>
        {title}
        {sub && <small>{sub}</small>}
      </span>
    </button>
  );
}

export function Onboarding({ existing }: { existing?: Profile }) {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(() => (existing ? { ...EMPTY, ...existing } : EMPTY));
  const [excluded, setExcluded] = useState((existing?.excludedFoods ?? []).join(', '));
  // testo libero: così si può scrivere la virgola (18,5) senza che il campo la cancelli
  const [fatText, setFatText] = useState(existing?.bodyFatPct !== undefined ? String(existing.bodyFatPct).replace('.', ',') : '');
  const fatNum = Number(fatText.replace(',', '.'));
  const fatOk = fatText.trim() === '' || (Number.isFinite(fatNum) && fatNum >= 3 && fatNum <= 60);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const STEPS = 7;

  const birthOk = /^\d{4}-\d{2}-\d{2}$/.test(d.birthDate) && d.birthDate < todayISO();
  const canNext = (step !== 0 || birthOk) && (step !== 1 || fatOk);

  const finish = async () => {
    const now = new Date().toISOString();
    const profile: Profile = {
      ...d,
      bodyFatPct: fatText.trim() === '' || !fatOk ? undefined : fatNum,
      id: 'me',
      name: d.name?.trim() || undefined,
      notes: d.notes?.trim() || undefined,
      excludedFoods: excluded
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await db.transaction('rw', db.profile, db.weights, async () => {
      await db.profile.put(profile);
      const today = todayISO();
      const w = await db.weights.get(today);
      if (!w || w.source === 'manuale') await db.weights.put({ date: today, kg: profile.weightKg, source: 'manuale' });
    });
    await setSetting('onboarding.done', true);
    navigate('/');
  };

  const later = async () => {
    await setSetting('onboarding.skipped', true);
    navigate('/');
  };

  return (
    <main className="onb">
      <div className="split">
        {step > 0 ? (
          <button type="button" className="icon-btn" onClick={() => setStep(step - 1)} aria-label="Indietro">
            <ArrowLeft size={22} />
          </button>
        ) : (
          <span />
        )}
        {!existing && step === 0 && (
          <button type="button" className="btn btn--ghost" onClick={later}>
            Più tardi
          </button>
        )}
      </div>
      <Corsia label={`Passo ${step + 1} di ${STEPS}`} value={step + 1} target={STEPS} max={STEPS} compact format={(n) => String(n)} />

      <div className="onb-body">
        {step === 0 && (
          <>
            <h1 className="onb-q">Partiamo da te.</h1>
            <p className="muted">Servono per calcolare il metabolismo. Restano sul telefono.</p>
            <label className="field">
              <span className="field-label">Nome (facoltativo)</span>
              <input className="input" value={d.name} onChange={(e) => set('name', e.target.value)} autoComplete="given-name" />
            </label>
            <div className="field">
              <span className="field-label">Sesso biologico</span>
              <div className="seg" role="group" aria-label="Sesso biologico">
                {(['M', 'F'] as Sex[]).map((s) => (
                  <button key={s} type="button" aria-pressed={d.sex === s} onClick={() => set('sex', s)}>
                    {s === 'M' ? 'Uomo' : 'Donna'}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span className="field-label">Data di nascita</span>
              <input className="input" type="date" value={d.birthDate} max={todayISO()} onChange={(e) => set('birthDate', e.target.value)} required />
              {!birthOk && d.birthDate !== '' && <span className="field-hint">Controlla la data.</span>}
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="onb-q">Altezza e peso.</h1>
            <p className="muted">Il peso di oggi diventa il primo punto della tendenza.</p>
            <div className="field">
              <span className="field-label">Altezza</span>
              <Stepper big label="Altezza" value={d.heightCm} onChange={(v) => set('heightCm', v)} step={1} min={130} max={220} unit="cm" />
            </div>
            <div className="field">
              <span className="field-label">Peso</span>
              <Stepper big label="Peso" value={d.weightKg} onChange={(v) => set('weightKg', v)} step={0.1} dragStep={0.1} min={35} max={200} unit="kg" format={fmt1} />
            </div>
            <label className="field">
              <span className="field-label">Massa grassa in % (se la conosci)</span>
              <input className="input" inputMode="decimal" placeholder="es. 18,5" value={fatText} onChange={(e) => setFatText(e.target.value)} />
              <span className="field-hint">
                {fatOk ? 'Solo da una misura affidabile (plicometria, DEXA). Altrimenti lascia vuoto.' : 'Scrivi un numero tra 3 e 60, oppure lascia vuoto.'}
              </span>
            </label>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="onb-q">Cosa vuoi ottenere?</h1>
            <div className="choice-list">
              <Choice<Goal> value="massa" current={d.goal} onPick={(v) => set('goal', v)} title="Più muscolo" sub="Leggero surplus calorico, crescita lenta e pulita" />
              <Choice<Goal> value="ricomposizione" current={d.goal} onPick={(v) => set('goal', v)} title="Ricomposizione" sub="Calorie di mantenimento: meno grasso, più muscolo" />
              <Choice<Goal> value="mantenimento" current={d.goal} onPick={(v) => set('goal', v)} title="Mantenere" sub="Stesso peso, mangiare meglio" />
              <Choice<Goal> value="definizione" current={d.goal} onPick={(v) => set('goal', v)} title="Perdere grasso" sub="Deficit moderato, proteine alte" />
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="onb-q">Come ti alleni.</h1>
            <div className="field">
              <span className="field-label">Esperienza in palestra</span>
              <div className="choice-list">
                <Choice<Experience> value="nuovo" current={d.experience} onPick={(v) => set('experience', v)} title="Ho appena iniziato" />
                <Choice<Experience> value="meno-6-mesi" current={d.experience} onPick={(v) => set('experience', v)} title="Meno di 6 mesi" />
                <Choice<Experience> value="6-24-mesi" current={d.experience} onPick={(v) => set('experience', v)} title="Da 6 mesi a 2 anni" />
                <Choice<Experience> value="oltre-2-anni" current={d.experience} onPick={(v) => set('experience', v)} title="Più di 2 anni" />
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <span className="field-label">Palestra a settimana</span>
                <Stepper label="Giorni di palestra" value={d.gymDaysPerWeek} onChange={(v) => set('gymDaysPerWeek', v)} step={1} min={0} max={7} unit="giorni" />
              </div>
              <div className="field">
                <span className="field-label">Corsa a settimana</span>
                <Stepper label="Giorni di corsa" value={d.runDaysPerWeek} onChange={(v) => set('runDaysPerWeek', v)} step={1} min={0} max={7} unit="giorni" />
              </div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1 className="onb-q">La tua giornata, sport escluso.</h1>
            <div className="choice-list">
              <Choice<DailyActivity> value="sedentario" current={d.dailyActivity} onPick={(v) => set('dailyActivity', v)} title="Seduto quasi tutto il giorno" sub="Studio o ufficio, pochi spostamenti a piedi" />
              <Choice<DailyActivity> value="leggero" current={d.dailyActivity} onPick={(v) => set('dailyActivity', v)} title="Misto" sub="Scrivania, ma cammini o vai in bici" />
              <Choice<DailyActivity> value="moderato" current={d.dailyActivity} onPick={(v) => set('dailyActivity', v)} title="Molto in piedi" sub="Negozio, sala, lavoro in movimento" />
              <Choice<DailyActivity> value="attivo" current={d.dailyActivity} onPick={(v) => set('dailyActivity', v)} title="Lavoro fisico" sub="Cantiere, magazzino, consegne" />
            </div>
            <div className="field">
              <span className="field-label">Pasti al giorno</span>
              <Stepper label="Pasti al giorno" value={Math.min(5, d.mealsPerDay)} onChange={(v) => set('mealsPerDay', v)} step={1} min={2} max={5} unit="pasti" />
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h1 className="onb-q">Cosa mangi e cosa no.</h1>
            <div className="field">
              <span className="field-label">Alimentazione</span>
              <div className="seg" role="group" aria-label="Alimentazione">
                {(['onnivora', 'pescetariana', 'vegetariana', 'vegana'] as DietStyle[]).map((s) => (
                  <button key={s} type="button" aria-pressed={d.diet === s} onClick={() => set('diet', s)}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">Allergie o intolleranze</span>
              <div className="chips">
                {ALLERGIE.map((a) => {
                  const on = d.allergies.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      onClick={() => set('allergies', on ? d.allergies.filter((x) => x !== a) : [...d.allergies, a])}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="field">
              <span className="field-label">Cibi che non mangi</span>
              <input className="input" placeholder="es. fegato, funghi" value={excluded} onChange={(e) => setExcluded(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Orari e abitudini</span>
              <textarea
                className="textarea"
                placeholder="es. pranzo fuori in settimana, palestra alle 18:30, budget spesa 60 € a settimana"
                value={d.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </label>
          </>
        )}

        {step === 6 && (
          <>
            <h1 className="onb-q">Il Garmin.</h1>
            <div className="stack">
              <p>Foro legge i dati del tuo Venu 4 dall'API personale ufficiale di Garmin, in sola lettura.</p>
              <p>Garmin non permette di chiamarla dal telefono: una GitHub Action li scarica ogni 3 ore e li pubblica cifrati con una password che scegli tu.</p>
              <p>Si configura una volta da Profilo, servono 10 minuti. Intanto puoi importare i file FIT a mano.</p>
            </div>
          </>
        )}
      </div>

      <div className="stack-sm">
        {step < STEPS - 1 ? (
          <button type="button" className="btn btn--primary btn--lg btn--block" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Avanti
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--lg btn--block" onClick={finish}>
            {existing ? 'Salva il profilo' : 'Calcola i miei obiettivi'}
          </button>
        )}
      </div>
    </main>
  );
}
