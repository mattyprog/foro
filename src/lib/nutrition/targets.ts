/**
 * Calcolo degli obiettivi giornalieri (calorie e macronutrienti) dal profilo.
 *
 * Metodo (posizioni ISSN 2017, Morton e al. 2018, Iraki e al. 2019):
 * - basale: Mifflin-St Jeor, oppure Katch-McArdle se e' nota la percentuale di grasso;
 * - dispendio = basale x fattore di attivita' fuori dagli allenamenti + esercizio stimato
 *   (palestra circa 4 kcal al minuto, corsa circa 1 kcal x kg x km), in media sulla settimana;
 * - obiettivo: massa +7,5% (5-10%), ricomposizione e mantenimento 0, definizione -15%;
 * - proteine 1,8 g/kg (1,6-2,2), grassi 0,9 g/kg (0,8-1, mai sotto 0,6 né sotto il 20% delle calorie), carboidrati il resto;
 * - nessun tipo di giorno sotto il metabolismo a riposo o sotto 130 g di carboidrati (se la media lo permette);
 * - giorni palestra, corsa e riposo: proteine e grassi uguali, si spostano i carboidrati
 *   mantenendo invariato il totale della settimana;
 * - pasti all'italiana con almeno 4 pasti da circa 0,4 g/kg di proteine.
 * Ogni numero ha una spiegazione breve (campo why) da mostrare nell'interfaccia.
 */
import type { DailyActivity, Goal, ISODate, MealSlot, Profile } from '@/db/types';
import { roundTo } from './nutrients';

export type DayType = 'palestra' | 'corsa' | 'riposo';

export type TargetProfile = Pick<
  Profile,
  | 'sex' | 'birthDate' | 'heightCm' | 'weightKg' | 'bodyFatPct' | 'goal' | 'experience'
  | 'gymDaysPerWeek' | 'runDaysPerWeek' | 'dailyActivity' | 'mealsPerDay'
>;

export interface Explained {
  value: number;
  why: string;
}

export interface MacroTargets {
  kcal: Explained;
  protein: Explained;
  carbs: Explained;
  fat: Explained;
}

export interface MealTarget {
  slot: MealSlot;
  /** Quota delle calorie del giorno (0-1). */
  share: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  why: string;
}

export interface DayTargets extends MacroTargets {
  type: DayType;
  meals: MealTarget[];
}

export interface Targets {
  age: number;
  bmr: Explained & { formula: 'mifflin-st-jeor' | 'katch-mcardle' };
  activityFactor: Explained;
  /** Esercizio stimato, kcal al giorno in media sulla settimana. */
  exercise: Explained;
  tdee: Explained & { measured: boolean };
  /** Surplus o deficit in percentuale sul dispendio. */
  adjustmentPct: Explained;
  /** Peso usato per proteine e grassi. */
  referenceWeightKg: Explained;
  /** Media della settimana. */
  average: MacroTargets;
  days: Record<DayType, DayTargets>;
  /** Crescita di peso obiettivo al mese (solo in massa). */
  monthlyGainKg?: Explained & { rangePct: [number, number] };
  notes: string[];
}

export interface TargetOptions {
  /** Data per il calcolo dell'eta' (default oggi). */
  today?: ISODate | Date;
  /** Peso attuale (tendenza delle pesate); default il peso del profilo. */
  weightKg?: number;
  /** Dispendio misurato dall'adattamento settimanale: sostituisce la stima. */
  tdeeKcal?: number;
  /** Surplus o deficit come frazione (0,075 = +7,5%), limitato all'intervallo dell'obiettivo. */
  adjustmentPct?: number;
  proteinGPerKg?: number;
  fatGPerKg?: number;
  /** Durata tipica di una seduta in palestra, minuti (default 60). */
  gymMinutes?: number;
  /** Chilometri tipici di una corsa (default 5). */
  runKm?: number;
  /** Taglio dei carboidrati nei giorni di riposo (default 0,125, intervallo 0,10-0,15). */
  restCarbCut?: number;
  /** Carboidrati minimi prima di abbassare i grassi (default 130 g). */
  minCarbsG?: number;
}

export const ACTIVITY_FACTORS: Record<DailyActivity, number> = {
  sedentario: 1.2,
  leggero: 1.35,
  moderato: 1.5,
  attivo: 1.65,
};

