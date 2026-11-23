import { useSyncExternalStore } from 'react';
import { navigate as wouterNavigate } from 'wouter/use-hash-location';

/**
 * Routing con l'hash (GitHub Pages non ha riscritture lato server), con due correzioni a wouter:
 * - una navigazione senza parametri azzera quelli vecchi (wouter li lascerebbe, e la Dieta resterebbe su un altro giorno);
 * - un link con i parametri dentro l'hash (#/dieta?d=2026-11-20) funziona lo stesso.
 */
const subscribe = (cb: () => void) => {
  addEventListener('hashchange', cb);
  addEventListener('popstate', cb);
  return () => {
    removeEventListener('hashchange', cb);
    removeEventListener('popstate', cb);
  };
};

const hashBody = () => location.hash.replace(/^#?\/?/, '');
const currentPath = () => '/' + hashBody().split('?')[0];
const currentSearch = () => {
  const h = hashBody();
  const i = h.indexOf('?');
  return i >= 0 ? h.slice(i + 1) : location.search.replace(/^\?/, '');
};

export const navigate = (to: string, opts?: { replace?: boolean; state?: unknown }) =>
  wouterNavigate(to.includes('?') ? to : to + '?', opts as Parameters<typeof wouterNavigate>[1]);

export function useHashPath(): [string, typeof navigate] {
  return [useSyncExternalStore(subscribe, currentPath, () => '/'), navigate];
}
useHashPath.hrefs = (href: string) => '#' + href;

export function useHashSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch, () => '');
}
