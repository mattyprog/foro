import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadAllFoods, loadDishes } from './foodDb';
import { classifyHttpError, computeCost, GeminiError } from './gemini';
import { fitWithin } from './image';
import { FoodSearchIndex } from './search';
import { splitSegments, parseSegment } from './textParse';
import { analyzeLabel, analyzePhoto, buildMealAnalysis, labelToFood, parseText, rescaleDraft, type MealJson } from './vision';

// Chiave finta, spezzata apposta: scritta intera gli scanner di segreti (GitHub) la scambierebbero per vera.
const KEY = 'AIza' + 'TEST-chiave-finta-00000000000000000';
const NOW = new Date('2026-11-23T12:00:00Z');
const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])], { type: 'image/jpeg' });
let index: FoodSearchIndex;

beforeAll(async () => {
  index = new FoodSearchIndex(await loadAllFoods());
});

const USAGE = { promptTokenCount: 1400, candidatesTokenCount: 380, thoughtsTokenCount: 220, totalTokenCount: 2000 };
function gemini(obj: unknown, usage = USAGE, finishReason = 'STOP') {
  return { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(obj) }] }, finishReason }], usageMetadata: usage };
}
function fetchJson(body: unknown, status = 200) {
  return vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}
const item = (o: Partial<MealJson['alimenti'][number]>): MealJson['alimenti'][number] => ({
  nome: 'x', tipo: 'alimento', cottura: 'non_applicabile', grammi: 100, grammi_min: 80, grammi_max: 120, confidenza: 'alta',
  kcal_100g: 100, proteine_100g: 5, carboidrati_100g: 10, grassi_100g: 4, ...o,
});
const meal = (o: Partial<MealJson>): MealJson => ({
  cibo_presente: true, piatto: '', contesto: 'non_so', alimenti: [], olio: { rilevante: false, grammi: 0 }, domande: [], ...o,
});

const carbonara = meal({
  piatto: 'Spaghetti alla carbonara',
  contesto: 'ristorante',
  alimenti: [item({ nome: 'spaghetti alla carbonara', tipo: 'piatto', cottura: 'bollito', grammi: 320, grammi_min: 260, grammi_max: 380, kcal_100g: 230 })],
});

