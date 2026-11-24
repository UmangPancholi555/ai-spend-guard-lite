/**
 * QA bug #8: a VIEWER (read-only) account must see every mutating control disabled (visible, aria-disabled,
 * title "Read-only account") and no write request may leave the browser, including through a form submit
 * (Enter key). ADMIN behaviour must stay unchanged. The server still enforces roles; these tests cover the UI only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { READ_ONLY_TITLE, writeGuardProps } from './readOnly';
import SeedDemoButton from '../dashboard/SeedDemoButton';
import BudgetForm from '../budgets/BudgetForm';
import BudgetRow from '../budgets/BudgetRow';
import ProjectForm from '../projects/ProjectForm';
import MemoryPanel from '../memory/MemoryPanel';
import NewVersionTab from '../pricing/NewVersionTab';
import UsersCard from './UsersCard';
import ChangePasswordCard from './ChangePasswordCard';
import SettingsPage from '../../pages/SettingsPage';
import ProjectsPage from '../../pages/ProjectsPage';
import SimulatorPage from '../../pages/SimulatorPage';

type Role = 'ADMIN' | 'VIEWER';

const h = vi.hoisted(() => ({
  role: 'ADMIN' as 'ADMIN' | 'VIEWER',
  api: { get: vi.fn(), list: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock('./AuthProvider', () => ({
  useAuth: () => ({
    loading: false, authEnabled: true, setupRequired: false,
    user: { id: 'me', username: h.role === 'ADMIN' ? 'admin' : 'viewer', role: h.role },
    isAdmin: h.role === 'ADMIN', canWrite: h.role === 'ADMIN',
    login: vi.fn(), setup: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
  }),
}));

vi.mock('../../lib/api', async importOriginal => {
  const real = await importOriginal<typeof import('../../lib/api')>();
  return { ...real, api: { ...real.api, ...h.api } };
});

const NOW = '2026-01-01T00:00:00.000Z';
const project = {
  id: 'p1', name: 'Alpha', description: null, isTest: true, status: 'ACTIVE', createdAt: NOW, updatedAt: NOW, archivedAt: null,
  usage: { requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: '0', lastActivityAt: null },
};
const pagination = { page: 1, pageSize: 25, total: 1, totalPages: 1 };
const budget = { id: 'b1', name: 'Cap', period: 'MONTHLY', projectId: null, projectName: null, active: true, limitUsd: '10.000000' };
const memoryItem = { id: 'm1', title: 'Tone', category: 'instructions', content: 'Be brief.', enabled: true, sizeBytes: 9, estimatedTokens: 3 };
const providers = [{ key: 'openai', displayName: 'OpenAI', models: [{ name: 'gpt-4o', displayName: 'GPT-4o', active: true }] }];
const users = [{ id: 'u2', username: 'bob', role: 'VIEWER', locked: false, lockedUntil: null, lastLoginAt: null, activeSessions: 0 }];
const task = { id: 't1', name: 'retention-sweep', kind: 'RETENTION', status: 'SUCCESS', source: 'ACTUAL', traceId: null, startedAt: NOW, endedAt: NOW, durationMs: 3, result: {}, errorMessage: null, stack: null, createdAt: NOW };

beforeEach(() => {
  for (const f of Object.values(h.api)) f.mockReset();
  h.api.get.mockImplementation(async (path: string) => {
    if (path === '/settings') return { retentionDays: 30, slowOperationMs: 500 };
    if (path === '/providers') return providers;
    if (path === '/auth/users') return users;
    if (path.endsWith('/memory')) return [memoryItem];
    return [];
  });
  h.api.list.mockResolvedValue({ data: [project], pagination });
  h.api.post.mockImplementation(async (path: string) => {
    if (path === '/logging/retention/run') return task;
    if (path === '/budgets') return budget;
    if (path === '/auth/password') return { otherSessionsRevoked: 0 };
    return {};
  });
  h.api.put.mockResolvedValue({ retentionDays: 31, slowOperationMs: 500 });
});

function renderAs(role: Role, ui: ReactElement) {
  h.role = role;
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>);
}

const writes = () => [...h.api.post.mock.calls, ...h.api.put.mock.calls, ...h.api.patch.mock.calls, ...h.api.del.mock.calls];

function expectReadOnly(el: HTMLElement) {
  expect((el as HTMLButtonElement).disabled, el.dataset.testid).toBe(true);
  expect(el.getAttribute('aria-disabled'), el.dataset.testid).toBe('true');
  expect(el.getAttribute('title'), el.dataset.testid).toBe(READ_ONLY_TITLE);
}
function expectWritable(el: HTMLElement) {
  expect((el as HTMLButtonElement).disabled, el.dataset.testid).toBe(false);
  expect(el.getAttribute('aria-disabled'), el.dataset.testid).toBeNull();
  expect(el.getAttribute('title'), el.dataset.testid).not.toBe(READ_ONLY_TITLE);
}

describe('writeGuardProps', () => {
  it('read-only: always disabled, aria-disabled and the read-only title (overrides other titles)', () => {
    expect(writeGuardProps(true)).toEqual({ disabled: true, 'aria-disabled': true, title: READ_ONLY_TITLE });
    expect(writeGuardProps(true, false, 'Only test projects can be deleted')).toEqual({ disabled: true, 'aria-disabled': true, title: READ_ONLY_TITLE });
  });
  it('writable: disabled only by the other condition, keeps its own title, no aria-disabled', () => {
    expect(writeGuardProps(false)).toEqual({ disabled: false });
    expect(writeGuardProps(false, true)).toEqual({ disabled: true });
    expect(writeGuardProps(false, true, 'Only test projects can be deleted')).toEqual({ disabled: true, title: 'Only test projects can be deleted' });
  });
});

describe('SeedDemoButton (dashboard seed)', () => {
  it('VIEWER: disabled, click sends nothing', () => {
    renderAs('VIEWER', <SeedDemoButton onDone={() => {}} />);
    const b = screen.getByTestId('dashboard-seed');
    expectReadOnly(b);
    fireEvent.click(b);
    expect(writes()).toEqual([]);
  });
  it('ADMIN: enabled, click seeds', async () => {
    renderAs('ADMIN', <SeedDemoButton onDone={() => {}} />);
    const b = screen.getByTestId('dashboard-seed');
    expectWritable(b);
    fireEvent.click(b);
    await waitFor(() => expect(h.api.post).toHaveBeenCalledWith('/simulations/seed', expect.anything()));
  });
});

describe('BudgetForm (create budget)', () => {
  it('VIEWER: submit and inputs disabled; a form submit (Enter) sends nothing', () => {
    renderAs('VIEWER', <BudgetForm projects={[]} onCreated={() => {}} />);
    expectReadOnly(screen.getByTestId('budget-create-submit'));
    for (const id of ['budget-create-project', 'budget-create-name', 'budget-create-period', 'budget-create-limit']) {
      expect((screen.getByTestId(id) as HTMLInputElement).disabled, id).toBe(true);
    }
    fireEvent.submit(screen.getByTestId('budget-create-form'));
    expect(writes()).toEqual([]);
  });
  it('ADMIN: enabled; submit creates the budget', async () => {
    renderAs('ADMIN', <BudgetForm projects={[]} onCreated={() => {}} />);
    expectWritable(screen.getByTestId('budget-create-submit'));
    fireEvent.change(screen.getByTestId('budget-create-name'), { target: { value: 'Cap' } });
    fireEvent.change(screen.getByTestId('budget-create-limit'), { target: { value: '10' } });
    fireEvent.submit(screen.getByTestId('budget-create-form'));
    await waitFor(() => expect(h.api.post).toHaveBeenCalledWith('/budgets', expect.objectContaining({ name: 'Cap', limitUsd: '10' })));
  });
});

describe('BudgetRow (activate / edit / delete)', () => {
  const row = <ul><BudgetRow budget={budget as never} util={undefined} reloadKey={0} onChanged={() => {}} /></ul>;
  it('VIEWER: toggle, edit and delete disabled; history stays usable', () => {
    renderAs('VIEWER', row);
    for (const id of ['budget-toggle-active', 'budget-edit', 'budget-delete']) expectReadOnly(screen.getByTestId(id));
    expectWritable(screen.getByTestId('budget-history-toggle'));
  });
  it('ADMIN: toggle, edit and delete enabled', () => {
    renderAs('ADMIN', row);
    for (const id of ['budget-toggle-active', 'budget-edit', 'budget-delete']) expectWritable(screen.getByTestId(id));
  });
});

describe('SettingsPage (settings + retention run)', () => {
  it('VIEWER: save, inputs and retention run disabled; a form submit sends nothing', async () => {
    renderAs('VIEWER', <SettingsPage />);
    const save = await screen.findByTestId('settings-save');
    expectReadOnly(save);
    expectReadOnly(screen.getByTestId('settings-retention-run'));
    expect((screen.getByTestId('settings-retention-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('settings-slow-input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('settings-form'));
    fireEvent.click(screen.getByTestId('settings-retention-run'));
    expect(writes()).toEqual([]);
  });
  it('ADMIN: editing enables save, submit saves; retention run works', async () => {
    renderAs('ADMIN', <SettingsPage />);
    const input = await screen.findByTestId('settings-retention-input');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('30'));
    fireEvent.change(input, { target: { value: '31' } });
    expectWritable(screen.getByTestId('settings-save'));
    fireEvent.submit(screen.getByTestId('settings-form'));
    await waitFor(() => expect(h.api.put).toHaveBeenCalledWith('/settings', { retentionDays: 31, slowOperationMs: 500 }));
    const run = screen.getByTestId('settings-retention-run');
    expectWritable(run);
    fireEvent.click(run);
    await waitFor(() => expect(h.api.post).toHaveBeenCalledWith('/logging/retention/run'));
  });
});

describe('ProjectsPage (create / rename / archive / delete)', () => {
  const ids = ['project-create-open', 'project-edit-alpha', 'project-archive-alpha', 'project-delete-alpha'];
  it('VIEWER: every project action disabled and no dialog can open', async () => {
    renderAs('VIEWER', <ProjectsPage />);
    await screen.findByTestId('project-row-alpha');
    for (const id of ids) expectReadOnly(screen.getByTestId(id));
    fireEvent.click(screen.getByTestId('project-create-open'));
    expect(screen.queryByTestId('project-create-dialog')).toBeNull();
    expect(writes()).toEqual([]);
  });
  it('ADMIN: actions enabled; delete of a non-test project keeps its own reason', async () => {
    renderAs('ADMIN', <ProjectsPage />);
    await screen.findByTestId('project-row-alpha');
    for (const id of ids) expectWritable(screen.getByTestId(id));
    expect(screen.getByTestId('project-delete-alpha').getAttribute('title')).toBe('Delete this test project and its usage data');
  });
  it('ADMIN: a non-test project still cannot be deleted (unchanged)', async () => {
    h.api.list.mockResolvedValue({ data: [{ ...project, isTest: false }], pagination });
    renderAs('ADMIN', <ProjectsPage />);
    const del = await screen.findByTestId('project-delete-alpha');
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute('aria-disabled')).toBeNull();
    expect(del.getAttribute('title')).toBe('Only test projects can be deleted');
  });
});

describe('ProjectForm (keyboard submit path)', () => {
  it('VIEWER: submit button disabled; a form submit does not call onSubmit', () => {
    const onSubmit = vi.fn(async () => {});
    renderAs('VIEWER', <ProjectForm mode="create" onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'New one' } });
    expectReadOnly(screen.getByTestId('project-create-submit'));
    fireEvent.submit(screen.getByTestId('project-form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('ADMIN: a form submit calls onSubmit', async () => {
    const onSubmit = vi.fn(async () => {});
    renderAs('ADMIN', <ProjectForm mode="edit" initial={{ name: 'Old', description: null, isTest: false }} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'Renamed' } });
    expectWritable(screen.getByTestId('project-edit-submit'));
    fireEvent.submit(screen.getByTestId('project-form'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'Renamed', description: '', isTest: false }));
  });
});

describe('MemoryPanel (memory items)', () => {
  const ids = ['memory-add-toggle', 'memory-item-toggle', 'memory-item-edit', 'memory-item-delete'];
  it('VIEWER: add, enable toggle, edit and delete disabled; the add form cannot open', async () => {
    renderAs('VIEWER', <MemoryPanel projectId="p1" />);
    await screen.findByTestId('memory-item');
    for (const id of ids) expectReadOnly(screen.getByTestId(id));
    fireEvent.click(screen.getByTestId('memory-add-toggle'));
    expect(screen.queryByTestId('memory-add-form')).toBeNull();
    expect(writes()).toEqual([]);
  });
  it('ADMIN: everything enabled and the add form opens', async () => {
    renderAs('ADMIN', <MemoryPanel projectId="p1" />);
    await screen.findByTestId('memory-item');
    for (const id of ids) expectWritable(screen.getByTestId(id));
    fireEvent.click(screen.getByTestId('memory-add-toggle'));
    expectWritable(screen.getByTestId('memory-add-submit'));
  });
});

describe('SimulatorPage (send / seed / agent run / quick project)', () => {
  const ids = ['simulator-submit', 'simulator-seed', 'simulator-agent-run', 'sim-quick-toggle'];
  it('VIEWER: every write control disabled; a form submit sends nothing', async () => {
    renderAs('VIEWER', <SimulatorPage />);
    await screen.findByTestId('simulator-form');
    await waitFor(() => expect((screen.getByTestId('sim-project') as HTMLSelectElement).value).toBe('p1'));
    for (const id of ids) expectReadOnly(screen.getByTestId(id));
    fireEvent.submit(screen.getByTestId('simulator-form'));
    expect(writes()).toEqual([]);
  });
  it('ADMIN: write controls enabled', async () => {
    renderAs('ADMIN', <SimulatorPage />);
    await screen.findByTestId('simulator-form');
    await waitFor(() => expect((screen.getByTestId('sim-project') as HTMLSelectElement).value).toBe('p1'));
    for (const id of ids) expectWritable(screen.getByTestId(id));
  });
});

describe('NewVersionTab (pricing price versions)', () => {
  it('VIEWER: create disabled, impact preview (calculator) stays enabled; a form submit sends nothing', () => {
    renderAs('VIEWER', <NewVersionTab rows={[]} onCreated={() => {}} />);
    expectReadOnly(screen.getByTestId('pricing-new-submit'));
    expectWritable(screen.getByTestId('pricing-new-preview'));
    fireEvent.submit(screen.getByTestId('pricing-new-form'));
    expect(writes()).toEqual([]);
  });
  it('ADMIN: create enabled', () => {
    renderAs('ADMIN', <NewVersionTab rows={[]} onCreated={() => {}} />);
    expectWritable(screen.getByTestId('pricing-new-submit'));
  });
});

describe('UsersCard (user management)', () => {
  it('VIEWER (defence in depth; the page hides the card): role, reset, delete and create disabled; submit sends nothing', async () => {
    renderAs('VIEWER', <UsersCard currentUserId="me" />);
    await screen.findByTestId('account-user-row-bob');
    for (const id of ['account-user-role-bob', 'account-user-reset-bob', 'account-user-delete-bob', 'account-create-user']) expectReadOnly(screen.getByTestId(id));
    fireEvent.submit(screen.getByTestId('account-create-user-form'));
    expect(writes()).toEqual([]);
  });
  it('ADMIN: role, reset and delete enabled', async () => {
    renderAs('ADMIN', <UsersCard currentUserId="me" />);
    await screen.findByTestId('account-user-row-bob');
    for (const id of ['account-user-role-bob', 'account-user-reset-bob', 'account-user-delete-bob']) expectWritable(screen.getByTestId(id));
  });
});

describe('own password change stays available to VIEWER', () => {
  it('VIEWER: the change-password form is enabled and submits', async () => {
    renderAs('VIEWER', <ChangePasswordCard />);
    fireEvent.change(screen.getByTestId('account-current-password'), { target: { value: 'old-password-123' } });
    fireEvent.change(screen.getByTestId('account-new-password'), { target: { value: 'a-much-longer-new-password' } });
    fireEvent.change(screen.getByTestId('account-confirm-password'), { target: { value: 'a-much-longer-new-password' } });
    expectWritable(screen.getByTestId('account-password-submit'));
    fireEvent.submit(screen.getByTestId('account-password-form'));
    await waitFor(() => expect(h.api.post).toHaveBeenCalledWith('/auth/password', expect.anything()));
  });
});
