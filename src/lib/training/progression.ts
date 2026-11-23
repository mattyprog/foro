/**
 * Progressione dei carichi: doppia (default), lineare, a RPE o nessuna.
 *
 * Doppia progressione (il metodo di Foro):
 * - intervallo di ripetizioni 6-10 sui multiarticolari, 10-15 sui complementari;
 * - quando TUTTE le serie allenanti arrivano al massimo con RPE <= 8 (un RPE non registrato non blocca)
 *   il carico sale (+2,5 kg di base; sui carichi leggeri vale il passo piccolo dell'esercizio)
 *   e si riparte dal minimo dell'intervallo;
 * - se per 2 sedute di fila una serie non arriva al minimo il carico scende del 10%,
 *   arrotondato al disco disponibile (passo 1,25 kg per il bilanciere, 1 o 2 kg per i manubri);
 * - altrimenti stesso carico e una ripetizione in più per serie (5 secondi negli esercizi a tempo).
 *
 * Lo `history` è l'elenco delle ultime sedute di quell'esercizio, DALLA PIU' RECENTE: `history[0]` è l'ultima.
 * Si ottiene da `historyForExercise` (records.ts), che esclude già le sedute di scarico.
 *
 * Caratteristiche degli esercizi: a corpo libero il carico è la zavorra aggiunta (0 = solo corpo),
 * nelle macchine assistite il carico è l'aiuto (per progredire si scende), a tempo le ripetizioni sono secondi.
 */
import type { Exercise, LoggedSet, PlannedExercise, SetType } from '../../db/types';
import { fmtKg, fmtNum, roundToStep } from './format';
import { isAssisted, isTimed } from './library';
import { isWorkingSet } from './records';
import type { SessionMode } from './types';

export type ProgressionAction =
  | 'prima-volta'
  | 'sali-carico'
  | 'aumenta-ripetizioni'
  | 'mantieni'
  | 'riduci-carico'
  | 'scendi-leggero'
  | 'massimo-raggiunto'
  | 'scarico';

export interface SetSuggestion {
  /** Posizione della serie nella scheda (`PlannedExercise.sets`). */
  index: number;
  type: SetType;
  /** Carico suggerito; undefined se non si può sapere (prima volta). */
  kg?: number;
  /** Ripetizioni obiettivo (secondi negli esercizi a tempo). */
  repsTarget: number;
  /** Una riga in italiano che spiega il suggerimento. */
  motivo: string;
}

export interface Evaluation {
  suggestions: SetSuggestion[];
  action: ProgressionAction;
  /** Riga riassuntiva per l'esercizio. */
  motivo: string;
  /** Nessun miglioramento nelle ultime 3 sedute. */
  stalled: boolean;
  /** Sedute consecutive (dalla più recente) con almeno una serie sotto il minimo. */
  consecutiveMisses: number;
  sessionsConsidered: number;
}

export interface SuggestOptions {
  /** normale, leggero (serie -1/3, niente aumenti) o scarico (serie -50%, carico -10%). */
  mode?: SessionMode;
  /** RPE massimo per poter salire di carico (default 8). */
  maxRpe?: number;
  /** Passo di arrotondamento del bilanciere in kg (default 1,25). */
  barbellStepKg?: number;
  /** Sedute senza progressi per parlare di stallo (default 3). */
  stallSessions?: number;
  /**
   * Falso: tiene tutte le serie anche in 'leggero' e 'scarico' (le serie sono già state ridotte altrove,
   * per esempio in una sostituzione al volo); i carichi seguono comunque il modo. Default vero.
   */
  reduceSets?: boolean;
}

export const DEFAULT_BARBELL_STEP_KG = 1.25;
const LIGHT_TOTAL_KG = 5;
const LIGHT_DUMBBELL_KG = 10;
const DELOAD_LOAD_FACTOR = 0.1;

/* ----------------------------------------------------------------- Carichi */