describe('richiesta a Gemini', () => {
  it('POST diretto con x-goog-api-key, JSON strutturato, ragionamento basso, foto JPEG', async () => {
    const f = fetchJson(gemini(carbonara));
    await analyzePhoto(photo, { apiKey: KEY, fetch: f, index, compress: false, now: NOW });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(String(url)).not.toContain(KEY);
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(String(init!.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(body.generationConfig.responseSchema.properties.alimenti.items.required).toContain('grammi_min');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
    expect(body.contents[0].parts[0].inlineData.data).toBe(btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9)));
    expect(body.systemInstruction.parts[0].text).toMatch(/Non devi calcolare le calorie/);
  });

  it('modello configurabile', async () => {
    const f = fetchJson(gemini(carbonara));
    await analyzePhoto(photo, { apiKey: KEY, model: 'gemini-9-pro', fetch: f, index, compress: false, now: NOW });
    expect(String(f.mock.calls[0][0])).toContain('/models/gemini-9-pro:generateContent');
  });

  it('costo dalla usageMetadata: 0,75 $ e 3,75 $ per milione fino al 31/12/2026, poi 1,50 e 7,50', () => {
    const u = { inputTokens: 1400, outputTokens: 380, thinkingTokens: 220, totalTokens: 2000 };
    expect(computeCost(u, 'gemini-3.8-flash', NOW).usd).toBeCloseTo((1400 * 0.75 + 600 * 3.75) / 1e6, 12);
    expect(computeCost(u, 'gemini-3.8-flash', new Date('2026-12-31T23:00:00Z')).inputPerM).toBe(0.75);
    expect(computeCost(u, 'gemini-3.8-flash', new Date('2027-01-01T08:00:00Z')).usd).toBeCloseTo((1400 * 1.5 + 600 * 7.5) / 1e6, 12);
    expect(computeCost(u, 'altro-modello', NOW).approx).toBe(true);
  });

  it('compressione: lato lungo 1024 px, proporzioni mantenute, mai ingrandita', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 768, height: 1024 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('analyzePhoto: le calorie le calcola il database', () => {
  it('piatto tipico: abbinato alla ricetta, kcal = valori per 100 g x grammi, costo stimato', async () => {
    const dish = (await loadDishes()).find((d) => d.id === 'carbonara')!;
    const r = await analyzePhoto(photo, { apiKey: KEY, fetch: fetchJson(gemini(carbonara)), index, compress: false, now: NOW });
    expect(r.dishName).toBe('Spaghetti alla carbonara');
    expect(r.items).toHaveLength(1);
    const c = r.items[0];
    expect(c.foodId).toBe('carbonara');
    expect(c.source).toBe('ricetta');
    expect(c.grams).toBe(320);
    expect(c.gramsRange).toEqual([260, 380]);
    expect(c.nutrients.kcal).toBe(Math.round((dish.per100g.kcal * 320) / 100)); // non 230 x 3,2 del modello
    // intervallo: grammi (+-18,75%) e variabilita della ricetta (+-25%) in quadratura
    const r1 = Math.sqrt(0.1875 ** 2 + dish.variability ** 2);
    const center = (dish.per100g.kcal * 320) / 100;
    expect(c.kcalRange).toEqual([Math.round(center * (1 - r1)), Math.round(center * (1 + r1))]);
    expect(c.confidence).toBe('alta');
    expect(r.questions).toEqual([]); // l olio della ricetta e gia compreso
    expect(r.cost.usd).toBeCloseTo(0.0033, 6);
    expect(r.usage).toEqual({ inputTokens: 1400, outputTokens: 380, thinkingTokens: 220, totalTokens: 2000 });
    expect(r.totals.kcal).toBe(c.nutrients.kcal);
  });

  it('piatto misto al ristorante: componenti cotti dal database, olio di default 10-15 g con la domanda', async () => {
    const raw = meal({
      piatto: 'Pollo alla griglia con patate al forno e insalata',
      contesto: 'ristorante',
      alimenti: [
        item({ nome: 'petto di pollo', cottura: 'alla_griglia', grammi: 150, grammi_min: 120, grammi_max: 180 }),
        item({ nome: 'patate', cottura: 'al_forno', grammi: 180, grammi_min: 140, grammi_max: 220, confidenza: 'media' }),
        item({ nome: 'insalata verde', cottura: 'crudo', grammi: 50, grammi_min: 30, grammi_max: 70 }),
      ],
      olio: { rilevante: true, grammi: 18, motivo: 'insalata condita e patate al forno' },
      domande: ['Le patate erano fritte o al forno?'],
    });
    const r = await analyzePhoto(photo, { apiKey: KEY, fetch: fetchJson(gemini(raw)), index, compress: false, now: NOW });
    expect(r.items.map((i) => i.foodId)).toEqual([
      'petto-di-pollo-ai-ferri',
      expect.stringMatching(/^patate-al-forno/),
      expect.stringMatching(/insalata|lattuga/),
      'olio-extravergine-di-oliva',
    ]);
    const oil = r.items[3];
    expect(oil.grams).toBe(15); // 18 g riportati nell intervallo del ristorante
    expect(oil.gramsRange).toEqual([10, 15]);
    expect(oil.nutrients.kcal).toBe(Math.round((oil.per100g.kcal * 15) / 100));
    expect(oil.confidence).toBe('bassa');
    expect(r.questions[0]).toMatchObject({ id: 'olio', itemIndex: 3 });
    expect(r.questions[0].options?.map((o) => o.grams)).toEqual([0, 5, 10, 15, 20]);
    expect(r.questions[1].text).toBe('Le patate erano fritte o al forno?');
    expect(r.items[1].confidence).toBe('media');
    // il totale e la somma delle voci, l intervallo la somma degli intervalli
    expect(r.totals.kcal).toBe(r.items.reduce((a, i) => a + i.nutrients.kcal, 0));
    expect(r.totals.kcalRange[0]).toBeLessThan(r.totals.kcal);
    expect(r.totals.kcalRange[1]).toBeGreaterThan(r.totals.kcal);
  });

  it('alimento assente dal database: stima del modello, fonte ai, fiducia bassa', async () => {
    const raw = meal({ alimenti: [item({ nome: 'salsa al wasabi e yuzu fermentato', tipo: 'condimento', grammi: 30, grammi_min: 20, grammi_max: 40, kcal_100g: 120, proteine_100g: 2, carboidrati_100g: 20, grassi_100g: 3 })] });
    const r = await analyzePhoto(photo, { apiKey: KEY, fetch: fetchJson(gemini(raw)), index, compress: false, now: NOW });
    const d = r.items[0];
    expect(d.source).toBe('ai');
    expect(d.foodId).toBeUndefined();
    expect(d.confidence).toBe('bassa');
    expect(d.per100g).toEqual({ kcal: 120, protein: 2, carbs: 20, fat: 3 });
    expect(d.nutrients.kcal).toBe(36);
    expect(d.why).toMatch(/non è nel database/);
  });

  it('foto senza cibo', async () => {
    const r = await analyzePhoto(photo, { apiKey: KEY, fetch: fetchJson(gemini(meal({ cibo_presente: false }))), index, compress: false, now: NOW });
    expect(r.notFood).toBe(true);
    expect(r.items).toEqual([]);
  });

  it('correzione dei grammi dall interfaccia', () => {
    const a = buildMealAnalysis(carbonara, index);
    const d = rescaleDraft(a.items[0], 400);
    expect(d.grams).toBe(400);
    expect(d.nutrients.kcal).toBe(Math.round((d.per100g.kcal * 400) / 100));
    expect(d.gramsRange).toEqual([325, 475]);
  });
});

describe('errori classificati in italiano (fetch simulato)', () => {
  const call = (f: ReturnType<typeof fetchJson> | (() => Promise<Response>)) =>
    analyzePhoto(photo, { apiKey: KEY, fetch: f as typeof fetch, index, compress: false, now: NOW });
  const err = (code: number, message: string, status: string, details: unknown[] = []) => ({ error: { code, message, status, details } });

  it('chiave non valida (400 API_KEY_INVALID e 403)', async () => {
    const bad = err(400, `API key not valid. Please pass a valid API key. ${KEY}`, 'INVALID_ARGUMENT', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
    ]);
    await expect(call(fetchJson(bad, 400))).rejects.toMatchObject({ kind: 'chiave-non-valida', status: 400 });
    await expect(call(fetchJson(err(403, 'Permission denied', 'PERMISSION_DENIED'), 403))).rejects.toMatchObject({ kind: 'chiave-non-valida' });
  });

  it('credito prepagato finito (402, oppure 429 con quota esaurita)', async () => {
    await expect(call(fetchJson(err(402, 'Payment required', 'FAILED_PRECONDITION'), 402))).rejects.toMatchObject({ kind: 'credito-esaurito' });
    const quota = err(429, 'You exceeded your current quota, please check your plan and billing details.', 'RESOURCE_EXHAUSTED');
    await expect(call(fetchJson(quota, 429))).rejects.toMatchObject({ kind: 'credito-esaurito' });
  });

  it('troppe richieste al minuto (429 con RetryInfo)', async () => {
    const rate = err(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED', [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' },
    ]);
    const e = await call(fetchJson(rate, 429)).catch((x) => x);
    expect(e).toBeInstanceOf(GeminiError);
    expect(e.kind).toBe('troppe-richieste');
    expect(e.message).toMatch(/17 secondi/);
  });

  it('rete, servizio, modello e risposte non valide', async () => {
    await expect(call(async () => { throw new TypeError('Failed to fetch'); })).rejects.toMatchObject({ kind: 'rete' });
    await expect(call(fetchJson(err(503, 'overloaded', 'UNAVAILABLE'), 503))).rejects.toMatchObject({ kind: 'servizio-non-disponibile' });
    await expect(call(fetchJson(err(404, 'models/x is not found', 'NOT_FOUND'), 404))).rejects.toMatchObject({ kind: 'modello-non-trovato' });
    await expect(call(fetchJson('<html>errore</html>', 200))).rejects.toMatchObject({ kind: 'risposta-non-valida' });
    const notJson = { candidates: [{ content: { parts: [{ text: 'Ecco la mia analisi: carbonara' }] }, finishReason: 'STOP' }] };
    await expect(call(fetchJson(notJson))).rejects.toMatchObject({ kind: 'risposta-non-valida' });
    await expect(call(fetchJson(gemini({ cibo_presente: true, piatto: 'x' })))).rejects.toMatchObject({ kind: 'risposta-non-valida' });
    await expect(call(fetchJson(gemini(carbonara, USAGE, 'MAX_TOKENS')))).rejects.toMatchObject({ kind: 'risposta-non-valida' });
    await expect(call(fetchJson({ promptFeedback: { blockReason: 'SAFETY' } }))).rejects.toMatchObject({ kind: 'bloccata' });
  });

  it('senza chiave non parte nessuna chiamata; la chiave non compare mai nei messaggi', async () => {
    const f = fetchJson(gemini(carbonara));
    await expect(analyzePhoto(photo, { apiKey: '  ', fetch: f, index, compress: false })).rejects.toMatchObject({ kind: 'chiave-mancante' });
    expect(f).not.toHaveBeenCalled();
    const e = classifyHttpError(400, { error: { message: `bad request for ${KEY}`, status: 'INVALID_ARGUMENT' } }, 'gemini-3.8-flash');
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain('[chiave]');
  });
});

