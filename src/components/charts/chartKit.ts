import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** Larghezza corrente di un elemento (per disegnare i grafici sulla colonna reale). */
export function useWidth<T extends HTMLElement>(fallback = 350): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w];
}

/**
 * Scorrimento col dito su un grafico: restituisce l'indice più vicino. Il valore si legge
 * nella riga sopra il grafico, non in un tooltip flottante.
 */
export function useScrub(count: number, xOf: (i: number) => number) {
  const [idx, setIdx] = useState<number | null>(null);
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(xOf(i) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setIdx(count > 0 ? best : null);
  };
  return {
    idx,
    handlers: {
      onPointerDown: pick,
      onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
        if (e.buttons > 0 || e.pointerType === 'mouse') pick(e);
      },
      onPointerLeave: () => setIdx(null),
      onPointerUp: (e: PointerEvent<SVGSVGElement>) => {
        if (e.pointerType !== 'mouse') setIdx(null);
      },
    },
  };
}

export function extent(values: number[], pad = 0.08): [number, number] {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length === 0) return [0, 1];
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}
