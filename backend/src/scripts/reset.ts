/**
 * Safe local reset:  npm run reset -- --yes   (add --force to target paths outside this repository)
 *
 * Removes ONLY
 *   1. the configured SQLite database file (DATABASE_URL) and its -journal / -wal / -shm siblings, and
 *   2. the contents of LOG_DIR (the directory itself and a `.gitkeep` inside it are kept),
 * then re-applies the migrations (`prisma migrate deploy`) so the schema exists again. Nothing else is read, listed or deleted.
 *
 * Safety rules (every refusal exits with code 1 and deletes nothing):
 *  - without `--yes` it only PRINTS what it would delete;
 *  - a target outside the repository root is refused unless `--force` is given;
 *  - symlinks are never followed or deleted as targets; the DB path must be a regular file whose header is "SQLite format 3"
 *    (or an empty file); LOG_DIR must be an existing-or-missing real directory;
 *  - LOG_DIR may never be (or contain) the repository root, the prisma / backend / frontend / shared / docs / tests / scripts
 *    folders, node_modules or .git, the home directory or a filesystem root - not even with `--force`;
 *  - `.env` is read (never written) so the same DATABASE_URL / LOG_DIR as the server are used; real environment variables win.
 * Stop the server first: a running server keeps the DB open and would recreate/lock files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../config';

export class ResetRefusal extends Error {}

export interface ResetTargets { databaseUrl: string; dbPath: string; logDir: string }
export interface ResetPlan extends ResetTargets { dbFiles: string[]; logEntries: string[] }
export interface ResetOptions { yes: boolean; force: boolean; repoRoot: string }

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const SIDE_CAR_SUFFIXES = ['-journal', '-wal', '-shm'];
/** repo folders that may never be inside (or be) a directory whose contents get wiped */
const PROTECTED_DIRS = ['prisma', 'backend', 'frontend', 'shared', 'docs', 'tests', 'scripts', 'node_modules', '.git'];

/** Minimal .env reader (KEY=VALUE, optional quotes, # comments). Returns only the keys it found. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** real environment wins over .env (same precedence as Prisma / the server) */
export function loadEnv(repoRoot: string, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  let fromFile: Record<string, string> = {};
  try { fromFile = parseDotEnv(fs.readFileSync(path.join(repoRoot, '.env'), 'utf8')); } catch { /* no .env: defaults apply */ }
  return { ...fromFile, ...env };
}

const isInside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** resolve symlinks of the deepest existing ancestor so "inside the repo" cannot be faked with a link */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** DATABASE_URL -> absolute SQLite file path. Relative paths resolve against prisma/ (like Prisma does). */
export function resolveDbPath(databaseUrl: string, repoRoot: string): string {
  if (!databaseUrl.startsWith('file:')) throw new ResetRefusal(`DATABASE_URL "${databaseUrl}" is not a local SQLite "file:" URL; nothing to reset.`);
  let p = databaseUrl.slice('file:'.length);
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  if (p.startsWith('//')) p = p.slice(2); // file:///abs/path
  if (!p || p === ':memory:') throw new ResetRefusal(`DATABASE_URL "${databaseUrl}" does not point at a database file.`);
  return path.resolve(repoRoot, 'prisma', decodeURIComponent(p));
}

export function resolveTargets(env: Record<string, string | undefined>, repoRoot: string): ResetTargets {
  const databaseUrl = env.DATABASE_URL ?? 'file:./spendguard.db';
  const dbPath = resolveDbPath(databaseUrl, repoRoot);
  const logDir = path.resolve(repoRoot, env.LOG_DIR ?? './data/logs');
  return { databaseUrl, dbPath, logDir };
}

function assertSafe(t: ResetTargets, opts: ResetOptions): void {
  const root = realish(opts.repoRoot);
  const db = realish(t.dbPath);
  const logs = realish(t.logDir);
  // never, even with --force
  const fsRoot = path.parse(logs).root;
  if (logs === fsRoot) throw new ResetRefusal(`LOG_DIR resolves to the filesystem root (${logs}); refusing.`);
  if (logs === realish(os.homedir()) || isInside(logs, realish(os.homedir()))) throw new ResetRefusal(`LOG_DIR (${logs}) is, or contains, your home directory; refusing.`);
  if (isInside(logs, root)) throw new ResetRefusal(`LOG_DIR (${logs}) is, or contains, the repository root; refusing.`);
  for (const d of PROTECTED_DIRS) {
    const prot = path.join(root, d);
    // refuse when LOG_DIR is the protected folder, an ancestor of it, or lives inside it
    if (isInside(logs, prot) || isInside(prot, logs)) throw new ResetRefusal(`LOG_DIR (${logs}) overlaps the protected "${d}" folder of the repository; refusing.`);
  }
  if (isInside(path.join(root, '.git'), db) || isInside(path.join(root, 'node_modules'), db)) throw new ResetRefusal(`the database path (${db}) is inside .git or node_modules; refusing.`);
  // outside the repository: only with --force
  if (!opts.force) {
    for (const [what, p] of [['database file', db], ['LOG_DIR', logs]] as const) {
      if (!isInside(root, p)) throw new ResetRefusal(`the ${what} (${p}) is outside the repository (${root}); re-run with --force if that is really what you want.`);
    }
  }
  // targets must be what we think they are
  const dbLst = lstatOrNull(t.dbPath);
  if (dbLst) {
    if (dbLst.isSymbolicLink()) throw new ResetRefusal(`the database path (${t.dbPath}) is a symlink; refusing.`);
    if (!dbLst.isFile()) throw new ResetRefusal(`the database path (${t.dbPath}) is not a regular file; refusing.`);
    if (dbLst.size > 0) {
      const fd = fs.openSync(t.dbPath, 'r');
      try {
        const buf = Buffer.alloc(SQLITE_MAGIC.length);
        fs.readSync(fd, buf, 0, buf.length, 0);
        if (buf.toString('latin1') !== SQLITE_MAGIC) throw new ResetRefusal(`${t.dbPath} is not an SQLite database (bad header); refusing to delete it.`);
      } finally { fs.closeSync(fd); }
    }
  }
  const logLst = lstatOrNull(t.logDir);
  if (logLst) {
    if (logLst.isSymbolicLink()) throw new ResetRefusal(`LOG_DIR (${t.logDir}) is a symlink; refusing.`);
    if (!logLst.isDirectory()) throw new ResetRefusal(`LOG_DIR (${t.logDir}) is not a directory; refusing.`);
  }
}

