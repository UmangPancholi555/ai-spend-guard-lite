import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../../src/config';
import { buildPlan, describePlan, executePlan, main, parseDotEnv, resolveDbPath, resolveTargets, ResetRefusal } from '../../src/scripts/reset';
import { createPrisma } from '../../src/database/client';

/**
 * `npm run reset`. EVERY case points DATABASE_URL and LOG_DIR at a throw-away directory (inside the repo's git-ignored .tmp/ for the
 * "inside the repository" cases, under the OS temp dir for the "outside" cases). The real prisma/spendguard.db and data/ are never touched.
 */
const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(100)]);
const repoTmpRoot = path.join(REPO_ROOT, '.tmp');
const created: string[] = [];
afterAll(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); try { fs.rmdirSync(repoTmpRoot); } catch { /* other users of .tmp */ } });

function sandbox(where: 'repo' | 'os') {
  fs.mkdirSync(repoTmpRoot, { recursive: true });
  const dir = where === 'repo' ? fs.mkdtempSync(path.join(repoTmpRoot, 'reset-test-')) : fs.mkdtempSync(path.join(os.tmpdir(), 'reset-test-'));
  created.push(dir);
  const dbPath = path.join(dir, 'db', 'app.db');
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.join(logDir, 'sub'), { recursive: true });
  fs.writeFileSync(dbPath, SQLITE_HEADER);
  fs.writeFileSync(`${dbPath}-journal`, 'journal');
  fs.writeFileSync(path.join(logDir, 'execution-2025-01-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(logDir, 'sub', 'nested.jsonl'), '{}\n');
  fs.writeFileSync(path.join(logDir, '.gitkeep'), '');
  // things that must survive: a neighbour of the DB file, a neighbour of the log dir, a file outside both
  fs.writeFileSync(path.join(dir, 'db', 'neighbour.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'sibling.txt'), 'keep');
  const env = { DATABASE_URL: `file:${dbPath}`, LOG_DIR: logDir };
  return { dir, dbPath, logDir, env };
}
const run = (argv: string[], env: Record<string, string>, repoRoot = REPO_ROOT) => {
  const lines: string[] = [];
  const code = main(argv, env as NodeJS.ProcessEnv, l => lines.push(l), repoRoot);
  return { code, text: lines.join('\n') };
};

describe('parseDotEnv / target resolution', () => {
  it('parses KEY=VALUE with quotes, comments and export', () => {
    expect(parseDotEnv('# c\nDATABASE_URL="file:./x.db"\nPORT=4000 # trailing\nexport LOG_DIR=\'./l\'\n\nBAD LINE\nEMPTY=')).toEqual({ DATABASE_URL: 'file:./x.db', PORT: '4000', LOG_DIR: './l', EMPTY: '' });
  });
  it('relative sqlite paths resolve against prisma/, absolute ones stay, query strings are dropped; non-file URLs are refused', () => {
    expect(resolveDbPath('file:./spendguard.db', REPO_ROOT)).toBe(path.join(REPO_ROOT, 'prisma', 'spendguard.db'));
    expect(resolveDbPath('file:/tmp/a/b.db?connection_limit=1', REPO_ROOT)).toBe('/tmp/a/b.db');
    expect(() => resolveDbPath('postgresql://localhost:5432/db', REPO_ROOT)).toThrow(ResetRefusal);
    expect(() => resolveDbPath('file::memory:', REPO_ROOT)).toThrow(ResetRefusal);
  });
  it('defaults match the server config (resolution only - nothing is deleted)', () => {
    const t = resolveTargets({}, REPO_ROOT);
    expect(t.dbPath).toBe(path.join(REPO_ROOT, 'prisma', 'spendguard.db'));
    expect(t.logDir).toBe(path.join(REPO_ROOT, 'data', 'logs'));
  });
});

describe('npm run reset', () => {
  it('without --yes: prints exactly what it would delete, exits 1 and deletes nothing', () => {
    const s = sandbox('repo');
    const r = run([], s.env);
    expect(r.code).toBe(1);
    expect(r.text).toContain('Dry run');
    expect(r.text).toContain(`delete ${s.dbPath}`);
    expect(r.text).toContain(`delete ${s.dbPath}-journal`);
    expect(r.text).toContain(`delete ${path.join(s.logDir, 'execution-2025-01-01.jsonl')}`);
    expect(r.text).toContain(`delete ${path.join(s.logDir, 'sub')}/`);
    expect(r.text).not.toContain('.gitkeep'); // never touched, never listed
    expect(r.text).not.toContain('neighbour.txt');
    expect(r.text).toContain('Refusing to run without --yes');
    for (const f of [s.dbPath, `${s.dbPath}-journal`, path.join(s.logDir, 'execution-2025-01-01.jsonl'), path.join(s.logDir, 'sub', 'nested.jsonl')]) expect(fs.existsSync(f), f).toBe(true);
  });

  it('unknown arguments are refused', () => {
    const s = sandbox('repo');
    expect(run(['--yes', '--nuke'], s.env).code).toBe(1);
    expect(fs.existsSync(s.dbPath)).toBe(true);
  });

  it('--yes deletes only the DB (+ sidecars) and the LOG_DIR contents, keeps .gitkeep and every neighbour, then re-runs the migrations (via the npm script)', async () => {
    const s = sandbox('repo');
    const res = spawnSync('npm', ['run', '--silent', 'reset', '--', '--yes'], { cwd: REPO_ROOT, env: { ...process.env, ...s.env }, encoding: 'utf8', timeout: 120_000 });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain('Resetting local data');
    expect(res.stdout).toContain(`delete ${s.dbPath}`);
    // logs gone (directory + .gitkeep kept)
    expect(fs.readdirSync(s.logDir)).toEqual(['.gitkeep']);
    // neighbours untouched
    expect(fs.readFileSync(path.join(s.dir, 'db', 'neighbour.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(s.dir, 'sibling.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(`${s.dbPath}-journal`)).toBe(false);
    // the DB is a fresh, fully migrated database
    expect(fs.readFileSync(s.dbPath).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    const prisma = createPrisma(s.env.DATABASE_URL);
    try {
      const migrations = fs.readdirSync(path.join(REPO_ROOT, 'prisma', 'migrations'), { withFileTypes: true }).filter(e => e.isDirectory()).length;
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL');
      expect(Number(rows[0].n)).toBe(migrations);
      expect(await prisma.project.count()).toBe(0);
      expect(await prisma.user.count()).toBe(0);
    } finally { await prisma.$disconnect(); }
  }, 150_000);

  it('refuses paths outside the repository without --force, and accepts them with --force (plan only)', () => {
    const s = sandbox('os');
    const r = run(['--yes'], s.env);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/outside the repository.*--force/);
    expect(fs.existsSync(s.dbPath)).toBe(true);
    expect(fs.existsSync(path.join(s.logDir, 'execution-2025-01-01.jsonl'))).toBe(true);
    const plan = buildPlan(s.env, { yes: true, force: true, repoRoot: REPO_ROOT });
    expect(plan.dbFiles).toEqual([s.dbPath, `${s.dbPath}-journal`]);
    expect(plan.logEntries.map(e => path.basename(e))).toEqual(['execution-2025-01-01.jsonl', 'sub']);
  });

  it('with --force on an outside sandbox it really deletes and migrates', () => {
    const s = sandbox('os');
    const r = run(['--yes', '--force'], s.env);
    expect(r.code, r.text).toBe(0);
    expect(fs.readdirSync(s.logDir)).toEqual(['.gitkeep']);
    expect(fs.readFileSync(path.join(s.dir, 'sibling.txt'), 'utf8')).toBe('keep');
    expect(fs.statSync(s.dbPath).size).toBeGreaterThan(1000);
  }, 120_000);

  it('never touches dangerous locations, not even with --force', () => {
    const s = sandbox('repo');
    const bad = [
      REPO_ROOT, path.dirname(REPO_ROOT), '/', os.homedir(),
      path.join(REPO_ROOT, 'prisma'), path.join(REPO_ROOT, 'prisma', 'migrations'), path.join(REPO_ROOT, 'backend', 'src'), path.join(REPO_ROOT, 'docs'),
      path.join(REPO_ROOT, 'node_modules'), path.join(REPO_ROOT, '.git'),
    ];
    for (const logDir of bad) {
      for (const argv of [['--yes'], ['--yes', '--force']]) {
        const r = run(argv, { DATABASE_URL: s.env.DATABASE_URL, LOG_DIR: logDir });
        expect(r.code, `${logDir} ${argv.join(' ')}\n${r.text}`).toBe(1);
        expect(r.text).toContain('Refusing to reset');
      }
    }
    expect(fs.existsSync(s.dbPath)).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'prisma', 'schema.prisma'))).toBe(true);
  });

  it('refuses a database path that is not an SQLite file, a directory or a symlink, and a symlinked LOG_DIR', () => {
    const s = sandbox('repo');
    const notDb = path.join(s.dir, 'notes.db');
    fs.writeFileSync(notDb, 'this is not sqlite');
    expect(run(['--yes'], { DATABASE_URL: `file:${notDb}`, LOG_DIR: s.logDir }).text).toContain('not an SQLite database');
    expect(fs.readFileSync(notDb, 'utf8')).toBe('this is not sqlite');
    expect(run(['--yes'], { DATABASE_URL: `file:${path.join(s.dir, 'db')}`, LOG_DIR: s.logDir }).text).toContain('not a regular file');
    const linkDb = path.join(s.dir, 'link.db');
    fs.symlinkSync(s.dbPath, linkDb);
    expect(run(['--yes'], { DATABASE_URL: `file:${linkDb}`, LOG_DIR: s.logDir }).text).toContain('symlink');
    const linkLogs = path.join(s.dir, 'loglink');
    fs.symlinkSync(s.logDir, linkLogs);
    expect(run(['--yes'], { DATABASE_URL: `file:${s.dbPath}`, LOG_DIR: linkLogs }).text).toContain('symlink');
    expect(run(['--yes'], { DATABASE_URL: 'postgresql://x/y', LOG_DIR: s.logDir }).text).toContain('not a local SQLite');
    expect(fs.existsSync(s.dbPath)).toBe(true);
    expect(fs.existsSync(path.join(s.logDir, 'execution-2025-01-01.jsonl'))).toBe(true);
  });

  it('a symlink INSIDE LOG_DIR is unlinked without touching its target', () => {
    const s = sandbox('repo');
    const target = path.join(s.dir, 'precious.txt');
    fs.writeFileSync(target, 'precious');
    fs.symlinkSync(target, path.join(s.logDir, 'link-to-precious'));
    const plan = buildPlan(s.env, { yes: true, force: false, repoRoot: REPO_ROOT });
    expect(plan.logEntries.some(e => e.endsWith('link-to-precious'))).toBe(true);
    expect(describePlan(plan).join('\n')).toContain('(symlink itself, not its target)');
    executePlan(plan); // only the link is removed, never its target
    expect(fs.existsSync(path.join(s.logDir, 'link-to-precious'))).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(fs.existsSync(s.dbPath)).toBe(false);
  });

  it('works when the database file or LOG_DIR do not exist yet (fresh checkout) and still only plans what exists', () => {
    const s = sandbox('repo');
    fs.rmSync(s.dbPath); fs.rmSync(`${s.dbPath}-journal`); fs.rmSync(s.logDir, { recursive: true });
    const plan = buildPlan(s.env, { yes: true, force: false, repoRoot: REPO_ROOT });
    expect(plan.dbFiles).toEqual([]);
    expect(plan.logEntries).toEqual([]);
    const r = run([], s.env);
    expect(r.text).toContain('nothing to delete');
  });
});
