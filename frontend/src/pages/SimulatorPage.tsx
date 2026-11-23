import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MockProviderRequest, MockProviderResponse, ProjectWithUsage, ProviderDto, ProviderKey, SimulatedFailure } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Button, inputCls } from '../components/ui/Button';
import { Async } from '../components/ui/State';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import DemoBanner from '../components/dashboard/DemoBanner';
import ResponsePanel from '../components/simulator/ResponsePanel';
import { errMessage } from '../components/projects/util';

const CUSTOM = '__custom__';
const labelCls = 'mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400';
const errCls = 'rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200';

export default function SimulatorPage() {
  const providers = useAsync(() => api.get<ProviderDto[]>('/providers'), []);
  const projects = useAsync(() => api.list<ProjectWithUsage>('/projects', { status: 'ACTIVE', includeTest: true, pageSize: 200 }), []);
  const active = projects.data?.data ?? [];

  const [projectId, setProjectId] = useState('');
  const [provider, setProvider] = useState<ProviderKey | ''>('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [prompt, setPrompt] = useState('Summarize the quarterly spend report in three bullet points.');
  const [maxOutputTokens, setMaxOutputTokens] = useState('256');
  const [temperature, setTemperature] = useState('0.7');
  const [failure, setFailure] = useState<SimulatedFailure>('none');
  const [agentActivity, setAgentActivity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<MockProviderResponse>();

  // quick project create
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickErr, setQuickErr] = useState<string>();

  // seed + agent run
  const [seedRequests, setSeedRequests] = useState('200');
  const [seedDays, setSeedDays] = useState('14');
  const [seedFailures, setSeedFailures] = useState(true);
  const [seedAgent, setSeedAgent] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string>();
  const [seedErr, setSeedErr] = useState<string>();
  const [agentFail, setAgentFail] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState<string>();
  const [agentTrace, setAgentTrace] = useState<string>();

  const provList = providers.data ?? [];
  useEffect(() => { if (!provider && provList.length) setProvider(provList[0].key); }, [provList, provider]);
  useEffect(() => { if (!projectId && active.length) setProjectId(active[0].id); }, [active, projectId]);
  const models = (provList.find(p => p.key === provider)?.models ?? []).filter(m => m.active);
  useEffect(() => { if (!model && models.length) setModel(models[0].name); }, [models, model]);

  const effectiveModel = model === CUSTOM ? customModel.trim() : model;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const max = Number(maxOutputTokens);
    const temp = temperature.trim() === '' ? undefined : Number(temperature);
    if (!projectId) return setError('Select an active project (or create one).');
    if (!provider) return setError('Select a provider.');
    if (!effectiveModel) return setError('Enter a model name.');
    if (!prompt.trim()) return setError('Prompt is required.');
    if (!Number.isInteger(max) || max < 1) return setError('Max output tokens must be a positive whole number.');
    if (temp !== undefined && (!Number.isFinite(temp) || temp < 0 || temp > 2)) return setError('Temperature must be between 0 and 2.');
    const body: MockProviderRequest = { projectId, provider, model: effectiveModel, prompt, maxOutputTokens: max, simulateFailure: failure, simulateAgentActivity: agentActivity };
    if (temp !== undefined) body.temperature = temp;
    setBusy(true);
    try { setResult(await api.post<MockProviderResponse>('/providers/requests', body)); projects.reload(); }
    catch (err) { setError(errMessage(err)); setResult(undefined); }
    finally { setBusy(false); }
  }

  async function quickCreate(e: FormEvent) {
    e.preventDefault();
    const name = quickName.trim();
    if (!name) return setQuickErr('Name is required.');
    setQuickBusy(true); setQuickErr(undefined);
    try {
      const p = await api.post<ProjectWithUsage>('/projects', { name, isTest: true });
      projects.reload(); setProjectId(p.id); setQuickName(''); setQuickOpen(false);
    } catch (err) { setQuickErr(errMessage(err)); }
    finally { setQuickBusy(false); }
  }

  async function seed() {
    setSeedErr(undefined); setSeedMsg(undefined);
    const requests = Number(seedRequests), spreadDays = Number(seedDays);
    if (!Number.isInteger(requests) || requests < 1) return setSeedErr('Requests must be a positive whole number.');
    if (!Number.isInteger(spreadDays) || spreadDays < 1) return setSeedErr('Spread days must be a positive whole number.');
    setSeedBusy(true);
    try {
      const r = await api.post<{ taskId: string; created: number; projectId: string }>('/simulations/seed', {
        requests, spreadDays, includeFailures: seedFailures, includeAgentActivity: seedAgent,
        ...(projectId ? { projectId } : {}),
      });
      setSeedMsg(`Created ${r.created} simulated requests.`);
      projects.reload();
    } catch (err) { setSeedErr(errMessage(err)); }
    finally { setSeedBusy(false); }
  }

  async function agentRun() {
    setAgentErr(undefined); setAgentTrace(undefined);
    if (!projectId) return setAgentErr('Select an active project first.');
    setAgentBusy(true);
    try {
      const r = await api.post<{ traceId: string }>('/simulations/agent-run', { projectId, simulateFailure: agentFail ? 'error' : 'none' });
      setAgentTrace(r.traceId);
    } catch (err) { setAgentErr(errMessage(err)); }
    finally { setAgentBusy(false); }
  }

  const noProjects = !projects.loading && !projects.error && active.length === 0;

  return (
    <div>
      <PageHeader title="Request Simulator" subtitle="Send a request to the local mock provider and see tokens, cost and trace." />
      <DemoBanner>Everything here runs on this machine. Prompts are never sent anywhere and are never stored (only a hash and length). No external AI vendor is contacted.</DemoBanner>

      <Async loading={(providers.loading && !providers.data) || (projects.loading && !projects.data)} error={providers.error ?? projects.error}>
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <Card title="Mock provider request">
              <form onSubmit={submit} className="space-y-4" noValidate data-testid="simulator-form">
                <div>
                  <div className="flex items-end justify-between gap-2">
                    <label htmlFor="sim-project" className={labelCls}>Project (active)</label>
                    <button type="button" className="mb-1 text-xs text-brand-600 underline dark:text-brand-100" onClick={() => setQuickOpen(o => !o)} data-testid="sim-quick-toggle">
                      {quickOpen ? 'Cancel quick create' : 'Create project quickly'}
                    </button>
                  </div>
                  <select id="sim-project" className={`${inputCls} w-full`} value={projectId} onChange={e => setProjectId(e.target.value)} data-testid="sim-project">
                    {active.length === 0 && <option value="">No active projects</option>}
                    {active.map(p => <option key={p.id} value={p.id}>{p.name}{p.isTest ? ' (test)' : ''}</option>)}
                  </select>
                  {noProjects && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="sim-no-projects">No active projects yet. Create one below or on the <Link to="/projects" className="underline">Projects page</Link>.</p>}
                </div>
                {quickOpen && (
                  <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700" data-testid="sim-quick-form">
                    <label htmlFor="sim-quick-name" className={labelCls}>New test project name</label>
                    <div className="flex gap-2">
                      <input id="sim-quick-name" className={`${inputCls} min-w-0 flex-1`} value={quickName} onChange={e => setQuickName(e.target.value)} data-testid="sim-quick-name" />
                      <Button type="button" onClick={quickCreate as unknown as () => void} disabled={quickBusy} data-testid="sim-quick-submit">{quickBusy ? 'Creating...' : 'Create'}</Button>
                    </div>
                    {quickErr && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="sim-quick-error">{quickErr}</p>}
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="sim-provider" className={labelCls}>Provider</label>
                    <select id="sim-provider" className={`${inputCls} w-full`} value={provider} onChange={e => { const k = e.target.value as ProviderKey; setProvider(k); setModel(provList.find(p => p.key === k)?.models.find(m => m.active)?.name ?? CUSTOM); }} data-testid="sim-provider">
                      {provList.map(p => <option key={p.key} value={p.key}>{p.displayName}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="sim-model" className={labelCls}>Model</label>
                    <select id="sim-model" className={`${inputCls} w-full`} value={model} onChange={e => setModel(e.target.value)} data-testid="sim-model">
                      {models.map(m => <option key={m.name} value={m.name}>{m.displayName}</option>)}
                      <option value={CUSTOM}>Custom / unknown model...</option>
                    </select>
                  </div>
                </div>
                {model === CUSTOM && (
                  <div>
                    <label htmlFor="sim-custom-model" className={labelCls}>Custom model name</label>
                    <input id="sim-custom-model" className={`${inputCls} w-full`} value={customModel} placeholder="e.g. my-experimental-model" onChange={e => setCustomModel(e.target.value)} data-testid="sim-custom-model" />
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Unknown models are accepted; their cost is labeled ESTIMATED (fallback pricing).</p>
                  </div>
                )}

                <div>
                  <label htmlFor="sim-prompt" className={labelCls}>Prompt (never stored; only hash + length)</label>
                  <textarea id="sim-prompt" rows={4} className={`${inputCls} w-full`} value={prompt} onChange={e => setPrompt(e.target.value)} data-testid="sim-prompt" />
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <label htmlFor="sim-max" className={labelCls}>Max output tokens</label>
                    <input id="sim-max" type="number" min={1} step={1} className={`${inputCls} w-full`} value={maxOutputTokens} onChange={e => setMaxOutputTokens(e.target.value)} data-testid="sim-max-tokens" />
                  </div>
                  <div>
                    <label htmlFor="sim-temp" className={labelCls}>Temperature (0-2)</label>
                    <input id="sim-temp" type="number" min={0} max={2} step={0.1} className={`${inputCls} w-full`} value={temperature} onChange={e => setTemperature(e.target.value)} data-testid="sim-temperature" />
                  </div>
                  <div>
                    <label htmlFor="sim-failure" className={labelCls}>Simulate failure</label>
                    <select id="sim-failure" className={`${inputCls} w-full`} value={failure} onChange={e => setFailure(e.target.value as SimulatedFailure)} data-testid="sim-failure">
                      <option value="none">None</option>
                      <option value="error">Provider error</option>
                      <option value="timeout">Timeout</option>
                      <option value="rate_limit">Rate limit</option>
                    </select>
                  </div>
                </div>

                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={agentActivity} onChange={e => setAgentActivity(e.target.checked)} data-testid="sim-agent-activity" />
                  <span>Also emit simulated agent activity <span className="block text-xs text-slate-500 dark:text-slate-400">Adds SIMULATED context, memory, bus and tool events to this request's trace.</span></span>
                </label>

                {error && <p role="alert" className={errCls} data-testid="simulator-error">{error}</p>}
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy || noProjects} data-testid="simulator-submit">{busy ? 'Sending...' : 'Send mock request'}</Button>
                </div>
              </form>
            </Card>
            {result && <ResponsePanel r={result} />}
          </div>

          <div className="space-y-4">
            <Card title="Seed demo data">
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Generates backdated DEMO / SIMULATED requests through the same pipeline. Leave the project as selected to target it.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="seed-requests" className={labelCls}>Requests</label>
                  <input id="seed-requests" type="number" min={1} className={`${inputCls} w-full`} value={seedRequests} onChange={e => setSeedRequests(e.target.value)} data-testid="seed-requests" />
                </div>
                <div>
                  <label htmlFor="seed-days" className={labelCls}>Spread over days</label>
                  <input id="seed-days" type="number" min={1} className={`${inputCls} w-full`} value={seedDays} onChange={e => setSeedDays(e.target.value)} data-testid="seed-days" />
                </div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={seedFailures} onChange={e => setSeedFailures(e.target.checked)} data-testid="seed-failures" /> Include failures</label>
              <label className="mt-1 flex items-center gap-2 text-sm"><input type="checkbox" checked={seedAgent} onChange={e => setSeedAgent(e.target.checked)} data-testid="seed-agent" /> Include agent activity</label>
              <div className="mt-3"><Button onClick={seed} disabled={seedBusy} data-testid="simulator-seed">{seedBusy ? 'Seeding...' : 'Seed demo data'}</Button></div>
              {seedMsg && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300" role="status" data-testid="simulator-seed-result">{seedMsg} <Link to="/" className="underline">Open dashboard</Link></p>}
              {seedErr && <p role="alert" className={`mt-2 ${errCls}`} data-testid="simulator-seed-error">{seedErr}</p>}
            </Card>

            <Card title="Simulated agent execution">
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Emits a full SIMULATED agent trace (context, memory injection, bus op, tool calls with a retry, response) for the selected project.</p>
              <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={agentFail} onChange={e => setAgentFail(e.target.checked)} data-testid="agent-fail" /> Make it fail</label>
              <Button onClick={agentRun} disabled={agentBusy || !projectId} data-testid="simulator-agent-run">{agentBusy ? 'Running...' : 'Run simulated agent execution'}</Button>
              {agentTrace && <p className="mt-2 text-sm" role="status" data-testid="simulator-agent-result">Trace created: <Link to={`/traces/${agentTrace}`} className="text-brand-600 underline dark:text-brand-100" data-testid="simulator-agent-trace-link">{agentTrace}</Link></p>}
              {agentErr && <p role="alert" className={`mt-2 ${errCls}`} data-testid="simulator-agent-error">{agentErr}</p>}
            </Card>
          </div>
        </div>
      </Async>
    </div>
  );
}
