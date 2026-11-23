// PROVA REALE FACOLTATIVA: due chiamate vere a Gemini (foto di una carbonara + etichetta), costo < 1 centesimo.
// Si salta da sola nei test normali. La chiave arriva solo da process.env.FORO_GEMINI_KEY, impostata a runtime
// da chi lancia il test (mai scritta in questo file, mai stampata). Le immagini e il risultato stanno in FORO_LIVE_DIR.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { analyzeLabel, analyzePhoto } from '../../src/lib/nutrition/vision';

const key = process.env.FORO_GEMINI_KEY ?? '';
const dir = process.env.FORO_LIVE_DIR ?? '';

describe.skipIf(!key || !dir)('prova reale Gemini', () => {
  it('foto della carbonara + etichetta', async () => {
    const raw: string[] = [];
    const spy: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      raw.push(await res.clone().text());
      return res;
    };
    const jpg = (f: string) => new Blob([readFileSync(`${dir}/${f}`)], { type: 'image/jpeg' });
    const out: Record<string, unknown> = {};
    const t0 = Date.now();
    try {
      const a = await analyzePhoto(jpg('carbonara.jpg'), { apiKey: key, fetch: spy, compress: false, timeoutMs: 90_000 });
      out.foto = { ms: Date.now() - t0, ...a, items: a.items.map(({ alternatives, ...i }) => ({ ...i, alternatives: alternatives.map((x) => x.foodId) })) };
    } catch (e) {
      out.foto = { errore: String((e as Error).message), kind: (e as { kind?: string }).kind };
    }
    const t1 = Date.now();
    try {
      const l = await analyzeLabel(jpg('etichetta.jpg'), { apiKey: key, fetch: spy, compress: false, timeoutMs: 90_000 });
      out.etichetta = { ms: Date.now() - t1, ...l };
    } catch (e) {
      out.etichetta = { errore: String((e as Error).message), kind: (e as { kind?: string }).kind };
    }
    out.risposteGrezze = raw.map((r) => {
      try {
        const j = JSON.parse(r);
        return { testo: j.candidates?.[0]?.content?.parts?.filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text).join(''), finishReason: j.candidates?.[0]?.finishReason, usageMetadata: j.usageMetadata, modelVersion: j.modelVersion, error: j.error };
      } catch {
        return r.slice(0, 500);
      }
    });
    writeFileSync(`${dir}/risultato.json`, JSON.stringify(out, null, 2));
  }, 200_000);
});
