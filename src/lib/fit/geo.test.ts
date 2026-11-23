import { describe, expect, it } from 'vitest';
import { downsamplePairs, haversineM, simplifyTrack, speedSeriesToPace, trimPrivacy } from './geo';

// Sede Garmin a Olathe (Kansas): luogo pubblico, coordinate sintetiche.
const LAT0 = 38.8556;
const LON0 = -94.799;

function line(n: number, stepM: number, bearingDeg = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const d = i * stepM;
    const dLat = (d * Math.cos((bearingDeg * Math.PI) / 180)) / 111_195;
    const dLon = (d * Math.sin((bearingDeg * Math.PI) / 180)) / (111_195 * Math.cos((LAT0 * Math.PI) / 180));
    out.push([LAT0 + dLat, LON0 + dLon]);
  }
  return out;
}

const pathLength = (pts: [number, number][]) =>
  pts.slice(1).reduce((s, p, i) => s + haversineM(pts[i][0], pts[i][1], p[0], p[1]), 0);

describe('geo', () => {
  it('haversine', () => {
    expect(haversineM(0, 0, 1, 0)).toBeCloseTo(111_195, -1);
    expect(haversineM(LAT0, LON0, LAT0, LON0)).toBe(0);
  });

  it('taglia i primi e gli ultimi 300 m', () => {
    const pts = line(301, 10);
    const out = trimPrivacy(pts, 300);
    expect(out.length).toBeGreaterThan(2);
    const [s, e] = [pts[0], pts[pts.length - 1]];
    for (const p of out) {
      expect(haversineM(s[0], s[1], p[0], p[1])).toBeGreaterThanOrEqual(300 - 1e-6);
      expect(haversineM(e[0], e[1], p[0], p[1])).toBeGreaterThanOrEqual(300 - 1e-6);
    }
    expect(pathLength(out)).toBeGreaterThan(2375);
    expect(pathLength(out)).toBeLessThan(2425);
  });

  it('toglie anche i passaggi vicino a casa a metà giro', () => {
    const pts = [...line(101, 10, 0), ...line(96, 10, 0).reverse(), ...line(101, 10, 90)];
    for (const p of trimPrivacy(pts, 300)) {
      expect(haversineM(LAT0, LON0, p[0], p[1])).toBeGreaterThanOrEqual(300 - 1e-6);
    }
  });

  it('una traccia troppo corta sparisce; 0 m non taglia', () => {
    expect(trimPrivacy(line(50, 10), 300)).toEqual([]);
    expect(trimPrivacy(line(10, 10), 0)).toHaveLength(10);
  });

  it('Douglas-Peucker: linea retta a 2 punti, spirale entro 500 punti', () => {
    expect(simplifyTrack(line(1000, 3), 500)).toHaveLength(2);
    const spiral: [number, number][] = [];
    for (let i = 0; i < 5000; i++) {
      const a = i / 40;
      const r = 0.002 + i * 0.000001;
      spiral.push([LAT0 + r * Math.sin(a), LON0 + r * Math.cos(a)]);
    }
    const out = simplifyTrack(spiral, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.length).toBeGreaterThan(50);
    expect(out[0]).toEqual([Number(spiral[0][0].toFixed(5)), Number(spiral[0][1].toFixed(5))]);
  });

  it('coordinate arrotondate a 5 decimali', () => {
    expect(simplifyTrack([[38.123456789, -94.987654321], [38.2, -94.9]], 500)[0]).toEqual([38.12346, -94.98765]);
  });

  it('serie: corte invariate, lunghe ridotte con la media', () => {
    const short: [number, number][] = Array.from({ length: 10 }, (_, i) => [i, 100 + i]);
    expect(downsamplePairs(short, 600)).toEqual(short);
    const long: [number, number][] = Array.from({ length: 3600 }, (_, i) => [i, i % 2 ? 120 : 140]);
    const out = downsamplePairs(long, 600);
    expect(out).toHaveLength(600);
    expect(out.every(([, v]) => v === 130)).toBe(true);
  });

  it('passo dalla velocità media, escludendo i tratti da fermo', () => {
    const speeds: [number, number][] = [...Array.from({ length: 100 }, (_, i): [number, number] => [i, 1000 / 300]), [100, 0.1]];
    const pace = speedSeriesToPace(speeds, 600);
    expect(pace).toHaveLength(100);
    expect(pace.every(([, p]) => p === 300)).toBe(true);
  });
});
