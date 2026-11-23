import { Link, useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { Barbell, PencilSimple, PersonSimpleRun } from '@phosphor-icons/react';
import { db } from '@/db/db';
import type { Program, WorkoutTemplate } from '@/db/types';
import { useProfile } from '@/app/hooks';
import { Corsia } from '@/components/Corsia';
import { useToast } from '@/components/ui';
import { createProgramFromStarter, listStarters } from '@/lib/training/templates';
import { plannedWeeklyVolume } from '@/lib/training/volume';
import { getExercise } from '@/lib/training/library';
import { todayISO } from '@/lib/dates';
import { fmtClock } from '@/lib/format';

export const DAYS = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];

export async function activateProgram(id: string) {
  await db.transaction('rw', db.programs, async () => {
    const all = await db.programs.toArray();
    for (const p of all) if (p.active !== (p.id === id)) await db.programs.update(p.id, { active: p.id === id, updatedAt: new Date().toISOString() });
  });
}

export async function createFromStarter(starterId: string): Promise<string> {
  const { program, templates } = createProgramFromStarter(starterId, { startDate: todayISO(), active: false });
  await db.transaction('rw', db.programs, db.templates, async () => {
    await db.programs.add(program);
    await db.templates.bulkAdd(templates);
  });
  await activateProgram(program.id);
  return program.id;
}

export function templateSummary(t: WorkoutTemplate): string {
  if (t.kind === 'corsa') {
    const r = t.run;
    return [r?.targetMinutes ? `${r.targetMinutes} min` : '', r?.zone ? `zona ${r.zone}` : '', r?.type ?? ''].filter(Boolean).join(' · ');
  }
  const sets = t.exercises.reduce((a, e) => a + e.sets.filter((s) => s.type !== 'riscaldamento').length, 0);
  return `${t.exercises.length} esercizi · ${sets} serie`;
}

/** Durata stimata di una seduta di pesi: recuperi più circa 40 secondi a serie, arrotondata a 5 minuti. */
export function estimateMinutes(t: WorkoutTemplate): number {
  const sec = t.exercises.reduce((a, e) => a + e.sets.reduce((b, s) => b + s.restSec + 40, 0), 0);
  return Math.max(5, Math.round(sec / 60 / 5) * 5);
}

export function exerciseLine(pe: WorkoutTemplate['exercises'][number]): string {
  const work = pe.sets.filter((s) => s.type !== 'riscaldamento');
  const s0 = work[0] ?? pe.sets[0];
  if (!s0) return '';
  const reps = s0.reps[0] === s0.reps[1] ? `${s0.reps[0]}` : `${s0.reps[0]}-${s0.reps[1]}`;
  return `${work.length}×${reps} · rec ${fmtClock(s0.restSec)}${s0.rpe ? ` · RPE ${String(s0.rpe).replace('.', ',')}` : ''}`;
}

export function PlanTab() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const profile = useProfile();
  const programs = useLiveQuery(() => db.programs.toArray(), []);
  const active = programs?.find((p) => p.active);
  const templates = useLiveQuery(() => (active ? db.templates.where('programId').equals(active.id).sortBy('order') : []), [active?.id]);

  if (!programs || templates === undefined) return null;

  if (!active) {
    return (
      <div className="stack" style={{ gap: 'var(--s-6)' }}>
        <p>Scegli una scheda di partenza: poi la modifichi come vuoi.</p>
        {listStarters().map((s) => (
          <div key={s.id} className="panel">
            <h3>{s.name}</h3>
            <p className="small muted">{s.description}</p>
            <p className="small num">
              {s.gymDaysPerWeek} sedute di pesi e {s.runDaysPerWeek} corse a settimana · scarico ogni {s.deloadEvery} settimane
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={async () => {
                const id = await createFromStarter(s.id);
                toast('Scheda attivata.');
                navigate(`/allenamento/scheda/${encodeURIComponent(id)}`);
              }}
            >
              Usa questa scheda
            </button>
          </div>
        ))}
        {programs.length > 0 && <OtherPrograms programs={programs} />}
        {profile && profile.experience === 'nuovo' && (
          <p className="xs muted">Per chi inizia: full body 3 volte a settimana per 8-12 settimane, poi si passa a superiore/inferiore.</p>
        )}
      </div>
    );
  }

  // chi inizia cresce già con 6-10 serie a settimana per muscolo; con più esperienza servono 10-12
  const beginner = !profile || profile.experience === 'nuovo' || profile.experience === 'meno-6-mesi';
  const limits = beginner ? { min: 6, max: 12 } : { min: 10, max: 12 };
  const vol = plannedWeeklyVolume(templates, { gymDaysPerWeek: profile?.gymDaysPerWeek, ...limits });
  const worked = vol.muscles.filter((m) => m.sets > 0);

  return (
    <div className="stack" style={{ gap: 'var(--s-8)' }}>
      <section className="section">
        <div className="section-head">
          <h2>{active.name}</h2>
          <Link href={`/allenamento/scheda/${encodeURIComponent(active.id)}`} className="btn btn--ghost">
            <PencilSimple size={18} /> Modifica
          </Link>
        </div>
        <div className="list">
          {templates.map((t) => (
            <div key={t.id} className="row">
              {t.kind === 'corsa' ? <PersonSimpleRun size={22} className="row-icon" /> : <Barbell size={22} className="row-icon" />}
              <div className="row-main">
                <span className="row-title">{t.name}</span>
                <span className="row-sub">
                  {t.dayOfWeek !== undefined ? `${DAYS[t.dayOfWeek]} · ` : ''}
                  {templateSummary(t)}
                </span>
              </div>
              {t.kind === 'forza' && (
                <button type="button" className="btn" onClick={() => navigate(`/palestra?t=${encodeURIComponent(t.id)}`)}>
                  Inizia
                </button>
              )}
            </div>
          ))}
        </div>
        {active.notes && <p className="small muted">{active.notes}</p>}
      </section>

      {worked.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Serie a settimana per muscolo</h2>
          </div>
          <p className="small muted">
            {beginner
              ? 'La tacca è a 6 serie: per chi inizia bastano 6-10 serie a settimana per muscolo, poi si sale piano.'
              : "La tacca è a 10 serie, l'inizio dell'intervallo consigliato (10-12)."}
          </p>
          {worked.map((m) => (
            <Corsia
              key={m.muscle}
              compact
              label={m.muscle.charAt(0).toUpperCase() + m.muscle.slice(1)}
              value={m.sets}
              target={limits.min}
              format={(n) => String(Math.round(n * 2) / 2).replace('.', ',')}
              color={m.level === 'basso' ? 'var(--warn)' : undefined}
            />
          ))}
          {vol.unknownExercises.length > 0 && <p className="xs muted">Non contati: {vol.unknownExercises.map((id) => getExercise(id)?.name ?? id).join(', ')}.</p>}
        </section>
      )}

      <OtherPrograms programs={programs.filter((p) => !p.active)} />
    </div>
  );
}

function OtherPrograms({ programs }: { programs: Program[] }) {
  const toast = useToast();
  if (programs.length === 0) return null;
  return (
    <section className="section">
      <h2>Altre schede</h2>
      <div className="list">
        {programs.map((p) => (
          <div key={p.id} className="row">
            <div className="row-main">
              <span className="row-title">{p.name}</span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await activateProgram(p.id);
                toast(`${p.name}: attiva.`);
              }}
            >
              Attiva
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