const ACTIVITY_LABEL: Record<DailyActivity, string> = {
  sedentario: 'sedentaria (lavoro seduto, pochi passi)',
  leggero: 'leggera (in piedi o a piedi parte del giorno)',
  moderato: 'moderata (molto in movimento)',
  attivo: 'alta (lavoro fisico)',
};

/** Intervallo [min, max, default] del surplus per obiettivo, come frazione del dispendio. */
export const GOAL_ADJUSTMENT: Record<Goal, [number, number, number]> = {
  massa: [0.05, 0.1, 0.075],
  ricomposizione: [0, 0, 0],
  mantenimento: [0, 0, 0],
  definizione: [-0.25, -0.1, -0.15],
};

export const GYM_KCAL_PER_MIN = 4;
export const RUN_KCAL_PER_KG_KM = 1;
export const PROTEIN_G_PER_KG: [number, number, number] = [1.6, 2.2, 1.8];
export const FAT_G_PER_KG: [number, number, number] = [0.8, 1, 0.9];
export const FAT_FLOOR_G_PER_KG = 0.6;
/** Quota minima delle calorie dai grassi (ISSN: 20-35%). */
export const FAT_MIN_SHARE = 0.2;
export const PROTEIN_PER_MEAL_G_PER_KG = 0.4;

/** Quote dei pasti all'italiana (somma 1). */
export const MEAL_SHARES: Record<MealSlot, number> = {
  colazione: 0.225,
  spuntino: 0.1,
  pranzo: 0.325,
  merenda: 0.1,
  cena: 0.25,
};

const MEALS_BY_COUNT: Record<number, MealSlot[]> = {
  1: ['pranzo'],
  2: ['pranzo', 'cena'],
  3: ['colazione', 'pranzo', 'cena'],
  4: ['colazione', 'pranzo', 'merenda', 'cena'],
  5: ['colazione', 'spuntino', 'pranzo', 'merenda', 'cena'],
};
/** Pasti che ricevono almeno 0,4 g/kg di proteine (i 4 principali). */
const PROTEIN_MEALS: MealSlot[] = ['colazione', 'pranzo', 'merenda', 'cena'];

/** Soglie oltre le quali proteine e grassi si calcolano su un peso di riferimento. */
const BMI_THRESHOLD = 27;
const BODY_FAT_THRESHOLD = { M: 25, F: 32 } as const;

/* ------------------------------------------------------------ formattazione */

const nf = new Map<number, Intl.NumberFormat>();
function fmt(x: number, decimals = 0): string {
  let f = nf.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('it-IT', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
    nf.set(decimals, f);
  }
  return f.format(roundTo(x, decimals));
}
const pct = (x: number, decimals = 1) => `${x > 0 ? '+' : ''}${fmt(x * 100, decimals)}%`;

/* ------------------------------------------------------------ formule */

export function ageOn(birthDate: ISODate, today: ISODate | Date = new Date()): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const t = typeof today === 'string' ? today : toISODate(today);
  const [ty, tm, td] = t.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

function toISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Mifflin-St Jeor: 10 x kg + 6,25 x cm - 5 x anni + 5 (uomo) o -161 (donna). */
export function bmrMifflin(p: { sex: 'M' | 'F'; weightKg: number; heightCm: number; age: number }): number {
  return 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'M' ? 5 : -161);
}