describe('analyzeLabel: etichetta nutrizionale -> FoodItem dell utente', () => {
  const label = {
    leggibile: true, nome: 'Yogurt greco 0%', marca: 'Esempio', unita: 'g', valori_per: '100g', kcal: 54, kj: 229,
    grassi: 0, saturi: 0, carboidrati: 3.5, zuccheri: 3.5, fibre: null, proteine: 10, sale: 0.1, porzione_g: 170,
    porzione_descrizione: '1 vasetto (170 g)', problemi: null,
  };

  it('valori per 100 g esatti, porzione e marca; i valori assenti restano vuoti', async () => {
    const r = await analyzeLabel(photo, { apiKey: KEY, fetch: fetchJson(gemini(label)), compress: false, now: NOW });
    expect(r.food.source).toBe('utente');
    expect(r.food.id).toMatch(/^utente:yogurt-greco-0-/);
    expect(r.food.name).toBe('Yogurt greco 0%');
    expect(r.food.brand).toBe('Esempio');
    expect(r.food.per100g).toEqual({ kcal: 54, protein: 10, carbs: 3.5, fat: 0, sugars: 3.5, satFat: 0, salt: 0.1 });
    expect(r.food.per100g.fiber).toBeUndefined();
    expect(r.food.portions).toEqual([{ label: '1 vasetto (170 g)', grams: 170 }, { label: '100 g', grams: 100 }]);
    expect(r.warnings).toEqual([]);
    expect(r.cost.usd).toBeGreaterThan(0);
  });

  it('solo valori per porzione: convertiti per 100 g', () => {
    const { food, warnings } = labelToFood({
      leggibile: true, nome: 'Barretta', unita: 'g', valori_per: 'porzione', kcal: 120, proteine: 6, carboidrati: 15, grassi: 4, porzione_g: 30,
    });
    expect(food.per100g).toEqual({ kcal: 400, protein: 20, carbs: 50, fat: 13.3 });
    expect(warnings[0]).toMatch(/porzione da 30 g/);
  });

  it('calorie che non tornano: avviso; etichetta illeggibile: errore', () => {
    const { warnings } = labelToFood({ leggibile: true, nome: 'X', unita: 'g', valori_per: '100g', kcal: 500, proteine: 10, carboidrati: 10, grassi: 10 });
    expect(warnings.join(' ')).toMatch(/non tornano/);
    expect(() => labelToFood({ leggibile: false, nome: '', unita: 'g', valori_per: '100g' })).toThrow(GeminiError);
    expect(() => labelToFood({ leggibile: true, nome: 'X', unita: 'g', valori_per: '100g', kcal: 100, proteine: 1 })).toThrow(/carboidrati, grassi/);
  });
});

