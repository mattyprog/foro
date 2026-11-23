/**
 * Client minimo per Gemini (Google AI Studio), chiamato direttamente dal browser.
 * POST https://generativelanguage.googleapis.com/v1beta/models/<modello>:generateContent
 * con header x-goog-api-key. La chiave arriva come parametro: non viene letta da nessuna parte,
 * non finisce nell'URL e non compare mai nei messaggi di errore o nei log.
 */
import type { ZodType } from 'zod';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Prezzi in dollari per milione di token (input, output; il ragionamento si paga come output). */
export interface PriceBand {
  until?: string;
  inputPerM: number;
  outputPerM: number;
}
export const PRICES: Record<string, PriceBand[]> = {
  'gemini-3.8-flash': [
    { until: '2026-12-31', inputPerM: 0.75, outputPerM: 3.75 },
    { inputPerM: 1.5, outputPerM: 7.5 },
  ],
};

export type GeminiErrorKind =
  | 'chiave-mancante'
  | 'chiave-non-valida'
  | 'credito-esaurito'
  | 'troppe-richieste'
  | 'modello-non-trovato'
  | 'rete'
  | 'servizio-non-disponibile'
  | 'richiesta-non-valida'
  | 'risposta-non-valida'
  | 'bloccata'
  | 'immagine-non-valida'
  | 'etichetta-illeggibile';

