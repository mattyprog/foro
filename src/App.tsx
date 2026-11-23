import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Router, Route, Switch, useLocation, Redirect } from 'wouter';
import { useHashPath, useHashSearch } from '@/app/hashLocation';
import { applyTheme, useProfile, useSetting, type ThemePref } from '@/app/hooks';
import { maybeAutoSync } from '@/app/garminSync';
import { BottomNav, QuickSheet, useQuickSheet } from '@/app/Shell';
import { ToastProvider } from '@/components/ui';
import { Today } from '@/features/today/Today';
import { Diet } from '@/features/diet/Diet';
import { Training } from '@/features/training/Training';
import { Health } from '@/features/health/Health';

// Le quattro schede principali partono subito; il resto si carica quando serve (resta comunque offline).
const Onboarding = lazy(() => import('@/features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })));
const PhotoFlow = lazy(() => import('@/features/diet/PhotoFlow').then((m) => ({ default: m.PhotoFlow })));
const FoodSearch = lazy(() => import('@/features/diet/FoodSearch').then((m) => ({ default: m.FoodSearch })));
const BarcodeFlow = lazy(() => import('@/features/diet/BarcodeFlow').then((m) => ({ default: m.BarcodeFlow })));
const TextFlow = lazy(() => import('@/features/diet/TextFlow').then((m) => ({ default: m.TextFlow })));
const MenuDay = lazy(() => import('@/features/diet/MenuDay').then((m) => ({ default: m.MenuDay })));
const ActivityDetail = lazy(() => import('@/features/training/ActivityDetail').then((m) => ({ default: m.ActivityDetail })));
const SessionDetail = lazy(() => import('@/features/training/SessionDetail').then((m) => ({ default: m.SessionDetail })));
const PlanEditor = lazy(() => import('@/features/training/PlanEditor').then((m) => ({ default: m.PlanEditor })));
const GymMode = lazy(() => import('@/features/training/GymMode').then((m) => ({ default: m.GymMode })));
const WeightLog = lazy(() => import('@/features/health/WeightLog').then((m) => ({ default: m.WeightLog })));
const Settings = lazy(() => import('@/features/settings/Settings').then((m) => ({ default: m.Settings })));

/** Schermate a tutto schermo: niente barra in basso. */
const FULL = ['/benvenuto', '/palestra', '/dieta/foto', '/dieta/codice', '/dieta/cerca', '/dieta/testo', '/dieta/menu', '/profilo/modifica'];

function Frame({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const quick = useQuickSheet();
  const full = FULL.some((p) => path.startsWith(p));
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);
  return (
    <div className="shell">
      {children}
      {!full && <BottomNav onPlus={quick.show} />}
      <QuickSheet open={quick.open} onClose={quick.hide} />
    </div>
  );
}

function FirstRunGate() {
  const profile = useProfile();
  const [done, , l1] = useSetting<boolean>('onboarding.done', false);
  const [skipped, , l2] = useSetting<boolean>('onboarding.skipped', false);
  const [path] = useLocation();
  if (profile === null || l1 || l2) return null;
  if (!profile && !done && !skipped && path === '/') return <Redirect to="/benvenuto" />;
  return null;
}

function Welcome() {
  return <Onboarding />;
}

function EditProfile() {
  const profile = useProfile();
  if (profile === null) return null;
  return <Onboarding existing={profile ?? undefined} />;
}

export default function App() {
  const [theme] = useSetting<ThemePref>('theme', 'system');
  useEffect(() => {
    void maybeAutoSync();
    const onVis = () => document.visibilityState === 'visible' && void maybeAutoSync();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme(theme);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);

  return (
    <ToastProvider>
      <Router hook={useHashPath} searchHook={useHashSearch}>
        <Frame>
          <FirstRunGate />
          <Suspense fallback={<main className="screen" aria-busy="true" />}>
            <Switch>
              <Route path="/" component={Today} />
              <Route path="/benvenuto" component={Welcome} />
              <Route path="/dieta" component={Diet} />
              <Route path="/dieta/foto" component={PhotoFlow} />
              <Route path="/dieta/cerca" component={FoodSearch} />
              <Route path="/dieta/codice" component={BarcodeFlow} />
              <Route path="/dieta/testo" component={TextFlow} />
              <Route path="/dieta/menu" component={MenuDay} />
              <Route path="/allenamento" component={Training} />
              <Route path="/allenamento/attivita/:id">{(p) => <ActivityDetail id={decodeURIComponent(p.id)} />}</Route>
              <Route path="/allenamento/seduta/:id">{(p) => <SessionDetail id={Number(p.id)} />}</Route>
              <Route path="/allenamento/scheda/:id">{(p) => <PlanEditor programId={decodeURIComponent(p.id)} />}</Route>
              <Route path="/palestra" component={GymMode} />
              <Route path="/salute" component={Health} />
              <Route path="/salute/peso" component={WeightLog} />
              <Route path="/profilo" component={Settings} />
              <Route path="/profilo/modifica" component={EditProfile} />
              <Route>
                <Redirect to="/" />
              </Route>
            </Switch>
          </Suspense>
        </Frame>
      </Router>
    </ToastProvider>
  );
}
