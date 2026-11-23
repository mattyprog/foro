/**
 * Contratto dei dati condiviso da tutti i moduli (nutrizione, allenamento, Garmin, salute, UI).
 * Regole:
 * - Date locali come stringhe 'YYYY-MM-DD' (ISODate), istanti come ISO 8601 con offset (ISODateTime).
 * - Unità metriche: kg, cm, metri, secondi, kcal, grammi.
 * - Un dato che manca è `undefined`, mai 0 o un valore di ripiego.
 */

export type ISODate = string;
export type ISODateTime = string;

/* ------------------------------------------------------------------ Profilo */

export type Sex = 'M' | 'F';
export type Goal = 'massa' | 'ricomposizione' | 'mantenimento' | 'definizione';
export type Experience = 'nuovo' | 'meno-6-mesi' | '6-24-mesi' | 'oltre-2-anni';
/** Movimento fuori dagli allenamenti (lavoro, spostamenti). */
export type DailyActivity = 'sedentario' | 'leggero' | 'moderato' | 'attivo';
export type DietStyle = 'onnivora' | 'vegetariana' | 'pescetariana' | 'vegana';

export interface Profile {
  id: 'me';
  name?: string;
  sex: Sex;
  birthDate: ISODate;
  heightCm: number;
  /** Peso al momento della compilazione; il peso corrente vive in `weights`. */
  weightKg: number;
  bodyFatPct?: number;
  goal: Goal;
  experience: Experience;
  gymDaysPerWeek: number;
  runDaysPerWeek: number;
  dailyActivity: DailyActivity;
  mealsPerDay: number;
  diet: DietStyle;
  allergies: string[];
  excludedFoods: string[];
  /** Testo libero: orari, pranzo fuori, budget, condizioni di salute dichiarate. */
  notes?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/* ---------------------------------------------------------------- Nutrizione */

export interface Nutrients {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugars?: number;
  satFat?: number;
  salt?: number;
}

export type FoodSource = 'crea' | 'ciqual' | 'usda' | 'off' | 'ricetta' | 'utente' | 'ai';

/** Alimento del database: valori sempre per 100 g di parte edibile (o 100 ml). */
export interface FoodItem {
  id: string;
  name: string;
  aliases?: string[];
  category: string;
  per100g: Nutrients;
  source: FoodSource;
  /** Riferimento alla fonte (codice CREA/CIQUAL/USDA, URL, ricetta). */
  sourceRef?: string;
  portions?: { label: string; grams: number }[];
  barcode?: string;
  brand?: string;
  /** Piatto composto (ricetta): ingredienti in grammi per una porzione. */
  recipe?: { foodId: string; grams: number }[];
}

export type MealSlot = 'colazione' | 'spuntino' | 'pranzo' | 'merenda' | 'cena';
export type Confidence = 'alta' | 'media' | 'bassa';
export type LogMethod = 'foto' | 'barcode' | 'etichetta' | 'testo' | 'manuale' | 'ripeti';

export interface LoggedItem {
  foodId?: string;
  name: string;
  grams: number;
  /** Valori già calcolati per i grammi indicati. */
  nutrients: Nutrients;
  source: FoodSource;
  confidence?: Confidence;
  /** Intervallo plausibile dei grammi stimati dalla foto. */
  gramsRange?: [number, number];
}

export interface FoodLogEntry {
  id?: number;
  date: ISODate;
  /** 'HH:MM' locale. */
  time: string;
  slot: MealSlot;
  items: LoggedItem[];
  method: LogMethod;
  photoThumb?: Blob;
  note?: string;
  createdAt: ISODateTime;
}

/** Piatto salvato dall'utente per registrarlo di nuovo con un tocco. */
export interface SavedMeal {
  id?: number;
  name: string;
  items: LoggedItem[];
  uses: number;
  lastUsed?: ISODateTime;
}

export interface WeightEntry {
  date: ISODate;
  kg: number;
  source: 'manuale' | 'garmin';
  bodyFatPct?: number;
}

export interface BodyMeasure {
  id?: number;
  date: ISODate;
  waistCm?: number;
  chestCm?: number;
  armCm?: number;
  thighCm?: number;
  hipsCm?: number;
  note?: string;
}

/* -------------------------------------------------------------- Allenamento */

export type MuscleGroup =
  | 'petto' | 'dorsali' | 'spalle' | 'bicipiti' | 'tricipiti' | 'avambracci'
  | 'quadricipiti' | 'femorali' | 'glutei' | 'polpacci' | 'addome' | 'lombari'
  | 'trapezi' | 'adduttori';

export type Equipment =
  | 'bilanciere' | 'manubri' | 'macchina' | 'cavi' | 'corpo-libero'
  | 'kettlebell' | 'elastici' | 'multipower' | 'altro';

export interface Exercise {
  id: string;
  name: string;
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
  equipment: Equipment;
  /** Schema motorio, utile per le sostituzioni (es. 'spinta-orizzontale', 'squat', 'hinge'). */
  pattern: string;
  unilateral?: boolean;
  isCustom?: boolean;
  /** Indicazione tecnica in una riga. */
  cue?: string;
  /** Nomi/chiavi con cui Garmin registra l'esercizio, per abbinare le serie dell'orologio. */
  garminKeys?: string[];
  /** Incremento di carico tipico in kg. */
  defaultIncrementKg?: number;
  /** Altri nomi usati in palestra o in inglese, per la ricerca (es. 'lat machine', 'RDL'). */
  aliases?: string[];
  /** Esercizio a tempo: `reps` e `PlannedSet.reps` sono secondi (es. plank). */
  timed?: boolean;
  /** Macchina assistita: `kg` è l'aiuto, quindi per progredire si scende (es. trazioni assistite). */
  assisted?: boolean;
}

export type SetType = 'normale' | 'riscaldamento' | 'drop' | 'amrap';

export interface PlannedSet {
  /** Intervallo di ripetizioni, es. [8, 12]. */
  reps: [number, number];
  rpe?: number;
  restSec: number;
  type?: SetType;
}

export type ProgressionRule = 'doppia' | 'lineare' | 'rpe' | 'nessuna';

export interface PlannedExercise {
  exerciseId: string;
  sets: PlannedSet[];
  progression: ProgressionRule;
  incrementKg: number;
  note?: string;
  /** Id di un altro PlannedExercise della stessa seduta da alternare (superserie). */
  supersetGroup?: string;
}

export type RunType = 'facile' | 'lungo' | 'ripetute' | 'tempo' | 'progressivo' | 'recupero';

export interface RunPlan {
  type: RunType;
  targetMinutes?: number;
  targetKm?: number;
  /** Zona cardiaca prevalente 1-5. */
  zone?: 1 | 2 | 3 | 4 | 5;
  intervals?: { reps: number; workSec?: number; workM?: number; restSec: number; targetPace?: string }[];
  note?: string;
}

export interface WorkoutTemplate {
  id: string;
  programId: string;
  /** Es. "A · Spinta", "Corsa facile". */
  name: string;
  kind: 'forza' | 'corsa';
  /** Giorno suggerito 0 = lunedì … 6 = domenica. */
  dayOfWeek?: number;
  order: number;
  exercises: PlannedExercise[];
  run?: RunPlan;
}

export interface Program {
  id: string;
  name: string;
  active: boolean;
  startDate?: ISODate;
  /** Ogni quante settimane una settimana di scarico. */
  deloadEvery?: number;
  notes?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface LoggedSet {
  exerciseId: string;
  setIndex: number;
  kg: number;
  reps: number;
  rpe?: number;
  type?: SetType;
  done: boolean;
  ts?: ISODateTime;
  /** Nota libera sulla serie (modalità palestra). */
  note?: string;
}

export interface GymSession {
  id?: number;
  date: ISODate;
  templateId?: string;
  programId?: string;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  sets: LoggedSet[];
  note?: string;
  /** Attività Garmin abbinata (forza registrata dall'orologio). */
  activityId?: string;
}

/* ---------------------------------------------------- Attività (Garmin/FIT) */

export type ActivityKind = 'corsa' | 'forza' | 'camminata' | 'bici' | 'nuoto' | 'altro';

export interface Lap {
  distanceM?: number;
  durationSec: number;
  avgHr?: number;
  avgPaceSecPerKm?: number;
}

export interface Activity {
  /** 'garmin:<activityId>' oppure 'fit:<hash>' oppure 'manuale:<uuid>'. */
  id: string;
  source: 'garmin' | 'fit' | 'manuale';
  kind: ActivityKind;
  /** Chiave originale del tipo (es. 'running', 'strength_training'). */
  typeKey: string;
  name: string;
  start: ISODateTime;
  durationSec: number;
  movingSec?: number;
  distanceM?: number;
  avgHr?: number;
  maxHr?: number;
  calories?: number;
  elevGainM?: number;
  avgPaceSecPerKm?: number;
  avgCadence?: number;
  aerobicTE?: number;
  anaerobicTE?: number;
  trainingLoad?: number;
  /** Secondi in zona 1..5. */
  hrZonesSec?: number[];
  laps?: Lap[];
  /** Traccia semplificata [lat, lon]. */
  track?: [number, number][];
  /** Serie FC sottocampionata: [secondi dall'inizio, bpm]. */
  hrSeries?: [number, number][];
  /** Serie FC/passo per grafici: [secondi, secondi/km]. */
  paceSeries?: [number, number][];
  /** Serie di forza registrate dall'orologio. */
  exerciseSets?: { name: string; category?: string; reps?: number; kg?: number; durationSec?: number }[];
}

/* -------------------------------------------------------------- Benessere */

export interface WellnessDay {
  date: ISODate;
  source: 'garmin' | 'manuale';
  sleepSec?: number;
  sleepScore?: number;
  deepSec?: number;
  lightSec?: number;
  remSec?: number;
  awakeSec?: number;
  sleepStart?: ISODateTime;
  sleepEnd?: ISODateTime;
  hrvNightAvg?: number;
  hrvWeeklyAvg?: number;
  hrvBaselineLow?: number;
  hrvBaselineHigh?: number;
  hrvStatus?: string;
  restingHr?: number;
  stressAvg?: number;
  bodyBatteryHigh?: number;
  bodyBatteryLow?: number;
  bodyBatteryCharged?: number;
  bodyBatteryDrained?: number;
  steps?: number;
  activeKcal?: number;
  totalKcal?: number;
  spo2Avg?: number;
  respirationAvg?: number;
  vo2max?: number;
  fitnessAge?: number;
  hydrationMl?: number;
  /** Valutazione soggettiva 1-5 inserita dall'utente. */
  mood?: number;
  energy?: number;
  soreness?: number;
}

/* ---------------------------------------------------- Pacchetto di sync */

/** Contenuto (in chiaro) del pacchetto prodotto dalla GitHub Action di sync. */
export interface SyncBundle {
  version: 1;
  generatedAt: ISODateTime;
  range: { from: ISODate; to: ISODate };
  activities: Activity[];
  wellness: WellnessDay[];
  weights: WeightEntry[];
  /** Avvisi non bloccanti della sync (endpoint falliti, dati mancanti). */
  warnings: string[];
}

/** Busta cifrata pubblicata dalla Action: AES-256-GCM, chiave da PBKDF2-SHA256. */
export interface EncryptedEnvelope {
  v: 1;
  alg: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iter: number;
  /** base64 */
  salt: string;
  /** base64, 12 byte */
  iv: string;
  /** base64: gzip(JSON(SyncBundle)) cifrato, con tag GCM in coda. */
  ct: string;
  generatedAt: ISODateTime;
}

/* ---------------------------------------------------------- Impostazioni */

export interface SettingsKV {
  key: string;
  value: unknown;
}
