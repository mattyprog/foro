/**
 * Tipi condivisi dei moduli di allenamento.
 *
 * Per salvare lo stato della modalità palestra dentro `GymSession` senza toccare il contratto dati,
 * la seduta porta una proprietà opzionale `foro` (retrocompatibile: Dexie la salva com'è e chi non
 * la conosce la ignora):
 *   - `foro.modo`: tipo di seduta (normale, leggera, scarico); resta anche a seduta chiusa, così le
 *     sedute di scarico non falsano la progressione dei carichi;
 *   - `foro.live`: stato completo per la ripresa; sparisce alla chiusura (`endedAt` valorizzato).
 */
import type { GymSession, ISODate, LoggedSet, SetType } from '../../db/types';

export type SessionMode = 'normale' | 'leggero' | 'scarico';

/** Istanti sempre in millisecondi epoch dentro lo stato: sopravvivono a chiusura e riavvio dell'app. */
export interface SessionSet {
  /** Chiave unica nella seduta ('s1', 's2' ...). */
  key: string;
  type: SetType;
  /** 'piano' = prevista dalla scheda; 'aggiunta' = aggiunta al volo. */
  origin: 'piano' | 'aggiunta';
  repsMin: number;
  repsMax: number;
  rpeTarget?: number;
  restSec: number;
  kg?: number;
  reps?: number;
  rpe?: number;
  note?: string;
  done: boolean;
  doneAt?: number;
  /** Stessa serie dell'ultima volta (se esiste). */
  previous?: { kg: number; reps: number; rpe?: number };
  suggestion?: { kg?: number; repsTarget: number; motivo: string };
}

export interface SessionExercise {
  /** Chiave unica nella seduta ('e1', 'e2' ...). */
  key: string;
  exerciseId: string;
  /** Esercizio previsto dalla scheda, se questo lo ha sostituito. */
  replacedExerciseId?: string;
  origin: 'piano' | 'aggiunto';
  skipped: boolean;
  progression: 'doppia' | 'lineare' | 'rpe' | 'nessuna';
  incrementKg: number;
  supersetGroup?: string;
  note?: string;
  /** Riga riassuntiva del suggerimento di progressione (una riga). */
  motivo?: string;
  /** Esercizio fermo da più sedute (segnale per proporre lo scarico). */
  stalled?: boolean;
  /** Ultima volta: data (se nota) e serie fatte. */
  lastTime?: { date?: ISODate; sets: { kg: number; reps: number; rpe?: number }[] };
  sets: SessionSet[];
}

export interface RestTimer {
  startedAt: number;
  /** Istante di fine: l'unica cosa che conta, il timer si ricostruisce da questo e dall'orologio di sistema. */
  endsAt: number;
  durationSec: number;
  /** Serie dopo la quale è partito il recupero. */
  setKey?: string;
  /** Segnale dei 10 secondi già dato. */
  warned: boolean;
  /** Segnale di fine già dato. */
  finished: boolean;
}

/** Soglie di record dell'esercizio all'avvio della seduta (per riconoscere i nuovi record senza ricaricare lo storico). */
export interface RecordBaselineLite {
  count: number;
  bestKg?: number;
  bestRepsByKg: Record<string, number>;
  bestE1rm?: number;
}

export interface SessionState {
  v: 1;
  /** Id Dexie della seduta, noto dopo il primo salvataggio. */
  sessionId?: number;
  templateId?: string;
  programId?: string;
  name?: string;
  mode: SessionMode;
  startedAt: number;
  endedAt?: number;
  date: ISODate;
  /** Scarto del fuso in minuti usato per la data e per gli istanti ISO. */
  tzOffsetMin: number;
  note?: string;
  exercises: SessionExercise[];
  rest?: RestTimer;
  /** Per ogni esercizio, le soglie dei record prima di questa seduta. */
  baselines: Record<string, RecordBaselineLite>;
  /** Contatori per generare chiavi uniche e prevedibili. */
  counters: { exercise: number; set: number };
}

export interface ForoSessionMeta {
  v: 1;
  modo: SessionMode;
  live?: SessionState;
}

/** GymSession come la salva la modalità palestra: contratto dati + estensione `foro`. */
export type PersistedGymSession = GymSession & { foro?: ForoSessionMeta };

/** Serie fatte per esercizio, dalla seduta più recente alla più vecchia. */
export type HistoryByExercise = Record<string, LoggedSet[][]>;