/** Katch-McArdle: 370 + 21,6 x massa magra (kg). */
export function bmrKatchMcArdle(weightKg: number, bodyFatPct: number): number {
  return 370 + 21.6 * weightKg * (1 - bodyFatPct / 100);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/* ------------------------------------------------------------ calcolo */

export function computeTargets(profile: TargetProfile, opts: TargetOptions = {}): Targets {
  const notes: string[] = [];
  const weight = opts.weightKg ?? profile.weightKg;
  const { heightCm, sex } = profile;
  if (!Number.isFinite(weight) || weight < 30 || weight > 300) throw new RangeError(`peso non valido: ${weight}`);
  if (!Number.isFinite(heightCm) || heightCm < 120 || heightCm > 230) throw new RangeError(`altezza non valida: ${heightCm}`);
  const age = ageOn(profile.birthDate, opts.today);
  if (!Number.isFinite(age) || age < 14 || age > 100) throw new RangeError(`età non valida: ${age}`);
  if (age < 18) notes.push('Le formule sono pensate per adulti: sotto i 18 anni chiedi a un medico o a un nutrizionista.');

  /* basale */
  const hasFat = typeof profile.bodyFatPct === 'number' && profile.bodyFatPct > 2 && profile.bodyFatPct < 60;
  const bmrRaw = hasFat ? bmrKatchMcArdle(weight, profile.bodyFatPct!) : bmrMifflin({ sex, weightKg: weight, heightCm, age });
  const bmr: Targets['bmr'] = hasFat
    ? {
        value: roundTo(bmrRaw, 0),
        formula: 'katch-mcardle',
        why: `Metabolismo a riposo con la formula di Katch-McArdle, dalla massa magra (${fmt(weight * (1 - profile.bodyFatPct! / 100), 1)} kg): ${fmt(bmrRaw)} kcal.`,
      }
    : {
        value: roundTo(bmrRaw, 0),
        formula: 'mifflin-st-jeor',
        why: `Metabolismo a riposo con la formula di Mifflin-St Jeor (peso, altezza, età e sesso): ${fmt(bmrRaw)} kcal.`,
      };

  /* attivita' ed esercizio */
  const factor = ACTIVITY_FACTORS[profile.dailyActivity];
  const activityFactor: Explained = {
    value: factor,
    why: `Attività ${ACTIVITY_LABEL[profile.dailyActivity]} fuori dagli allenamenti: basale x ${fmt(factor, 2)}.`,
  };
  const gymMin = opts.gymMinutes ?? 60;
  const runKm = opts.runKm ?? 5;
  const gymDays = clamp(Math.round(profile.gymDaysPerWeek), 0, 7);
  const runDays = clamp(Math.round(profile.runDaysPerWeek), 0, 7);
  const gymKcal = gymMin * GYM_KCAL_PER_MIN;
  const runKcal = RUN_KCAL_PER_KG_KM * weight * runKm;
  const exerciseRaw = (gymDays * gymKcal + runDays * runKcal) / 7;
  const exercise: Explained = {
    value: roundTo(exerciseRaw, 0),
    why:
      gymDays + runDays === 0
        ? 'Nessun allenamento previsto nel profilo.'
        : `Allenamenti in media al giorno: ${gymDays} sedute di palestra da ${fmt(gymKcal)} kcal (${gymMin} minuti x 4 kcal) ` +
          `e ${runDays} corse da ${fmt(runKcal)} kcal (${fmt(weight, 1)} kg x ${fmt(runKm, 1)} km), diviso 7 giorni.`,
  };

  /* dispendio */
  const tdeeEstimated = bmrRaw * factor + exerciseRaw;
  const measured = typeof opts.tdeeKcal === 'number' && Number.isFinite(opts.tdeeKcal) && opts.tdeeKcal > 0;
  const tdeeRaw = measured ? opts.tdeeKcal! : tdeeEstimated;
  const tdee: Targets['tdee'] = {
    value: roundTo(tdeeRaw, 0),
    measured,
    why: measured
      ? `Dispendio misurato dalle tue pesate e da quello che hai registrato: ${fmt(tdeeRaw)} kcal (la stima con le formule era ${fmt(tdeeEstimated)}).`
      : `Dispendio stimato: ${fmt(bmrRaw)} x ${fmt(factor, 2)} + ${fmt(exerciseRaw)} di allenamento = ${fmt(tdeeRaw)} kcal. Dopo 2-3 settimane di dati lo sostituisce quello misurato.`,
  };

  /* surplus o deficit */
  const [adjMin, adjMax, adjDefault] = GOAL_ADJUSTMENT[profile.goal];
  let adj = opts.adjustmentPct ?? adjDefault;
  if (adj < adjMin || adj > adjMax) {
    const clamped = clamp(adj, adjMin, adjMax);
    notes.push(`Il surplus richiesto (${pct(adj)}) è fuori dall'intervallo per l'obiettivo ${profile.goal}: uso ${pct(clamped)}.`);
    adj = clamped;
  }
  const adjustmentPct: Explained = { value: roundTo(adj * 100, 1), why: goalWhy(profile.goal, adj) };
  let kcalRaw = tdeeRaw * (1 + adj);
  if (kcalRaw < bmrRaw) {
    notes.push('Le calorie non scendono sotto il metabolismo a riposo.');
    kcalRaw = bmrRaw;
  }

  /* peso di riferimento */
  const bmi = weight / (heightCm / 100) ** 2;
  let refWeight = weight;
  let refWhy = `Proteine e grassi sul peso attuale (${fmt(weight, 1)} kg).`;
  const fatThreshold = BODY_FAT_THRESHOLD[sex];
  if (hasFat && profile.bodyFatPct! > fatThreshold) {
    refWeight = (weight * (1 - profile.bodyFatPct! / 100)) / (1 - fatThreshold / 100);
    refWhy =
      `Con il ${fmt(profile.bodyFatPct!, 1)}% di grasso proteine e grassi si calcolano sul peso che avresti al ${fatThreshold}% ` +
      `(${fmt(refWeight, 1)} kg), per non sovrastimarli.`;
  } else if (!hasFat && bmi > BMI_THRESHOLD) {
    refWeight = BMI_THRESHOLD * (heightCm / 100) ** 2;
    refWhy =
      `Con un BMI di ${fmt(bmi, 1)} (sopra ${BMI_THRESHOLD}) proteine e grassi si calcolano sul peso a BMI ${BMI_THRESHOLD} ` +
      `(${fmt(refWeight, 1)} kg). Se conosci la percentuale di grasso il calcolo diventa più preciso.`;
  }
  const referenceWeightKg: Explained = { value: roundTo(refWeight, 1), why: refWhy };

  /* proteine */
  const [pMin, pMax, pDefault] = PROTEIN_G_PER_KG;
  let pPerKg = opts.proteinGPerKg ?? pDefault;
  if (pPerKg < pMin || pPerKg > pMax) {
    const c = clamp(pPerKg, pMin, pMax);
    notes.push(`Proteine richieste ${fmt(pPerKg, 1)} g/kg: oltre ${fmt(pMax, 1)} non servono e sotto ${fmt(pMin, 1)} non bastano, uso ${fmt(c, 1)} g/kg.`);
    pPerKg = c;
  }
  const proteinG = pPerKg * refWeight;

  /* grassi e carboidrati */
  const [fMin, fMax, fDefault] = FAT_G_PER_KG;
  let fPerKg = clamp(opts.fatGPerKg ?? fDefault, FAT_FLOOR_G_PER_KG, fMax);
  if (opts.fatGPerKg !== undefined && opts.fatGPerKg < fMin) {
    notes.push(`Grassi sotto ${fmt(fMin, 1)} g/kg: va bene per brevi periodi, mai sotto ${fmt(FAT_FLOOR_G_PER_KG, 1)} g/kg.`);
  }
  const minCarbs = opts.minCarbsG ?? 130;
  let fatG = fPerKg * refWeight;
  // grassi mai sotto il 20% delle calorie (ISSN: 20-35%), anche quando le calorie sono alte
  let fatRaised = false;
  if (fatG < (FAT_MIN_SHARE * kcalRaw) / 9) {
    fatG = (FAT_MIN_SHARE * kcalRaw) / 9;
    fPerKg = fatG / refWeight;
    fatRaised = true;
  }
  let carbsG = (kcalRaw - 4 * proteinG - 9 * fatG) / 4;
  let fatLowered = false;
  if (carbsG < minCarbs) {
    const fatForMin = (kcalRaw - 4 * proteinG - 4 * minCarbs) / 9;
    const floor = FAT_FLOOR_G_PER_KG * refWeight;
    fatG = Math.max(floor, Math.min(fatG, fatForMin));
    fPerKg = fatG / refWeight;
    carbsG = Math.max(0, (kcalRaw - 4 * proteinG - 9 * fatG) / 4);
    fatLowered = true;
    fatRaised = false;
    if (carbsG < minCarbs - 0.5) {
      notes.push(
        `Con queste calorie i grassi sono già al minimo (${fmt(FAT_FLOOR_G_PER_KG, 1)} g/kg) e i carboidrati restano ${fmt(carbsG)} g: ` +
          'un deficit così stretto va tenuto per poco tempo.',
      );
    }
  }

  const average: MacroTargets = {
    kcal: {
      value: roundTo(kcalRaw, 0),
      why: `Media della settimana: dispendio ${fmt(tdeeRaw)} kcal ${adj === 0 ? 'senza surplus' : `${pct(adj)}`} = ${fmt(kcalRaw)} kcal.`,
    },
    protein: {
      value: roundTo(proteinG, 0),
      why: `${fmt(pPerKg, 1)} g per kg (intervallo utile ${fmt(pMin, 1)}-${fmt(pMax, 1)}) x ${fmt(refWeight, 1)} kg = ${fmt(proteinG)} g. Uguali tutti i giorni: costruiscono e riparano il muscolo.`,
    },
    fat: {
      value: roundTo(fatG, 0),
      why: fatLowered
        ? `${fmt(fPerKg, 2)} g per kg = ${fmt(fatG)} g: abbassati per lasciare spazio ai carboidrati, mai sotto ${fmt(FAT_FLOOR_G_PER_KG, 1)} g/kg.`
        : fatRaised
          ? `${fmt(fatG)} g (${fmt(fPerKg, 2)} g per kg): il 20% delle calorie, il minimo per ormoni e vitamine quando si mangia tanto.`
          : `${fmt(fPerKg, 1)} g per kg = ${fmt(fatG)} g: servono a ormoni e vitamine, mai sotto ${fmt(FAT_FLOOR_G_PER_KG, 1)} g/kg.`,
    },
    carbs: {
      value: roundTo(carbsG, 0),
      why: `Il resto delle calorie: ${fmt(carbsG)} g di carboidrati, il carburante degli allenamenti.`,
    },
  };

  /* tipi di giorno: si spostano solo i carboidrati, il totale settimanale non cambia */
  const restCut = clamp(opts.restCarbCut ?? 0.125, 0.1, 0.15);
  const runCarbs = runKcal / 4;
  const trainingDays = Math.min(7, gymDays + runDays);
  const restDays = 7 - trainingDays;
  const baseCarbs = Math.max(0, (7 * carbsG - runDays * runCarbs) / (trainingDays + restDays * (1 - restCut)));
  const dayCarbs: Record<DayType, number> = {
    palestra: baseCarbs,
    corsa: baseCarbs + runCarbs,
    riposo: baseCarbs * (1 - restCut),
  };
  // nessun tipo di giorno sotto il metabolismo a riposo, né sotto il minimo di carboidrati (se la media lo permette)
  const raised: DayType[] = [];
  for (const type of ['palestra', 'corsa', 'riposo'] as const) {
    let c = dayCarbs[type];
    if (4 * proteinG + 9 * fatG + 4 * c < bmrRaw) c = (bmrRaw - 4 * proteinG - 9 * fatG) / 4;
    if (carbsG >= minCarbs && c < minCarbs) c = minCarbs;
    if (c > dayCarbs[type] + 0.5) {
      dayCarbs[type] = c;
      raised.push(type);
    }
  }
  if (raised.length > 0) {
    notes.push(
      `Nei giorni di ${raised.join(' e ')} calorie e carboidrati non scendono sotto il minimo (metabolismo a riposo e ${fmt(minCarbs)} g di carboidrati): la media della settimana sale di poco.`,
    );
  }
  const dayCarbWhy: Record<DayType, string> = {
    palestra: `Giorno di palestra: ${fmt(baseCarbs)} g di carboidrati, la base della settimana.`,
    corsa: `Giorno di corsa: base + ${fmt(runCarbs)} g per la corsa (${fmt(runKcal)} kcal).`,
    riposo: `Giorno di riposo: ${pct(-restCut)} di carboidrati, c'è meno lavoro da alimentare.`,
  };
  const mealCount = clamp(Math.round(profile.mealsPerDay || 5), 1, 5);
  if ((profile.mealsPerDay || 5) > 5) notes.push('Il diario ha 5 momenti (colazione, spuntino, pranzo, merenda, cena): i pasti in più vanno in uno di questi.');
  if (mealCount < 4) {
    notes.push(
      `Con ${mealCount} pasti ogni pasto deve portare più proteine: uno spuntino proteico (yogurt greco, latte, whey) aiuta a distribuirle meglio.`,
    );
  }

  const days = {} as Record<DayType, DayTargets>;
  for (const type of ['palestra', 'corsa', 'riposo'] as const) {
    const c = dayCarbs[type];
    const kcal = 4 * proteinG + 9 * fatG + 4 * c;
    days[type] = {
      type,
      kcal: { value: roundTo(kcal, 0), why: `${fmt(proteinG)} g proteine, ${fmt(fatG)} g grassi e ${fmt(c)} g carboidrati = ${fmt(kcal)} kcal.` },
      protein: { value: roundTo(proteinG, 0), why: average.protein.why },
      fat: { value: roundTo(fatG, 0), why: average.fat.why },
      carbs: { value: roundTo(c, 0), why: dayCarbWhy[type] },
      meals: splitMeals(kcal, proteinG, fatG, c, refWeight, mealCount),
    };
  }

  /* crescita obiettivo in massa */
  let monthlyGainKg: Targets['monthlyGainKg'];
  if (profile.goal === 'massa') {
    const beginner = profile.experience === 'nuovo' || profile.experience === 'meno-6-mesi';
    const [lo, mid, hi] = beginner ? [0.005, 0.0075, 0.01] : [0.0025, 0.005, 0.0075];
    monthlyGainKg = {
      value: roundTo(weight * mid, 2),
      rangePct: [lo * 100, hi * 100],
      why: beginner
        ? `Da principiante l'obiettivo è crescere dello ${fmt(lo * 100, 1)}-${fmt(hi * 100, 1)}% del peso al mese: circa ${fmt(weight * mid, 1)} kg.`
        : `Con più esperienza si cresce più piano: ${fmt(lo * 100, 2)}-${fmt(hi * 100, 2)}% del peso al mese, circa ${fmt(weight * mid, 1)} kg.`,
    };
  }

  return { age, bmr, activityFactor, exercise, tdee, adjustmentPct, referenceWeightKg, average, days, monthlyGainKg, notes };
}

function goalWhy(goal: Goal, adj: number): string {
  switch (goal) {
    case 'massa':
      return `Massa: ${pct(adj)} sul dispendio, abbastanza per costruire muscolo senza accumulare troppo grasso.`;
    case 'ricomposizione':
      return 'Ricomposizione: calorie pari al dispendio, si perde grasso e si costruisce muscolo piano piano.';
    case 'mantenimento':
      return 'Mantenimento: calorie pari al dispendio.';
    case 'definizione':
      return `Definizione: ${pct(adj)} sul dispendio, con proteine alte per proteggere il muscolo.`;
  }
}

/**
 * Ripartizione nei pasti. I 4 pasti principali ricevono almeno 0,4 g/kg di proteine;
 * il resto delle proteine e i grassi seguono la quota di calorie, i carboidrati chiudono il conto.
 */
function splitMeals(kcal: number, proteinG: number, fatG: number, carbsG: number, refWeight: number, count: number): MealTarget[] {
  const slots = MEALS_BY_COUNT[count];
  const totalShare = slots.reduce((a, s) => a + MEAL_SHARES[s], 0);
  const shares = slots.map((s) => MEAL_SHARES[s] / totalShare);
  const proteinMeals = slots.filter((s) => PROTEIN_MEALS.includes(s));
  const floor = Math.min(PROTEIN_PER_MEAL_G_PER_KG * refWeight, proteinG / Math.max(1, proteinMeals.length));
  const rest = Math.max(0, proteinG - floor * proteinMeals.length);
  const protein = slots.map((s, i) => (proteinMeals.includes(s) ? floor : 0) + rest * shares[i]);
  const fat = shares.map((sh) => fatG * sh);
  const rawCarbs = slots.map((_, i) => Math.max(0, (kcal * shares[i] - 4 * protein[i] - 9 * fat[i]) / 4));
  const sumC = rawCarbs.reduce((a, b) => a + b, 0);
  const carbs = rawCarbs.map((c) => (sumC > 0 ? (c * carbsG) / sumC : 0));
  return slots.map((slot, i) => {
    const k = 4 * protein[i] + 9 * fat[i] + 4 * carbs[i];
    const isProteinMeal = proteinMeals.includes(slot);
    return {
      slot,
      share: roundTo(shares[i], 4),
      kcal: roundTo(k, 0),
      protein: roundTo(protein[i], 0),
      carbs: roundTo(carbs[i], 0),
      fat: roundTo(fat[i], 0),
      why: isProteinMeal
        ? `${fmt(shares[i] * 100, 1)}% delle calorie e almeno ${fmt(PROTEIN_PER_MEAL_G_PER_KG, 1)} g/kg di proteine (${fmt(floor)} g).`
        : `${fmt(shares[i] * 100, 1)}% delle calorie: uno spuntino leggero, ad esempio frutta.`,
    };
  });
}
