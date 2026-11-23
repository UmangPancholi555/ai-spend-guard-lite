/**
 * Process control for the isolated backend used by the E2E suite.
 * Shared by global-setup / global-teardown (Playwright main process) and by the restart-persistence spec (worker process),
 * so the server's pid is kept in a file rather than in memory.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { BASE_URL, DATABASE_URL, E2E_DIR, LOG_DIR, PID_FILE, PORT, REPO_ROOT, SERVER_LOG } from './env';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function isUp(): Promise<boolean> {
  try { return (await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

export async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(150); }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function readPid(): number | null {
  try { const n = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Create the temp dir and apply all Prisma migrations to a brand-new SQLite file. */
export function prepareFreshDatabase(): void {
  fs.rmSync(E2E_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL }, stdio: 'pipe',
  });
}

/** Start the real backend (serves API + frontend/dist) on PORT with the temp DB / log dir. Idempotent if already running. */
export async function startServer(): Promise<void> {
  if (await isUp()) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(SERVER_LOG, 'a');
  const child = spawn('npx', ['tsx', 'backend/src/server.ts'], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(PORT), DATABASE_URL, LOG_DIR, NODE_ENV: 'test' },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  await waitFor(isUp, `backend on ${BASE_URL} (see ${SERVER_LOG})`);
}

/** Kill the server process tree (npx -> tsx -> node) and wait until the port is free. */
export async function stopServer(): Promise<void> {
  const pid = readPid();
  if (pid && alive(pid)) {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  try {
    await waitFor(async () => !(await isUp()), 'backend to stop', 15_000);
  } catch {
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    await waitFor(async () => !(await isUp()), 'backend to stop (SIGKILL)', 10_000);
  }
  fs.rmSync(PID_FILE, { force: true });
}

export const restartServer = Object.assign(async (): Promise<void> => { await stopServer(); await startServer(); }, { stop: stopServer, start: startServer });

export { E2E_DIR, LOG_DIR, SERVER_LOG };
