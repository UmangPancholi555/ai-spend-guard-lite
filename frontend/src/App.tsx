import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { AuthProvider } from './components/auth/AuthProvider';
import RequireAuth from './components/auth/RequireAuth';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { Loading } from './components/ui/State';
import { titleForPath } from './lib/nav';

// Every page is its own chunk, loaded on first visit.
const pages = {
  dashboard: () => import('./pages/DashboardPage'),
  projects: () => import('./pages/ProjectsPage'),
  projectDetail: () => import('./pages/ProjectDetailPage'),
  usage: () => import('./pages/UsagePage'),
  simulator: () => import('./pages/SimulatorPage'),
  budgets: () => import('./pages/BudgetsPage'),
  activity: () => import('./pages/ActivityPage'),
  traces: () => import('./pages/TracesPage'),
  traceDetail: () => import('./pages/TraceDetailPage'),
  observability: () => import('./pages/ObservabilityPage'),
  errors: () => import('./pages/ErrorsPage'),
  logs: () => import('./pages/LogsPage'),
  settings: () => import('./pages/SettingsPage'),
  pricing: () => import('./pages/PricingPage'),
  login: () => import('./pages/LoginPage'),
  setup: () => import('./pages/SetupPage'),
  account: () => import('./pages/AccountPage'),
  notFound: () => import('./pages/NotFoundPage'),
};
const DashboardPage = lazy(pages.dashboard);
const ProjectsPage = lazy(pages.projects);
const ProjectDetailPage = lazy(pages.projectDetail);
const UsagePage = lazy(pages.usage);
const SimulatorPage = lazy(pages.simulator);
const BudgetsPage = lazy(pages.budgets);
const ActivityPage = lazy(pages.activity);
const TracesPage = lazy(pages.traces);
const TraceDetailPage = lazy(pages.traceDetail);
const ObservabilityPage = lazy(pages.observability);
const ErrorsPage = lazy(pages.errors);
const LogsPage = lazy(pages.logs);
const SettingsPage = lazy(pages.settings);
const PricingPage = lazy(pages.pricing);
const LoginPage = lazy(pages.login);
const SetupPage = lazy(pages.setup);
const AccountPage = lazy(pages.account);
const NotFoundPage = lazy(pages.notFound);

// The landing page downloads in parallel with the session check, so it can start loading data the moment the shell renders.
// All other pages are fetched in the background once the browser is idle, so later navigation is instant.
if (typeof window !== 'undefined') {
  void pages.dashboard().catch(() => undefined);
  const prefetchAll = () => { for (const load of Object.values(pages)) void load().catch(() => undefined); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(prefetchAll, { timeout: 3000 });
  else setTimeout(prefetchAll, 1500);
}

/** Keeps document.title in sync with the route ("Budgets & Alerts - AI Spend Guard Lite"). */
function TitleManager() {
  const { pathname } = useLocation();
  useEffect(() => { document.title = titleForPath(pathname); }, [pathname]);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <TitleManager />
      <ErrorBoundary scope="app">
        <Suspense fallback={<Loading variant="lines" label="Loading page..." />}>
          <Routes>
            <Route path="login" element={<LoginPage />} />
            <Route path="setup" element={<SetupPage />} />
            <Route element={<RequireAuth />}>
              <Route element={<Layout />}>
                <Route index element={<DashboardPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="projects/:id" element={<ProjectDetailPage />} />
                <Route path="usage" element={<UsagePage />} />
                <Route path="simulator" element={<SimulatorPage />} />
                <Route path="pricing" element={<PricingPage />} />
                <Route path="budgets" element={<BudgetsPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="traces" element={<TracesPage />} />
                <Route path="traces/:traceId" element={<TraceDetailPage />} />
                <Route path="observability" element={<ObservabilityPage />} />
                <Route path="errors" element={<ErrorsPage />} />
                <Route path="logs" element={<LogsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="account" element={<AccountPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AuthProvider>
  );
}
