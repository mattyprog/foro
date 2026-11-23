/**
 * Geometria delle tracce GPS e delle serie temporali.
 * Stesse regole di scripts/sync/garmin_bridge/geo.py: se ne cambi una, cambia anche l'altra.
 *
 * - Taglio privacy: via i primi e gli ultimi `trimM` metri di percorso E ogni punto a meno di
 *   `trimM` metri in linea d'aria dalla partenza o dall'arrivo (casa non si vede neanche se il giro
 *   ci ripassa vicino).
 * - Douglas-Peucker con tolleranza crescente (da 1 m) finché i punti sono al massimo `maxPoints`.
 * - Serie [secondi, valore] ridotte con la media di blocchi consecutivi di campioni.
 */

export const EARTH_RADIUS_M = 6_371_008.8;
export const MAX_TRACK_POINTS = 500;
export const MAX_SERIES_POINTS = 600;
/** Sotto questa velocità (m/s) si è fermi: niente passo (sarebbe oltre 33 min/km). */
export const MIN_SPEED_MS = 0.5;
const COORD_DECIMALS = 5; // circa 1 m

export type LatLon = [number, number];
export type Pair = [number, number];

const DEG_TO_RAD = Math.PI / 180;
/** Come math.radians di Python (stesso ordine delle operazioni, stesso risultato al bit). */
const rad = (d: number) => d * DEG_TO_RAD;

/** Somma come sum() di Python 3.12+ (algoritmo compensato di Neumaier): stessi bit nei due linguaggi. */
export function pySum(values: Iterable<number>): number {
  let s = 0;
  let c = 0;
  for (const x of values) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

/**
 * Arrotondamento all'intero come round() di Python: i casi a metà vanno al pari (4.5 -> 4, 5.5 -> 6).
 * Serve perché Python e TypeScript producano gli stessi numeri dagli stessi dati.
 */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/**
 * Come round(x, digits) di Python: arrotonda il valore binario ESATTO (toFixed è esatto) e porta al pari
 * solo i veri casi a metà. Moltiplicare per 10^digits creerebbe falsi casi a metà (es. -94.800285).
 */
export function roundTo(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  if (Number.isInteger(x * 2 ** (digits + 1))) {
    // pochi decimali binari: il prodotto è esatto e un eventuale caso a metà è vero
    const k = 10 ** digits;
    return roundHalfEven(x * k) / k;
  }
  return Number(x.toFixed(digits));
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dp = p2 - p1;
  const dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidCoord(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

export function trimPrivacy(points: readonly LatLon[], trimM: number): LatLon[] {
  const pts = points.map((p): LatLon => [p[0], p[1]]);
  if (trimM <= 0) return pts;
  if (pts.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const total = cum[cum.length - 1];
  if (total <= 2 * trimM) return [];
  const [s, e] = [pts[0], pts[pts.length - 1]];
  const out: LatLon[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (cum[i] < trimM || cum[i] > total - trimM) continue;
    if (haversineM(s[0], s[1], p[0], p[1]) < trimM) continue;
    if (haversineM(e[0], e[1], p[0], p[1]) < trimM) continue;
    out.push(p);
  }
  return out.length >= 2 ? out : [];
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  // sqrt(x*x + y*y) e non hypot: hypot ha precisione diversa tra Python e JavaScript
  const norm = (x: number, y: number) => Math.sqrt(x * x + y * y);
  if (dx === 0 && dy === 0) return norm(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return norm(px - (ax + t * dx), py - (ay + t * dy));
}

function douglasPeucker(xy: readonly Pair[], eps: number): number[] {
  const n = xy.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Pair[] = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    const [ax, ay] = xy[first];
    const [bx, by] = xy[last];
    let best = -1;
    let bestI = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(xy[i][0], xy[i][1], ax, ay, bx, by);
      if (d > best) {
        best = d;
        bestI = i;
      }
    }
    if (best > eps) {
      keep[bestI] = 1;
      stack.push([first, bestI], [bestI, last]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

const roundCoord = (p: LatLon): LatLon => [roundTo(p[0], COORD_DECIMALS), roundTo(p[1], COORD_DECIMALS)];

function dedupe(points: readonly LatLon[]): LatLon[] {
  const out: LatLon[] = [];
  for (const q of points) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== q[0] || prev[1] !== q[1]) out.push(q);
  }
  return out;
}

export function simplifyTrack(points: readonly LatLon[], maxPoints = MAX_TRACK_POINTS): LatLon[] {
  const pts = points.filter((p) => isValidCoord(p[0], p[1])).map((p): LatLon => [p[0], p[1]]);
  // arrotondamento calcolato una volta per punto (Python arrotonda gli stessi punti dopo la selezione)
  const rounded = pts.map(roundCoord);
  if (pts.length <= 2) return dedupe(rounded);
  const lat0 = rad(pySum(pts.map((p) => p[0])) / pts.length);
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const xy = pts.map((p): Pair => [p[1] * Math.cos(lat0) * k, p[0] * k]);
  let eps = 1;
  let out = dedupe(rounded);
  for (let i = 0; i < 80; i++) {
    out = dedupe(douglasPeucker(xy, eps).map((j) => rounded[j]));
    if (out.length <= maxPoints) return out;
    eps *= 1.5;
  }
  return [...out.slice(0, maxPoints - 1), out[out.length - 1]];
}

/** Riduce [[t, v], ...] a maxPoints con la media di blocchi consecutivi. */
export function downsamplePairs(series: readonly Pair[], maxPoints = MAX_SERIES_POINTS, roundValues = true): Pair[] {
  const fmt = (t: number, v: number): Pair => [roundHalfEven(t), roundValues ? roundHalfEven(v) : v];
  const n = series.length;
  if (n <= maxPoints) return series.map(([t, v]) => fmt(t, v));
  const out: Pair[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const a = Math.floor((i * n) / maxPoints);
    const b = Math.floor(((i + 1) * n) / maxPoints);
    if (b <= a) continue;
    const block = series.slice(a, b);
    out.push(fmt(pySum(block.map((p) => p[0])) / block.length, pySum(block.map((p) => p[1])) / block.length));
  }
  return out;
}

/** [[t, m/s], ...] -> [[t, s/km], ...]: media delle velocità per blocco, poi il passo. */
export function speedSeriesToPace(speeds: readonly Pair[], maxPoints = MAX_SERIES_POINTS): Pair[] {
  const moving = speeds.filter(([, v]) => Number.isFinite(v) && v >= MIN_SPEED_MS);
  return downsamplePairs(moving, maxPoints, false)
    .filter(([, v]) => v >= MIN_SPEED_MS)
    .map(([t, v]): Pair => [t, roundHalfEven(1000 / v)]);
}