/** Passo con cui si arrotondano i carichi di questo esercizio. */
export function loadStep(exercise: Exercise, kg: number, barbellStepKg = DEFAULT_BARBELL_STEP_KG): number {
  switch (exercise.equipment) {
    case 'bilanciere':
    case 'multipower':
      return barbellStepKg;
    case 'manubri':
      return kg < LIGHT_DUMBBELL_KG ? 1 : 2;
    case 'kettlebell':
      return 2;
    default: {
      const own = exercise.defaultIncrementKg;
      return own && own > 0 ? own : 2.5;
    }
  }
}

/** Carico ridotto del 10% (di default), arrotondato al passo e comunque di almeno un passo più basso. */
export function reduceLoad(kg: number, exercise: Exercise, pct = DELOAD_LOAD_FACTOR, barbellStepKg?: number): number {
  if (!(kg > 0)) return 0;
  const step = loadStep(exercise, kg, barbellStepKg);
  let r = roundToStep(kg * (1 - pct), step);
  if (r >= kg) r = kg - step;
  return Math.max(0, r);
}

/** Aiuto aumentato del 10% nelle macchine assistite, di almeno un passo. */
function increaseAssistance(kg: number, exercise: Exercise, pct = DELOAD_LOAD_FACTOR): number {
  const step = loadStep(exercise, kg);
  let r = roundToStep(kg * (1 + pct), step);
  if (r <= kg) r = kg + step;
  return r;
}

/**
 * Incremento di carico: quello della scheda (o dell'esercizio se la scheda non lo dice).
 * Con carichi leggeri (meno di 5 kg in totale, o manubri e kettlebell sotto i 10 kg) non supera
 * il passo piccolo dell'esercizio (`defaultIncrementKg`).
 */
export function incrementFor(planned: Pick<PlannedExercise, 'incrementKg'>, exercise: Exercise, kg: number): number {
  const own = exercise.defaultIncrementKg;
  const base = planned.incrementKg > 0 ? planned.incrementKg : (own ?? 2.5);
  const handheld = exercise.equipment === 'manubri' || exercise.equipment === 'kettlebell';
  const light = kg < LIGHT_TOTAL_KG || (handheld && kg < LIGHT_DUMBBELL_KG);
  if (light && own !== undefined && own > 0) return Math.min(base, own);
  return base;
}

/** Quante serie allenanti restano: leggero toglie un terzo, scarico dimezza (sempre almeno una). */
export function setsForMode(workingSets: number, mode: SessionMode): number {
  if (workingSets <= 0) return 0;
  if (mode === 'leggero') return Math.max(1, Math.round((workingSets * 2) / 3));
  if (mode === 'scarico') return Math.max(1, Math.ceil(workingSets / 2));
  return workingSets;
}

/* ------------------------------------------------------------------ Stallo */

interface Score {
  bestKg: number;
  totalReps: number;
}

function scoreOf(sets: readonly LoggedSet[], assisted: boolean): Score {
  const kgs = sets.map((s) => s.kg);
  return {
    bestKg: assisted ? Math.min(...kgs) : Math.max(...kgs),
    totalReps: sets.reduce((a, s) => a + s.reps, 0),
  };
}

function improved(newer: Score, older: Score, assisted: boolean): boolean {
  const better = assisted ? newer.bestKg < older.bestKg : newer.bestKg > older.bestKg;
  return better || (newer.bestKg === older.bestKg && newer.totalReps > older.totalReps);
}

/**
 * Fermo: nelle ultime `sessions` (default 3) sedute nessuna ha migliorato la precedente
 * né nel carico né nelle ripetizioni totali.
 */
export function isStalled(
  history: readonly (readonly LoggedSet[])[],
  opts: { sessions?: number; assisted?: boolean } = {},
): boolean {
  const n = opts.sessions ?? 3;
  const sessions = history.map((h) => h.filter(isWorkingSet)).filter((h) => h.length > 0).slice(0, n);
  if (sessions.length < n) return false;
  const assisted = opts.assisted === true;
  for (let i = 0; i < n - 1; i++) {
    if (improved(scoreOf(sessions[i], assisted), scoreOf(sessions[i + 1], assisted), assisted)) return false;
  }
  return true;
}

