import Dexie, { type EntityTable } from 'dexie';
import type {
  Activity,
  BodyMeasure,
  Exercise,
  FoodItem,
  FoodLogEntry,
  GymSession,
  Profile,
  Program,
  SavedMeal,
  SettingsKV,
  WeightEntry,
  WellnessDay,
  WorkoutTemplate,
} from './types';

/**
 * Database locale (IndexedDB). Tutti i dati personali vivono qui, sul dispositivo.
 * Per cambiare lo schema: aggiungere una nuova `version(n)` con `upgrade`, mai modificare quelle esistenti.
 */
export class AppDB extends Dexie {
  profile!: EntityTable<Profile, 'id'>;
  foods!: EntityTable<FoodItem, 'id'>;
  foodLog!: EntityTable<FoodLogEntry, 'id'>;
  savedMeals!: EntityTable<SavedMeal, 'id'>;
  weights!: EntityTable<WeightEntry, 'date'>;
  measures!: EntityTable<BodyMeasure, 'id'>;
  exercises!: EntityTable<Exercise, 'id'>;
  programs!: EntityTable<Program, 'id'>;
  templates!: EntityTable<WorkoutTemplate, 'id'>;
  sessions!: EntityTable<GymSession, 'id'>;
  activities!: EntityTable<Activity, 'id'>;
  wellness!: EntityTable<WellnessDay, 'date'>;
  settings!: EntityTable<SettingsKV, 'key'>;

  constructor(name = 'app-palestra') {
    super(name);
    this.version(1).stores({
      profile: 'id',
      // alimenti personalizzati e prodotti da codice a barre (il database base è un file statico)
      foods: 'id, name, barcode, source',
      foodLog: '++id, date, slot, [date+slot]',
      savedMeals: '++id, name, uses',
      weights: 'date',
      measures: '++id, date',
      exercises: 'id, name',
      programs: 'id, active',
      templates: 'id, programId, order',
      sessions: '++id, date, templateId, programId',
      activities: 'id, start, kind',
      wellness: 'date',
      settings: 'key',
    });
  }
}

export const db = new AppDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
