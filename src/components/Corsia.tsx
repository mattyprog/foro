import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtInt } from '@/lib/format';

export interface CorsiaSegment {
  id: string;
  value: number;
  label?: string;
}

export interface CorsiaProps {
  label: string;
  value: number | undefined;
  target: number | undefined;
  unit?: string;
  /** Eventi che compongono il valore (pasti, sedute, notti): diventano segmenti separati. */
  segments?: CorsiaSegment[];
  /** Valori dei giorni precedenti, mostrati come tacche sottili sopra la corsia. */
  history?: number[];
  /** Colore del riempimento (variabile CSS). */
  color?: string;
  compact?: boolean;
  format?: (n: number) => string;
  foot?: ReactNode;
  /** Fondo scala esplicito (es. passi di una procedura): senza, la scala arriva al 125% dell'obiettivo. */
  max?: number;
  /** Segmento evidenziato: gli altri si attenuano. */
  highlight?: string | null;
  onSegment?: (id: string) => void;
}

/**
 * La Corsia: elemento firma di Foro. Ogni quantità con un obiettivo è una corsia di pista
 * che si riempie evento per evento, con la tacca dell'obiettivo e il tratteggio oltre la tacca.
 * Si anima solo quando arriva un dato nuovo mentre è visibile, mai al ritorno sulla schermata.
 */
export function Corsia({
  label,
  value,
  target,
  unit,
  segments,
  history,
  color,
  compact,
  format = fmtInt,
  foot,
  max,
  highlight,
  onSegment,
}: CorsiaProps) {
  const [anim, setAnim] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    // Dopo il primo disegno le variazioni si animano; il primo disegno no.
    const id = requestAnimationFrame(() => {
      mounted.current = true;
      setAnim(true);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const v = value ?? 0;
  const hasTarget = target !== undefined && target > 0;
  const scaleMax = max ?? Math.max(hasTarget ? target! * 1.25 : 0, v, ...(history ?? []), 1);
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scaleMax) * 100))}%`;
  const over = hasTarget && v > target! ? v - target! : 0;

  const segs: CorsiaSegment[] =
    segments && segments.length > 0 ? segments.filter((s) => s.value > 0) : v > 0 ? [{ id: 'tot', value: v }] : [];

  const valueText =
    value === undefined
      ? 'n.d.'
      : hasTarget
        ? `${format(v)} di ${format(target!)}${unit ? ' ' + unit : ''}`
        : `${format(v)}${unit ? ' ' + unit : ''}`;

  return (
    <div
      className={`corsia${compact ? ' corsia--compact' : ''}`}
      data-anim={anim ? 'on' : 'off'}
      style={color ? ({ '--corsia-color': color } as React.CSSProperties) : undefined}
    >
      <div className="corsia-head">
        <span className="corsia-label">{label}</span>
        <span className="corsia-value num">
          {value === undefined ? (
            <span className="of">n.d.</span>
          ) : (
            <>
              {format(v)}
              {hasTarget && <span className="of"> / {format(target!)}</span>}
              {unit && <span className="unit">{unit}</span>}
            </>
          )}
        </span>
      </div>
      <div
        className="corsia-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={hasTarget ? target : undefined}
        aria-valuenow={value}
        aria-valuetext={valueText}
      >
        {history && history.length > 0 && (
          <div className="corsia-history" aria-hidden="true">
            {history.map((h, i) => (
              <i key={i} style={{ left: pct(h) }} />
            ))}
          </div>
        )}
        <div className="corsia-lane" aria-hidden="true">
          <div className="corsia-fill" style={{ width: pct(v) }}>
            {segs.map((s) => (
              <span
                key={s.id}
                className="corsia-seg"
                title={s.label}
                data-dim={highlight != null && highlight !== s.id ? 'true' : 'false'}
                style={{ flex: `${s.value} 1 0`, minWidth: 2 }}
                onClick={onSegment ? () => onSegment(s.id) : undefined}
              />
            ))}
          </div>
          {over > 0 && <div className="corsia-over" style={{ left: pct(target!), width: pct(over) }} />}
        </div>
        {hasTarget && <span className="corsia-notch" style={{ left: pct(target!) }} aria-hidden="true" />}
      </div>
      {foot && <div className="corsia-foot">{foot}</div>}
    </div>
  );
}