function lstatOrNull(p: string): fs.Stats | null { try { return fs.lstatSync(p); } catch { return null; } }

export function buildPlan(env: Record<string, string | undefined>, opts: ResetOptions): ResetPlan {
  const t = resolveTargets(env, opts.repoRoot);
  assertSafe(t, opts);
  const dbFiles = [t.dbPath, ...SIDE_CAR_SUFFIXES.map(s => t.dbPath + s)].filter(f => lstatOrNull(f) !== null);
  for (const f of dbFiles.slice(1)) if (lstatOrNull(f)?.isSymbolicLink()) throw new ResetRefusal(`${f} is a symlink; refusing.`);
  let logEntries: string[] = [];
  if (lstatOrNull(t.logDir)) {
    logEntries = fs.readdirSync(t.logDir).filter(n => n !== '.gitkeep').sort().map(n => path.join(t.logDir, n));
  }
  return { ...t, dbFiles, logEntries };
}

export function describePlan(plan: ResetPlan): string[] {
  const lines = [`Database  (${plan.databaseUrl}):`];
  if (plan.dbFiles.length === 0) lines.push(`  (no file at ${plan.dbPath}; nothing to delete)`);
  for (const f of plan.dbFiles) lines.push(`  delete ${f}  (${fs.lstatSync(f).size} bytes)`);
  lines.push(`Log directory ${plan.logDir}:`);
  if (plan.logEntries.length === 0) lines.push('  (empty or missing; nothing to delete)');
  for (const e of plan.logEntries) {
    const st = fs.lstatSync(e);
    lines.push(`  delete ${e}${st.isDirectory() ? '/  (directory, recursive)' : st.isSymbolicLink() ? '  (symlink itself, not its target)' : `  (${st.size} bytes)`}`);
  }
  lines.push('Then: prisma migrate deploy (recreates the schema).');
  return lines;
}

export function executePlan(plan: ResetPlan): void {
  for (const f of plan.dbFiles) fs.rmSync(f, { force: true });
  for (const e of plan.logEntries) fs.rmSync(e, { recursive: true, force: true }); // rmSync never follows symlinks: a link is unlinked, its target is untouched
}

export function migrate(plan: ResetPlan, env: Record<string, string | undefined>, repoRoot: string): void {
  fs.mkdirSync(path.dirname(plan.dbPath), { recursive: true });
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', path.join(repoRoot, 'prisma', 'schema.prisma')], {
    cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...(env as NodeJS.ProcessEnv), DATABASE_URL: plan.databaseUrl },
  });
}

/** CLI entry. Returns the exit code (0 ok, 1 refused / failed). */
export function main(argv: string[], processEnv: NodeJS.ProcessEnv, out: (line: string) => void = console.log, repoRoot = REPO_ROOT): number {
  const known = new Set(['--yes', '--force', '--help', '-h']);
  const unknown = argv.filter(a => !known.has(a));
  if (argv.includes('--help') || argv.includes('-h')) {
    out('Usage: npm run reset -- --yes [--force]\n  Deletes the configured SQLite database file and the contents of LOG_DIR, then re-runs the migrations.\n  --yes    required to actually delete (without it the plan is only printed)\n  --force  allow database / log paths outside this repository');
    return 0;
  }
  if (unknown.length) { out(`Unknown argument(s): ${unknown.join(' ')}. Use --yes and/or --force.`); return 1; }
  const opts: ResetOptions = { yes: argv.includes('--yes'), force: argv.includes('--force'), repoRoot };
  const env = loadEnv(repoRoot, processEnv);
  let plan: ResetPlan;
  try { plan = buildPlan(env, opts); } catch (e) {
    if (e instanceof ResetRefusal) { out(`Refusing to reset: ${e.message}`); return 1; }
    throw e;
  }
  out(opts.yes ? 'Resetting local data. This will delete:' : 'Dry run: this is what a reset would delete:');
  for (const l of describePlan(plan)) out(l);
  if (!opts.yes) { out('\nRefusing to run without --yes (nothing was deleted). Stop the server, then: npm run reset -- --yes'); return 1; }
  executePlan(plan);
  out('Deleted. Re-applying migrations...');
  migrate(plan, env, repoRoot);
  out('Done. Start the server (the catalog is re-seeded on start) and create the first admin again (/setup).');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2), process.env); } catch (e) {
    console.error(`reset failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
