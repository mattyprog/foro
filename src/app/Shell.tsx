import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Barbell,
  Barcode,
  Camera,
  ForkKnife,
  Heartbeat,
  MagnifyingGlass,
  Plus,
  Scales,
  SunHorizon,
  TextAa,
} from '@phosphor-icons/react';
import { Sheet } from '@/components/Sheet';

const TABS = [
  { href: '/', label: 'Oggi', icon: SunHorizon, match: (p: string) => p === '/' },
  { href: '/dieta', label: 'Dieta', icon: ForkKnife, match: (p: string) => p.startsWith('/dieta') },
  null,
  { href: '/allenamento', label: 'Allenamento', icon: Barbell, match: (p: string) => p.startsWith('/allenamento') },
  { href: '/salute', label: 'Salute', icon: Heartbeat, match: (p: string) => p.startsWith('/salute') },
] as const;

export function BottomNav({ onPlus }: { onPlus: () => void }) {
  const [path] = useLocation();
  return (
    <nav className="nav" aria-label="Sezioni">
      <div className="nav-inner">
        {TABS.map((t, i) => {
          if (!t)
            return (
              <button key={i} type="button" className="nav-plus" onClick={onPlus} aria-label="Registra">
                <Plus size={24} weight="bold" />
              </button>
            );
          const active = t.match(path);
          const Icon = t.icon;
          return (
            <Link key={t.href} href={t.href} className="nav-item" aria-current={active ? 'page' : undefined}>
              <Icon size={24} weight={active ? 'fill' : 'regular'} />
              <span>{t.label}</span>
              <span className="nav-mark" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function QuickItem({ icon, title, sub, onClick, main }: { icon: ReactNode; title: string; sub: string; onClick: () => void; main?: boolean }) {
  return (
    <button type="button" className={`quick-item${main ? ' quick-item--main' : ''}`} onClick={onClick}>
      {icon}
      <span>
        {title}
        <small style={{ display: 'block' }}>{sub}</small>
      </span>
    </button>
  );
}

/** Il + centrale: registrare al volo da qualunque schermata. */
export function QuickSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  return (
    <Sheet open={open} onClose={onClose} title="Registra">
      <div className="quick-grid">
        <QuickItem main icon={<Camera size={26} />} title="Fotografa il piatto" sub="Riconosce alimenti e grammi" onClick={() => go('/dieta/foto')} />
        <QuickItem icon={<Barcode size={24} />} title="Codice a barre" sub="Prodotti confezionati" onClick={() => go('/dieta/codice')} />
        <QuickItem icon={<MagnifyingGlass size={24} />} title="Cerca alimento" sub="Database e piatti romani" onClick={() => go('/dieta/cerca')} />
        <QuickItem icon={<TextAa size={24} />} title="Scrivi il pasto" sub="«200 g di pollo e riso»" onClick={() => go('/dieta/testo')} />
        <QuickItem icon={<Barbell size={24} />} title="Inizia allenamento" sub="Dalla tua scheda" onClick={() => go('/palestra')} />
        <QuickItem icon={<Scales size={24} />} title="Peso di oggi" sub="Aggiorna la tendenza" onClick={() => go('/salute/peso')} />
      </div>
    </Sheet>
  );
}

export function useQuickSheet() {
  const [open, setOpen] = useState(false);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}
