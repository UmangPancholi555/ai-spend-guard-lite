import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import UsagePage from './pages/UsagePage';
import SimulatorPage from './pages/SimulatorPage';
import BudgetsPage from './pages/BudgetsPage';
import ActivityPage from './pages/ActivityPage';
import TracesPage from './pages/TracesPage';
import TraceDetailPage from './pages/TraceDetailPage';
import ObservabilityPage from './pages/ObservabilityPage';
import ErrorsPage from './pages/ErrorsPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="simulator" element={<SimulatorPage />} />
        <Route path="budgets" element={<BudgetsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="traces" element={<TracesPage />} />
        <Route path="traces/:traceId" element={<TraceDetailPage />} />
        <Route path="observability" element={<ObservabilityPage />} />
        <Route path="errors" element={<ErrorsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="p-6">Page not found</div>} />
      </Route>
    </Routes>
  );
}
