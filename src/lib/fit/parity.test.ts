/**
 * Parità con lo script Python: stessi dati SINTETICI, stessi numeri.
 * La fixture tests/fixtures/fit-parity.sample.json è prodotta da scripts/sync/tests/make_parity_fixture.py
 * con il codice Python (geo.py, fitparse.py); se una regola cambia da una parte, questo test lo segnala.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Activity } from '@/db/types';
import { base64ToBytes } from '@/lib/garmin/envelope';
import { DETAIL_FIELDS } from './dedupe';
import { MAX_SERIES_POINTS, MAX_TRACK_POINTS, downsamplePairs, simplifyTrack, speedSeriesToPace, trimPrivacy } from './geo';
import type { LatLon, Pair } from './geo';
import { parseFitFile } from './parseFit';

interface ParityFixture {
  input: {
    trimM: number;
    trackMax: number;
    track: LatLon[];
    hr: Pair[];
    speeds: Pair[];
    fit: Record<'run' | 'strength', string>;
  };
  expected: {
    trimmedCount: number;
    track: LatLon[];
    trackUntrimmed: LatLon[];
    hrSeries: Pair[];
    paceSeries: Pair[];
    fit: Record<'run' | 'strength', Partial<Activity>>;
  };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../tests/fixtures/fit-parity.sample.json', import.meta.url)), 'utf8'),
) as ParityFixture;
const { input, expected } = fixture;

function details(a: Activity): Partial<Activity> {
  const out: Record<string, unknown> = {};
  for (const k of DETAIL_FIELDS) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

describe('stesse regole dello script Python', () => {
  it('taglio privacy e Douglas-Peucker', () => {
    const trimmed = trimPrivacy(input.track, input.trimM);
    expect(trimmed).toHaveLength(expected.trimmedCount);
    expect(simplifyTrack(trimmed, input.trackMax)).toEqual(expected.track);
    expect(simplifyTrack(input.track, MAX_TRACK_POINTS)).toEqual(expected.trackUntrimmed);
  });

  it('serie FC e passo sottocampionate', () => {
    expect(downsamplePairs(input.hr, MAX_SERIES_POINTS)).toEqual(expected.hrSeries);
    expect(speedSeriesToPace(input.speeds, MAX_SERIES_POINTS)).toEqual(expected.paceSeries);
  });

  it.each(['run', 'strength'] as const)('dettagli del file FIT sintetico: %s', async (name) => {
    const a = await parseFitFile(base64ToBytes(input.fit[name]), { privacyTrimM: input.trimM });
    expect(details(a)).toEqual(expected.fit[name]);
  });
});
