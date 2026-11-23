/** Single source of truth for navigation: sidebar sections, 404 page links and document titles. Link texts are relied on by e2e tests. */
export interface NavItem { to: string; label: string; end?: boolean }
export interface NavSection { id: string; label: string; items: NavItem[] }

export const NAV_SECTIONS: NavSection[] = [
  { id: 'overview', label: 'Overview', items: [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/projects', label: 'Projects' },
  ] },
  { id: 'costs', label: 'Costs', items: [
    { to: '/usage', label: 'Usage' },
    { to: '/simulator', label: 'Request Simulator' },
    { to: '/pricing', label: 'Pricing & Calculator' },
    { to: '/budgets', label: 'Budgets & Alerts' },
  ] },
  { id: 'observability', label: 'Observability', items: [
    { to: '/activity', label: 'Activity' },
    { to: '/traces', label: 'Traces' },
    { to: '/observability', label: 'Observability' },
    { to: '/errors', label: 'Error Log' },
    { to: '/logs', label: 'Execution Logs' },
  ] },
  { id: 'system', label: 'System', items: [
    { to: '/settings', label: 'Settings' },
  ] },
];

export const NAV: NavItem[] = NAV_SECTIONS.flatMap(s => s.items);

export const APP_NAME = 'AI Spend Guard Lite';

/** Page title for a pathname, e.g. "Budgets & Alerts - AI Spend Guard Lite". */
export function titleForPath(pathname: string): string {
  const clean = pathname.replace(/\/+$/, '') || '/';
  let label: string | undefined;
  if (/^\/projects\/[^/]+$/.test(clean)) label = 'Project details';
  else if (/^\/traces\/[^/]+$/.test(clean)) label = 'Trace details';
  else if (clean === '/login') label = 'Sign in';
  else if (clean === '/setup') label = 'Set up';
  else if (clean === '/account') label = 'Account';
  else label = NAV.find(n => n.to === clean)?.label ?? (clean === '/' ? 'Dashboard' : 'Page not found');
  return `${label} - ${APP_NAME}`;
}
