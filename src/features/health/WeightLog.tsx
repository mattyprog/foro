import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Trash } from '@phosphor-icons/react';
import { db } from '@/db/db';
import { Stepper } from '@/components/Stepper';
import { WeightChart } from '@/components/charts/Charts';
import { useToast } from '@/components/ui';
import { addDays, parseISODate, todayISO } from '@/lib/dates';
import { fmt1, fmtRelativeDay } from '@/lib/format';
import { weightTrend } from './weight';

export function WeightLog() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const today = todayISO();
  const all = useLiveQuery(() => db.weights.orderBy('date').toArray(), []);
  const [kg, setKg] = useState<number | null>(null);

  useEffect(() => {
    if (kg !== null || !all) return;
    const t = all.find((w) => w.date === today) ?? all.at(-1);
    setKg(t?.kg ?? 70);
  }, [all, kg, today]);

  if (!all || kg === null) return <main className="screen" />;

  const recent = all.filter((w) => w.date >= addDays(today, -59));
  const trend = weightTrend(all).filter((t) => t.date >= addDays(today, -59));
  const lastT = trend.at(-1);

  const save = async () => {
    const prev = await db.weights.get(today);
    await db.weights.put({ date: today, kg, source: 'manuale', bodyFatPct: prev?.bodyFatPct });
    toast(`Peso salvato: ${fmt1(kg)} kg.`);
    navigate('/salute');
  };

  return (
    <main className="screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={() => navigate('/salute')} aria-label="Indietro">
          <ArrowLeft size={22} />
        </button>
        <div className="topbar-title" style={{ flex: 1 }}>
          <h1>Peso</h1>
          {lastT && (
            <span className="small muted">
              Tendenza <span className="num">{fmt1(lastT.kg)} kg</span>
            </span>
          )}
        </div>
      </header>

      <section className="section">
        <h2>{parseISODate(today).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        <Stepper big label="Peso di oggi" value={kg} onChange={setKg} step={0.1} dragStep={0.1} min={30} max={250} unit="kg" format={fmt1} />
        <p className="small muted">Meglio la mattina, dopo il bagno e prima di mangiare. Conta la tendenza, non il singolo giorno.</p>
        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={save}>
          Salva
        </button>
      </section>

      {recent.length > 1 && (
        <section className="section">
          <h2>Ultimi 60 giorni</h2>
          <WeightChart points={recent.map((w) => ({ date: w.date, kg: w.kg }))} trend={trend} />
        </section>
      )}

      {recent.length > 0 && (
        <section className="section">
          <h2>Pesate</h2>
          <div className="list">
            {[...recent]
              .reverse()
              .slice(0, 21)
              .map((w) => (
                <div key={w.date} className="row">
                  <div className="row-main">
                    <span className="row-title">{fmtRelativeDay(w.date, today)}</span>
                    <span className="row-sub">{w.source === 'garmin' ? 'dalla bilancia Garmin' : 'inserito a mano'}</span>
                  </div>
                  <span className="num">{fmt1(w.kg)} kg</span>
                  {w.source === 'manuale' && (
                    <button type="button" className="icon-btn" aria-label="Elimina pesata" onClick={() => db.weights.delete(w.date)}>
                      <Trash size={20} />
                    </button>
                  )}
                </div>
              ))}
          </div>
        </section>
      )}
    </main>
  );
}
