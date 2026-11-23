/**
 * Motore di nutrizione di Foro: API pubblica.
 * Il database (alimenti e piatti) si carica in modo pigro: importare questo modulo non lo scarica.
 */
export * from './types';
export { ATTRIBUTION, loadAllFoods, loadBaseFoods, loadDishes, loadFoodDbMeta } from './foodDb';
export {
  atwaterKcal, checkAtwater, kcalRange, macroSplit, roundNutrients, roundTo, scaleNutrients, sumNutrients,
} from './nutrients';
export type { AtwaterCheck } from './nutrients';
export { FoodSearchIndex, matchToDb, normalizeText, MATCH_THRESHOLD } from './search';
export type { MatchQuery, MatchResult, SearchOptions, SearchResult } from './search';
export {
  analyzeLabel, analyzePhoto, buildMealAnalysis, draftTotals, labelToFood, parseText, parseTextLocal, rescaleDraft,
  replaceDraftFood, OIL_OPTIONS,
} from './vision';
export type { AnalyzeOptions, ClarifyingQuestion, LabelAnalysis, MealAnalysis, TextAnalysis } from './vision';
export { computeCost, DEFAULT_MODEL, GeminiError, PRICES } from './gemini';
export type { Cost, GeminiErrorKind, Usage } from './gemini';
export { compressImage, fitWithin } from './image';
export { isValidBarcode, lookupBarcode, lookupBarcodeDetailed, mapOffProduct, OffError } from './openfoodfacts';
export type { OffErrorKind, OffResult } from './openfoodfacts';
export { ACTIVITY_FACTORS, ageOn, bmrKatchMcArdle, bmrMifflin, computeTargets, GOAL_ADJUSTMENT, MEAL_SHARES } from './targets';
export type { DayTargets, DayType, Explained, MacroTargets, MealTarget, TargetOptions, TargetProfile, Targets } from './targets';
export { addDays, dailyIntake, diffDays, mondayOf, weeklyCheckIn, weightTrend } from './adaptive';
export type { CheckInInput, CheckInInsufficient, CheckInProposal, CheckInResult, DailyIntake, RateStatus, TrendPoint } from './adaptive';
export { isInSeason, monthOf, seasonalFoods, seasonalProduce, seasonMonths, SEASON_NOTE, SEASON_SOURCE } from './season';
export type { SeasonItem, SeasonMonth } from './season';
