import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback } from 'react';
import { db, setSetting } from '@/db/db';
import type { Profile } from '@/db/types';

/** Legge un'impostazione dal database locale, reattiva. `undefined` mentre carica. */
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => Promise<void>, boolean] {
  const row = useLiveQuery(() => db.settings.get(key), [key], null);
  const loading = row === null;
  const value = row && row !== null ? (row.value as T) : fallback;
  const set = useCallback((v: T) => setSetting(key, v), [key]);
  return [value, set, loading];
}

export function useProfile(): Profile | undefined | null {
  // null = sta caricando, undefined = nessun profilo
  return useLiveQuery(() => db.profile.get('me'), [], null);
}

export type ThemePref = 'system' | 'light' | 'dark';

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17130f' : '#f8f3eb');
}
