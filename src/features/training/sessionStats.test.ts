import { describe, expect, it } from 'vitest';
import type { LoggedSet } from '@/db/types';
import { sessionTonnage } from './sessionStats';

const set = (exerciseId: string, kg: number, reps: number, extra: Partial<LoggedSet> = {}): LoggedSet => ({ exerciseId, setIndex: 0, kg, reps, done: true, type: 'normale', ...extra });

describe('tonnellaggio dello storico', () => {
  it('conta i carichi veri, non i secondi né i kg di aiuto', () => {
    const sets = [
      set('leg-press', 100, 10),
      set('farmer-walk', 24, 40), // a tempo: 40 sono secondi
      set('trazioni-assistite', 30, 8), // 30 kg di aiuto, non sollevati
      set('leg-press', 60, 10, { type: 'riscaldamento' }),
      set('leg-press', 100, 10, { done: false }),
    ];
    expect(sessionTonnage({ sets })).toBe(1000);
  });
});
