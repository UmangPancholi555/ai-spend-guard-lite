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
