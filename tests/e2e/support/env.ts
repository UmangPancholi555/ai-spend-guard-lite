import os from 'node:os';
import path from 'node:path';

/** Everything the E2E run touches lives under one temp dir (never the dev DB under prisma/ or data/). */
export const PORT = Number(process.env.E2E_PORT ?? 4300);
export const BASE_URL = `http://localhost:${PORT}`;
export const E2E_DIR = process.env.E2E_DIR ?? path.join(os.tmpdir(), 'spendguard-e2e');
export const DB_PATH = path.join(E2E_DIR, 'e2e.db');
export const DATABASE_URL = `file:${DB_PATH}`;
export const LOG_DIR = path.join(E2E_DIR, 'logs');
export const SERVER_LOG = path.join(E2E_DIR, 'server.log');
export const PID_FILE = path.join(E2E_DIR, 'server.pid');
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Bootstrapped administrator (ADMIN_USERNAME / ADMIN_PASSWORD env of the E2E server). Strong password, does not contain the username. */
export const ADMIN_USERNAME = 'e2e-admin';
export const ADMIN_PASSWORD = 'Zk7-Plover-Ember-Quartz-48';
/** Read-only account created by global-setup through the API. */
export const VIEWER_USERNAME = 'e2e-viewer';
export const VIEWER_PASSWORD = 'Quiet-Walrus-Lantern-Plum-7';
/** Saved Playwright storage states (logged-in sessions) + the matching CSRF tokens. */
export const ADMIN_STATE = path.join(E2E_DIR, 'auth-admin.json');
export const VIEWER_STATE = path.join(E2E_DIR, 'auth-viewer.json');
export const ADMIN_CSRF_FILE = path.join(E2E_DIR, 'csrf-admin.txt');
export const VIEWER_CSRF_FILE = path.join(E2E_DIR, 'csrf-viewer.txt');
/** Second, completely separate server for the first-run /setup flow (no bootstrap admin). */
export const SETUP_PORT = Number(process.env.E2E_SETUP_PORT ?? 4301);
export const SETUP_DIR = path.join(E2E_DIR, 'setup-instance');
