/**
 * Process control for the isolated backend(s) used by the E2E suite.
 * Shared by global-setup / global-teardown (Playwright main process) and by specs that restart or spawn servers (worker process),
 * so a server's pid is kept in a file rather than in memory.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, ADMIN_USERNAME, DATABASE_URL, E2E_DIR, LOG_DIR, PID_FILE, PORT, REPO_ROOT, SERVER_LOG } from './env';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(150); }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

export interface ServerSpec {
  port: number;
  /** directory holding the sqlite file, logs, pid file and server log */
  dir: string;
  /** extra env for the server process (undefined deletes an inherited variable) */
  env: Record<string, string | undefined>;
}

export interface ServerHandle {
  readonly baseUrl: string; readonly dir: string; readonly logDir: string; readonly databaseUrl: string;
  isUp(): Promise<boolean>;
  prepareFreshDatabase(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  remove(): void;
}

export function makeServer(spec: ServerSpec): ServerHandle {
  const baseUrl = `http://localhost:${spec.port}`;
  const dbPath = path.join(spec.dir, 'e2e.db');
  const databaseUrl = `file:${dbPath}`;
  const logDir = path.join(spec.dir, 'logs');
  const serverLog = path.join(spec.dir, 'server.log');
  const pidFile = path.join(spec.dir, 'server.pid');
  const readPid = (): number | null => {
    try { const n = Number(fs.readFileSync(pidFile, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
  };
  const isUp = async () => { try { return (await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

  const h: ServerHandle = {
    baseUrl, dir: spec.dir, logDir, databaseUrl, isUp,

    /** Create the dir and apply all Prisma migrations to a brand-new SQLite file. */
    prepareFreshDatabase() {
      fs.rmSync(spec.dir, { recursive: true, force: true });
      fs.mkdirSync(logDir, { recursive: true });
      execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
        cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
      });
    },

    /** Start the real backend (serves API + frontend/dist). Idempotent if already running. */
    async start() {
      if (await isUp()) return;
      fs.mkdirSync(logDir, { recursive: true });
      const out = fs.openSync(serverLog, 'a');
      const env: Record<string, string | undefined> = {
        ...process.env, PORT: String(spec.port), DATABASE_URL: databaseUrl, LOG_DIR: logDir, NODE_ENV: 'test', ...spec.env,
      };
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const child = spawn('npx', ['tsx', 'backend/src/server.ts'], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', out, out], env: env as NodeJS.ProcessEnv });
      child.unref();
      fs.writeFileSync(pidFile, String(child.pid));
      await waitFor(isUp, `backend on ${baseUrl} (see ${serverLog})`);
    },

    /** Kill the server process tree (npx -> tsx -> node) and wait until the port is free. */
    async stop() {
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
      fs.rmSync(pidFile, { force: true });
    },

    async restart() { await h.stop(); await h.start(); },
    remove() { fs.rmSync(spec.dir, { recursive: true, force: true }); },
  };
  return h;
}

/** Env of the MAIN E2E server: auth ON (default), first admin bootstrapped from env, general rate limit off, IP login throttle high. */
export const MAIN_ENV: Record<string, string | undefined> = {
  AUTH_ENABLED: 'true',
  ADMIN_USERNAME, ADMIN_PASSWORD,
  RATE_LIMIT_PER_MINUTE: '0',
  AUTH_LOGIN_IP_LIMIT_PER_MINUTE: '1000',
  COOKIE_SECURE: 'false',
};

export const mainServer = makeServer({ port: PORT, dir: E2E_DIR, env: MAIN_ENV });

// back-compat names used by global-setup/teardown and the restart spec
export const isUp = mainServer.isUp;
export const prepareFreshDatabase = () => mainServer.prepareFreshDatabase();
export const startServer = () => mainServer.start();
export const stopServer = () => mainServer.stop();
export const restartServer = Object.assign(async (): Promise<void> => { await mainServer.restart(); }, { stop: stopServer, start: startServer });

export { E2E_DIR, LOG_DIR, SERVER_LOG, PID_FILE, DATABASE_URL };
