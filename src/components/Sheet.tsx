import { useEffect, useRef, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Testo per lettori di schermo quando il titolo non è visibile. */
  label?: string;
}

/** Foglio dal basso basato su <dialog>: focus intrappolato, Esc e tocco fuori chiudono. */
export function Sheet({ open, onClose, title, children, label }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (e.target === d) onClose();
    };
    d.addEventListener('cancel', onCancel);
    d.addEventListener('click', onClick);
    return () => {
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('click', onClick);
    };
  }, [onClose]);

  return (
    <dialog ref={ref} className="sheet" aria-label={title ?? label}>
      <div className="sheet-handle" aria-hidden="true" />
      <div className="sheet-head">
        {title ? <h2 className="sheet-title">{title}</h2> : <span />}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Chiudi">
          <X size={22} />
        </button>
      </div>
      <div className="sheet-body">{open ? children : null}</div>
    </dialog>
  );
}