describe('parseText: frasi in italiano', () => {
  const noFetch = vi.fn(async () => {
    throw new Error('non deve chiamare Gemini');
  });

  it('divide la frase solo dove inizia una nuova quantita', () => {
    expect(splitSegments('200 g di pollo e 80 g di riso')).toEqual(['200 g di pollo', '80 g di riso']);
    expect(splitSegments('pasta e fagioli')).toEqual(['pasta e fagioli']);
    expect(splitSegments('un piatto di cacio e pepe e una birra')).toEqual(['un piatto di cacio e pepe', 'una birra']);
    expect(splitSegments('insalata con un filo d olio, pane')).toEqual(['insalata', 'un filo d olio', 'pane']);
    expect(parseSegment('1,5 kg di patate')).toMatchObject({ qty: 1.5, grams: 1500, food: 'patate' });
    expect(parseSegment('riso 80g')).toMatchObject({ grams: 80, food: 'riso' });
    expect(parseSegment('un etto di prosciutto crudo')).toMatchObject({ grams: 100, food: 'prosciutto crudo' });
  });

  it("'200 g di pollo e 80 g di riso': due bozze esatte, senza chiamare Gemini", async () => {
    const r = await parseText('200 g di pollo e 80 g di riso', { apiKey: KEY, fetch: noFetch, index });
    expect(r.usedModel).toBe(false);
    expect(r.cost).toBeUndefined();
    expect(noFetch).not.toHaveBeenCalled();
    expect(r.items.map((i) => i.grams)).toEqual([200, 80]);
    expect(r.items[0].name).toMatch(/pollo/i);
    expect(r.items[1].foodId).toBe('riso-bianco-crudo');
    expect(r.items[1].why).toMatch(/a crudo/);
    expect(r.items[0].gramsRange).toEqual([200, 200]);
    expect(r.items.every((i) => i.confidence === 'alta')).toBe(true);
  });

  it('pezzi, porzioni e misure di casa', async () => {
    const a = await parseText('2 uova e una fetta di pane', { index });
    expect(a.items.map((i) => [i.foodId, i.grams])).toEqual([['uovo-intero-crudo', 110], ['pane-bianco', 30]]);
    const b = await parseText('un piatto di carbonara e una birra media', { index });
    expect(b.items.map((i) => [i.foodId, i.grams])).toEqual([['carbonara', 300], ['birra-chiara', 400]]);
    const c = await parseText('mezzo litro di latte, un etto di prosciutto crudo, un cucchiaio di olio', { index });
    expect(c.items.map((i) => [i.foodId, i.grams])).toEqual([['latte-intero', 500], ['prosciutto-crudo', 100], ['olio-extravergine-di-oliva', 10]]);
    const d = await parseText('pasta e fagioli', { index });
    expect(d.items.map((i) => i.foodId)).toEqual(['pasta-e-fagioli']);
  });

  it('frase che la lettura locale non capisce: Gemini se c e la chiave, altrimenti la segnala', async () => {
    const text = 'una porzione di salsa al wasabi e yuzu';
    const offline = await parseText(text, { index });
    expect(offline.usedModel).toBe(false);
    expect(offline.unmatched).toEqual([text]);
    const raw = meal({ alimenti: [item({ nome: 'salsa al wasabi e yuzu', tipo: 'condimento', grammi: 30, grammi_min: 20, grammi_max: 40 })] });
    const f = fetchJson(gemini(raw, { promptTokenCount: 600, candidatesTokenCount: 150, thoughtsTokenCount: 50, totalTokenCount: 800 }));
    const online = await parseText(text, { apiKey: KEY, fetch: f, index, now: NOW });
    expect(online.usedModel).toBe(true);
    expect(online.items[0].source).toBe('ai');
    expect(online.cost?.usd).toBeCloseTo((600 * 0.75 + 200 * 3.75) / 1e6, 12);
    const body = JSON.parse(String(f.mock.calls[0][1]!.body));
    expect(body.contents[0].parts[0].text).toContain(text);
    expect(body.systemInstruction.parts[0].text).toMatch(/descrizione a parole/);
  });
});
