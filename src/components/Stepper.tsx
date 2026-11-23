import { useRef, type PointerEvent } from 'react';
import { Minus, Plus } from '@phosphor-icons/react';

interface StepperProps {
  value: number;
  onChange: (n: number) => void;
  step: number;
  /** Passo del trascinamento orizzontale sul numero. */
  dragStep?: number;
  min?: number;
  max?: number;
  unit?: string;
  label: string;
  format?: (n: number) => string;
  big?: boolean;
}

/**
 * Numero con − e +. Trascinando il numero a destra o a sinistra cambia a passi di `dragStep`
 * (ogni 12 px), con il totale che si aggiorna in tempo reale.
 */
export function Stepper({ value, onChange, step, dragStep, min = 0, max = 100000, unit, label, format, big }: StepperProps) {
  const start = useRef<{ x: number; v: number } | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  const ds = dragStep ?? step;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, v: value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const steps = Math.trunc(dx / 12);
    const next = clamp(start.current.v + steps * ds);
    if (next !== value) {
      onChange(next);
      if (navigator.vibrate && Math.abs(steps) % 5 === 0) navigator.vibrate(4);
    }
  };
  const onUp = () => {
    start.current = null;
  };

  return (
    <div className={`stepper${big ? ' stepper--big' : ''}`} role="group" aria-label={label}>
      <button type="button" aria-label={`Togli ${step}${unit ? ' ' + unit : ''}`} onClick={() => onChange(clamp(value - step))}>
        <Minus size={20} weight="bold" />
      </button>
      <div
        className="stepper-value"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-live="polite"
      >
        {format ? format(value) : value}
        {unit && <small>{unit}</small>}
      </div>
      <button type="button" aria-label={`Aggiungi ${step}${unit ? ' ' + unit : ''}`} onClick={() => onChange(clamp(value + step))}>
        <Plus size={20} weight="bold" />
      </button>
    </div>
  );
}