/* ----------------------------------------------------------- Suggerimenti */

interface Row {
  kg?: number;
  reps: number;
  motivo: string;
}

const bySetIndex = (a: LoggedSet, b: LoggedSet) => a.setIndex - b.setIndex;

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Calcola i suggerimenti per ogni serie e le informazioni di stallo e deload dell'esercizio. */
export function evaluateExercise(
  planned: PlannedExercise,
  history: readonly (readonly LoggedSet[])[],
  exercise: Exercise,
  opts: SuggestOptions = {},
): Evaluation {
  const mode = opts.mode ?? 'normale';
  const maxRpe = opts.maxRpe ?? 8;
  const barStep = opts.barbellStepKg ?? DEFAULT_BARBELL_STEP_KG;
  const timed = isTimed(exercise);
  const assisted = isAssisted(exercise);
  const bodyweight = exercise.equipment === 'corpo-libero' && !assisted;
  const repStep = timed ? 5 : 1;
  const unit = timed ? 'secondi' : 'ripetizioni';

  const plan = planned.sets.map((s, index) => ({ s, index, warm: (s.type ?? 'normale') === 'riscaldamento' }));
  const work = plan.filter((p) => !p.warm);
  const warms = plan.filter((p) => p.warm);
  const nWork = work.length;
  const rangeOf = (j: number): [number, number] => work[Math.min(j, nWork - 1)].s.reps;

  const sessions = history
    .map((h) => [...h].filter(isWorkingSet).sort(bySetIndex))
    .filter((h) => h.length > 0);
  const stalled = isStalled(sessions, { sessions: opts.stallSessions, assisted });

  // testi
  const lastText = (kg: number, reps: number): string => {
    if (timed) return `${fmtNum(reps)} secondi${kg > 0 ? ` con ${fmtKg(kg)}` : ''}`;
    if (assisted) return `${fmtKg(kg)} di aiuto × ${fmtNum(reps)}`;
    if (bodyweight && kg === 0) return `${fmtNum(reps)} ripetizioni`;
    return `${fmtKg(kg)} × ${fmtNum(reps)}`;
  };
  const tryText = (target: number): string => (timed ? `prova a tenere ${fmtNum(target)} secondi` : `prova a farne ${fmtNum(target)}`);

  let action: ProgressionAction;
  let rows: Row[] = [];
  let consecutiveMisses = 0;

  if (nWork > 0 && sessions.length === 0) {
    action = 'prima-volta';
    rows = work.map((w) => {
      const min = w.s.reps[0];
      let motivo: string;
      if (timed) motivo = `Prima volta: punta a ${fmtNum(min)} secondi con tecnica pulita.`;
      else if (assisted) motivo = `Prima volta: scegli un aiuto con cui fai ${fmtNum(min)} ripetizioni lasciandone 2 o 3 in riserva.`;
      else if (bodyweight) motivo = `Prima volta a corpo libero: punta a ${fmtNum(min)} ripetizioni.`;
      else motivo = `Prima volta: scegli un carico con cui fai ${fmtNum(min)} ripetizioni lasciandone 2 o 3 in riserva.`;
      return { kg: bodyweight ? 0 : undefined, reps: min, motivo };
    });
  } else if (nWork > 0) {
    const last = sessions[0];
    const ref = (j: number): LoggedSet => last[Math.min(j, last.length - 1)];
    const missed = (sess: LoggedSet[]) => sess.some((s, j) => s.reps < rangeOf(j)[0]);
    for (const sess of sessions) {
      if (!missed(sess)) break;
      consecutiveMisses++;
    }
    const rpeOk = (s: LoggedSet, limit = maxRpe) => s.rpe === undefined || s.rpe <= limit;
    const allAtMax = last.length >= nWork && work.every((_, j) => last[j].reps >= rangeOf(j)[1] && rpeOk(last[j]));
    const allRepsAtMax = last.length >= nWork && work.every((_, j) => last[j].reps >= rangeOf(j)[1]);

    // Doppia progressione: la base anche per RPE quando mancano i dati.
    const doppia = (prefix?: string): { rows: Row[]; action: ProgressionAction } => {
      const wrap = (t: string) => (prefix ? `${prefix}: ${lowerFirst(t)}` : t);
      if (allAtMax) {
        const first = ref(0);
        const inc = incrementFor(planned, exercise, first.kg);
        const noRoom = assisted ? first.kg <= 0 : inc <= 0 || (bodyweight && first.kg === 0);
        if (noRoom) {
          const text = assisted
            ? `Senza aiuto e a ${fmtNum(rangeOf(0)[1])} ripetizioni: aggiungi zavorra o prova una variante più difficile.`
            : `Hai raggiunto ${fmtNum(rangeOf(0)[1])} ${unit}${bodyweight ? ' a corpo libero' : ''}: prova una variante più difficile o aggiungi zavorra.`;
          return {
            action: 'massimo-raggiunto',
            rows: work.map((_, j) => ({ kg: ref(j).kg, reps: rangeOf(j)[1], motivo: wrap(text) })),
          };
        }
        return {
          action: 'sali-carico',
          rows: work.map((_, j) => {
            const r = ref(j);
            const [min, max] = rangeOf(j);
            const stepKg = incrementFor(planned, exercise, r.kg);
            const newKg = assisted ? Math.max(0, r.kg - stepKg) : r.kg + stepKg;
            const motivo = assisted
              ? `Tutte le serie a ${fmtNum(max)} ripetizioni: riduci l'aiuto a ${fmtKg(newKg)} e riparti da ${fmtNum(min)}.`
              : `Tutte le serie a ${fmtNum(max)} ${unit} con RPE ${fmtNum(maxRpe)} o meno: sali a ${fmtKg(newKg)} e riparti da ${fmtNum(min)}.`;
            return { kg: newKg, reps: min, motivo: wrap(motivo) };
          }),
        };
      }
      const out = work.map((_, j): Row => {
        const r = ref(j);
        const [min, max] = rangeOf(j);
        if (r.reps < min) {
          return {
            kg: r.kg,
            reps: min,
            motivo: wrap(`Ultima volta ${fmtNum(r.reps)} ${unit}, sotto le ${fmtNum(min)}: stesso carico, punta a ${fmtNum(min)}.`),
          };
        }
        if ((r.rpe ?? 0) >= 10) {
          return { kg: r.kg, reps: Math.min(r.reps, max), motivo: wrap(`Ultima volta era al limite (RPE 10): ripeti ${lastText(r.kg, r.reps)}.`) };
        }
        if (r.reps >= max) {
          const motivo = allRepsAtMax
            ? `Tutte le serie a ${fmtNum(max)} ${unit} ma con RPE oltre ${fmtNum(maxRpe)}: ripeti ${fmtKg(r.kg)} finché senti più margine.`
            : `Già a ${fmtNum(max)} ${unit}: tieni il carico e porta le altre serie al massimo.`;
          return { kg: r.kg, reps: max, motivo: wrap(motivo) };
        }
        const target = Math.min(max, r.reps + repStep);
        return { kg: r.kg, reps: target, motivo: wrap(`Ultima volta ${lastText(r.kg, r.reps)}: ${tryText(target)}.`) };
      });
      const up = out.some((row, j) => row.reps > ref(j).reps);
      return { action: up ? 'aumenta-ripetizioni' : 'mantieni', rows: out };
    };

    const reduce = (): Row[] =>
      work.map((_, j) => {
        const r = ref(j);
        const min = rangeOf(j)[0];
        const newKg = assisted ? increaseAssistance(r.kg, exercise) : reduceLoad(r.kg, exercise, DELOAD_LOAD_FACTOR, barStep);
        const motivo = assisted
          ? `Due sedute sotto le ${fmtNum(min)} ripetizioni: più aiuto, ${fmtKg(newKg)}, e riparti da ${fmtNum(min)}.`
          : `Due sedute sotto le ${fmtNum(min)} ${unit}: scendi del 10% a ${fmtKg(newKg)} e riparti da ${fmtNum(min)}.`;
        return { kg: newKg, reps: min, motivo };
      });

    if (consecutiveMisses >= 2 && planned.progression !== 'nessuna') {
      action = 'riduci-carico';
      rows = reduce();
    } else if (planned.progression === 'nessuna') {
      action = 'mantieni';
      rows = work.map((_, j) => {
        const r = ref(j);
        const [min, max] = rangeOf(j);
        return {
          kg: r.kg,
          reps: Math.max(min, Math.min(max, r.reps)),
          motivo: `Nessuna progressione prevista: ripeti ${lastText(r.kg, r.reps)}.`,
        };
      });
    } else if (planned.progression === 'lineare') {
      const done = last.length >= nWork && work.every((_, j) => last[j].reps >= rangeOf(j)[0]);
      if (done) {
        action = 'sali-carico';
        rows = work.map((_, j) => {
          const r = ref(j);
          const inc = incrementFor(planned, exercise, r.kg);
          const newKg = assisted ? Math.max(0, r.kg - inc) : r.kg + inc;
          return {
            kg: newKg,
            reps: rangeOf(j)[0],
            motivo: assisted
              ? `Hai completato tutte le ripetizioni: riduci l'aiuto a ${fmtKg(newKg)}.`
              : `Hai completato tutte le ripetizioni: aggiungi ${fmtKg(inc)} e vai a ${fmtKg(newKg)}.`,
          };
        });
      } else {
        action = 'mantieni';
        rows = work.map((_, j) => {
          const r = ref(j);
          return {
            kg: r.kg,
            reps: rangeOf(j)[0],
            motivo: `Ripetizioni non tutte completate: ripeti ${fmtKg(r.kg)} e punta a ${fmtNum(rangeOf(j)[0])}.`,
          };
        });
      }
    } else if (planned.progression === 'rpe') {
      const withRpe = last.filter((s) => s.rpe !== undefined).length;
      if (withRpe < Math.ceil(last.length / 2)) {
        const d = doppia('Senza RPE registrato');
        action = d.action;
        rows = d.rows;
      } else {
        const avg = mean(last.filter((s) => s.rpe !== undefined).map((s) => s.rpe as number));
        const target = mean(work.map((w) => w.s.rpe ?? 8));
        const diff = target - avg;
        const belowMin = last.some((s, j) => s.reps < rangeOf(j)[0]);
        if (diff >= 1 && !belowMin) {
          action = 'sali-carico';
          rows = work.map((_, j) => {
            const r = ref(j);
            const newKg = assisted ? Math.max(0, r.kg - incrementFor(planned, exercise, r.kg)) : r.kg + incrementFor(planned, exercise, r.kg);
            const [min, max] = rangeOf(j);
            return {
              kg: newKg,
              reps: Math.max(min, Math.min(max, r.reps)),
              motivo: `RPE medio ${fmtNum(avg, 1)} su un obiettivo di ${fmtNum(target, 1)}: troppo facile, ${assisted ? "riduci l'aiuto a" : 'sali a'} ${fmtKg(newKg)}.`,
            };
          });
        } else if (diff <= -1) {
          action = 'scendi-leggero';
          rows = work.map((_, j) => {
            const r = ref(j);
            const inc = incrementFor(planned, exercise, r.kg);
            const newKg = assisted ? r.kg + inc : Math.max(0, r.kg - inc);
            const [min, max] = rangeOf(j);
            return {
              kg: newKg,
              reps: Math.max(min, Math.min(max, r.reps)),
              motivo: `RPE medio ${fmtNum(avg, 1)} su un obiettivo di ${fmtNum(target, 1)}: più duro del previsto, ${assisted ? 'più aiuto,' : 'scendi a'} ${fmtKg(newKg)}.`,
            };
          });
        } else {
          const d = doppia();
          action = d.action;
          rows = d.rows;
        }
      }
    } else {
      const d = doppia();
      action = d.action;
      rows = d.rows;
    }

    // Seduta leggera: niente aumenti di carico, si tiene quello dell'ultima volta.
    if (mode === 'leggero' && (action === 'sali-carico' || action === 'massimo-raggiunto')) {
      action = 'mantieni';
      rows = work.map((_, j) => {
        const r = ref(j);
        return { kg: r.kg, reps: Math.min(r.reps, rangeOf(j)[1]), motivo: `tieni ${lastText(r.kg, r.reps)} e rimanda l'aumento di carico.` };
      });
    }
    // Scarico: si parte dall'ultimo carico svolto, non da quello che sarebbe salito.
    if (mode === 'scarico') {
      action = 'scarico';
      rows = work.map((_, j) => {
        const r = ref(j);
        const [min, max] = rangeOf(j);
        const newKg = assisted ? increaseAssistance(r.kg, exercise) : reduceLoad(r.kg, exercise, DELOAD_LOAD_FACTOR, barStep);
        return {
          kg: newKg,
          reps: Math.max(min, Math.min(max, r.reps)),
          motivo: assisted ? `più aiuto (${fmtKg(newKg)}), con tante ripetizioni di riserva.` : `carico ridotto del 10% (${fmtKg(newKg)}), con 3 o 4 ripetizioni di riserva.`,
        };
      });
    }
  } else {
    action = 'mantieni';
  }

  // Riduzione delle serie per i modi leggero e scarico.
  const keep = opts.reduceSets === false ? nWork : setsForMode(nWork, mode);
  const keptRows = rows.slice(0, keep);
  const keptWork = work.slice(0, keep);
  if (mode === 'scarico' && sessions.length === 0 && nWork > 0) {
    action = 'scarico';
    for (const r of keptRows) r.motivo = `Settimana di scarico: ${keep} ${keep === 1 ? 'serie leggera' : 'serie leggere'}, con 3 o 4 ripetizioni di riserva.`;
  }
  const prefixFor = (r: Row): string => {
    if (mode === 'scarico' && sessions.length > 0) return `Settimana di scarico, ${keep} ${keep === 1 ? 'serie' : 'serie'}: ${r.motivo}`;
    if (mode === 'leggero') return `Seduta leggera, ${keep} ${keep === 1 ? 'serie' : 'serie'}: ${lowerFirst(r.motivo)}`;
    return r.motivo;
  };

  // Suggerimenti in ordine di scheda: riscaldamenti calcolati sul carico della prima serie allenante.
  const firstKg = keptRows[0]?.kg;
  const fractions = (k: number, total: number): number => {
    const table: Record<number, number[]> = { 1: [0.5], 2: [0.4, 0.65], 3: [0.4, 0.6, 0.8] };
    if (table[total]) return table[total][k];
    return 0.4 + (0.4 * k) / Math.max(1, total - 1);
  };
  const suggestions: SetSuggestion[] = [];
  let w = 0;
  let wk = 0;
  for (const p of plan) {
    if (p.warm) {
      const frac = fractions(wk, warms.length);
      wk++;
      let kg: number | undefined;
      if (firstKg !== undefined) {
        if (assisted || firstKg === 0) kg = firstKg;
        else kg = Math.min(roundToStep(firstKg * frac, loadStep(exercise, firstKg, barStep)), Math.max(0, firstKg - loadStep(exercise, firstKg, barStep)));
      }
      suggestions.push({
        index: p.index,
        type: 'riscaldamento',
        kg,
        repsTarget: p.s.reps[0],
        motivo:
          kg !== undefined && kg > 0
            ? `Riscaldamento: circa il ${fmtNum(frac * 100, 0)}% del carico di lavoro, ${fmtKg(kg)}.`
            : 'Riscaldamento leggero: prepara le articolazioni prima delle serie di lavoro.',
      });
      continue;
    }
    if (w >= keptWork.length) continue;
    const row = keptRows[w];
    w++;
    const type = p.s.type ?? 'normale';
    suggestions.push({ index: p.index, type, kg: row.kg, repsTarget: row.reps, motivo: prefixFor(row) });
  }

  // Serie "drop": circa il 20% in meno della serie precedente.
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    if (s.type !== 'drop') continue;
    const prev = [...suggestions.slice(0, i)].reverse().find((x) => x.type !== 'riscaldamento' && x.kg !== undefined);
    if (prev && prev.kg !== undefined && prev.kg > 0 && !assisted) {
      const kg = roundToStep(prev.kg * 0.8, loadStep(exercise, prev.kg, barStep));
      suggestions[i] = { ...s, kg, motivo: `Serie drop: scendi a circa il 20% in meno, ${fmtKg(kg)}, e vai fino a poche ripetizioni dal limite.` };
    }
  }

  let motivo = suggestions.find((s) => s.type !== 'riscaldamento')?.motivo ?? 'Nessuna serie di lavoro in scheda.';
  if (stalled) motivo = `${motivo} Fermo da ${opts.stallSessions ?? 3} sedute: valuta un po' di riposo in più o lo scarico.`;

  return { suggestions, action, motivo, stalled, consecutiveMisses, sessionsConsidered: sessions.length };
}