export class GeminiError extends Error {
  constructor(
    public kind: GeminiErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Timeout in millisecondi (default 60 s). */
  timeoutMs?: number;
  /** Data per la fascia di prezzo (default adesso). */
  now?: Date;
  endpoint?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface Cost {
  usd: number;
  inputPerM: number;
  outputPerM: number;
  /** Vero se il modello non e' nel listino e si usano i prezzi del modello di default. */
  approx: boolean;
}

export interface GeminiResult<T> {
  data: T;
  usage: Usage;
  cost: Cost;
  model: string;
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GenerateRequest {
  system: string;
  parts: Part[];
  /** responseSchema nel formato OpenAPI ridotto di Gemini. */
  schema: object;
  thinking?: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
}

/** Costo stimato dalla usageMetadata con il listino in vigore alla data indicata. */
export function computeCost(usage: Usage, model: string, now: Date = new Date()): Cost {
  const bands = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const day = now.toISOString().slice(0, 10);
  const band = bands.find((b) => !b.until || day <= b.until) ?? bands[bands.length - 1];
  const usd = (usage.inputTokens * band.inputPerM + (usage.outputTokens + usage.thinkingTokens) * band.outputPerM) / 1e6;
  return { usd, inputPerM: band.inputPerM, outputPerM: band.outputPerM, approx: !PRICES[model] };
}

export function buildRequestBody(req: GenerateRequest): object {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: req.schema,
      thinkingConfig: { thinkingLevel: req.thinking ?? 'low' },
      maxOutputTokens: req.maxOutputTokens ?? 4096,
    },
  };
}

function checkModel(model: string): string {
  if (!/^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(model)) {
    throw new GeminiError('richiesta-non-valida', `Nome del modello non valido: ${model.slice(0, 40)}`);
  }
  return model;
}

/** Messaggio d'errore del server, ripulito da qualsiasi cosa somigli a una chiave. */
function serverMessage(body: unknown): { message: string; status: string; reasons: string[]; retrySec?: number; quotaIds: string[] } {
  const err = ((body ?? {}) as { error?: Record<string, unknown> }).error ?? {};
  const message = String(err.message ?? '').replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[chiave]').slice(0, 300);
  const details = Array.isArray(err.details) ? (err.details as Record<string, unknown>[]) : [];
  const reasons = details.map((d) => String(d.reason ?? '')).filter(Boolean);
  const quotaIds: string[] = [];
  let retrySec: number | undefined;
  for (const d of details) {
    const violations = Array.isArray(d.violations) ? (d.violations as Record<string, unknown>[]) : [];
    for (const v of violations) if (v.quotaId) quotaIds.push(String(v.quotaId));
    if (typeof d.retryDelay === 'string') retrySec = parseFloat(d.retryDelay);
  }
  return { message, status: String(err.status ?? ''), reasons, retrySec, quotaIds };
}

/** Classifica gli errori HTTP di Gemini con messaggi in italiano. */
export function classifyHttpError(httpStatus: number, body: unknown, model: string): GeminiError {
  const s = serverMessage(body);
  const keyInvalid = s.reasons.includes('API_KEY_INVALID') || /api key not valid|api_key_invalid|invalid api key/i.test(s.message);
  if (httpStatus === 400 && keyInvalid) {
    return new GeminiError('chiave-non-valida', 'La chiave API di Gemini non è valida: controllala nelle impostazioni.', 400);
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new GeminiError(
      'chiave-non-valida',
      'La chiave API di Gemini non è valida o non ha accesso a questo modello: controllala nelle impostazioni.',
      httpStatus,
    );
  }
  if (httpStatus === 402) {
    return new GeminiError('credito-esaurito', 'Il credito prepagato di Google AI Studio è finito: ricaricalo su aistudio.google.com.', 402);
  }
  if (httpStatus === 429) {
    const perMinute = s.quotaIds.some((q) => /PerMinute/i.test(q)) || (s.retrySec !== undefined && s.retrySec <= 120);
    const credit = /billing|credit|prepa|prepaid|balance|quota/i.test(s.message) && !perMinute;
    if (credit) {
      return new GeminiError(
        'credito-esaurito',
        'Credito o quota di Gemini esauriti: controlla il credito prepagato e i limiti su aistudio.google.com.',
        429,
      );
    }
    const wait = s.retrySec ? ` tra ${Math.ceil(s.retrySec)} secondi` : ' tra un minuto';
    return new GeminiError('troppe-richieste', `Troppe richieste a Gemini in poco tempo: riprova${wait}.`, 429);
  }
  if (httpStatus === 404) {
    return new GeminiError('modello-non-trovato', `Il modello ${model} non esiste o non è disponibile: cambialo nelle impostazioni.`, 404);
  }
  if (httpStatus >= 500) {
    return new GeminiError('servizio-non-disponibile', 'Gemini non risponde in questo momento: riprova tra poco.', httpStatus);
  }
  return new GeminiError('richiesta-non-valida', `Richiesta rifiutata da Gemini (${httpStatus}): ${s.message || s.status || 'errore sconosciuto'}`, httpStatus);
}

/** Chiama generateContent con output JSON strutturato e valida la risposta con zod. */
export async function generateJson<T>(req: GenerateRequest, zodSchema: ZodType<T>, opts: GeminiOptions): Promise<GeminiResult<T>> {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new GeminiError('chiave-mancante', 'Manca la chiave API di Gemini: inseriscila nelle impostazioni.');
  }
  const model = checkModel(opts.model ?? DEFAULT_MODEL);
  const url = `${opts.endpoint ?? GEMINI_ENDPOINT}/models/${model}:generateContent`;
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const signal = opts.signal ?? (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(opts.timeoutMs ?? 60_000) : undefined);

  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey.trim() },
      body: JSON.stringify(buildRequestBody(req)),
      signal,
    });
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    throw new GeminiError(
      'rete',
      timeout ? 'Gemini non ha risposto in tempo: riprova.' : "Nessuna connessione: l'analisi con Gemini richiede internet.",
    );
  }

  let body: unknown;
  const text = await res.text().catch(() => '');
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = undefined;
  }
  if (!res.ok) throw classifyHttpError(res.status, body, model);
  if (body === undefined) throw new GeminiError('risposta-non-valida', 'Risposta non valida da Gemini: riprova.');

  const b = body as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  };
  const um = b.usageMetadata ?? {};
  const usage: Usage = {
    inputTokens: um.promptTokenCount ?? 0,
    outputTokens: um.candidatesTokenCount ?? 0,
    thinkingTokens: um.thoughtsTokenCount ?? 0,
    totalTokens: um.totalTokenCount ?? 0,
  };
  if (b.promptFeedback?.blockReason) {
    throw new GeminiError('bloccata', "Gemini ha bloccato la richiesta: prova con un'altra foto.");
  }
  const cand = b.candidates?.[0];
  if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') {
    throw new GeminiError('bloccata', "Gemini ha bloccato la risposta: prova con un'altra foto.");
  }
  const out = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (!out) throw new GeminiError('risposta-non-valida', 'Gemini non ha restituito una risposta: riprova.');
  if (cand?.finishReason === 'MAX_TOKENS') {
    throw new GeminiError('risposta-non-valida', 'La risposta di Gemini è stata troncata: riprova.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new GeminiError('risposta-non-valida', 'Gemini ha risposto in un formato non valido: riprova.');
  }
  const v = zodSchema.safeParse(parsed);
  if (!v.success) {
    const where = v.error.issues[0]?.path.join('.') || 'radice';
    throw new GeminiError('risposta-non-valida', `La risposta di Gemini non rispetta lo schema (${where}): riprova.`);
  }
  return { data: v.data, usage, cost: computeCost(usage, model, opts.now), model };
}

/** Blob in base64 (senza prefisso data:). */
export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(s);
}