/** Suggerimento per ogni serie della prossima seduta: `{ kg, repsTarget, motivo }` (più `index` e `type`). */
export function suggestNext(
  planned: PlannedExercise,
  history: readonly (readonly LoggedSet[])[],
  exercise: Exercise,
  opts: SuggestOptions = {},
): SetSuggestion[] {
  return evaluateExercise(planned, history, exercise, opts).suggestions;
}

/* ------------------------------------------------------------------ Scarico */

export interface DeloadInput {
  /** Esercizi fermi (da `Evaluation.stalled`). */
  stalledExercises?: number;
  weeksSinceDeload?: number;
  /** Ogni quante settimane uno scarico (`Program.deloadEvery`); senza indicazione 8. */
  deloadEvery?: number;
  /** Giorni consecutivi con semaforo giallo o rosso. */
  yellowDays?: number;
  /** Giorni consecutivi con HRV sotto il proprio intervallo. */
  hrvLowDays?: number;
}

export interface DeloadAdvice {
  suggest: boolean;
  reasons: string[];
  /** Una riga: i motivi uniti e l'invito. Vuota se non serve. */
  motivo: string;
}

/** Quando proporre una settimana di scarico (volume -50%, carico -10%). */
export function deloadAdvice(input: DeloadInput): DeloadAdvice {
  const reasons: string[] = [];
  if ((input.stalledExercises ?? 0) >= 2) reasons.push('Due o più esercizi sono fermi da qualche seduta.');
  const every = input.deloadEvery ?? 8;
  if (input.weeksSinceDeload !== undefined && input.weeksSinceDeload >= every) {
    reasons.push(`Sono passate ${fmtNum(input.weeksSinceDeload)} settimane dall'ultimo scarico.`);
  }
  if ((input.yellowDays ?? 0) >= 7) reasons.push('Il semaforo è giallo da una settimana.');
  if ((input.hrvLowDays ?? 0) >= 3) reasons.push('L\'HRV è sotto il tuo intervallo da 3 giorni.');
  return {
    suggest: reasons.length > 0,
    reasons,
    motivo: reasons.length > 0 ? `${reasons.join(' ')} Una settimana di scarico può aiutare.` : '',
  };
}
