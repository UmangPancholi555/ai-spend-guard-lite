// STUB - owned by the dashboard module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createDashboardRouter(_deps: AppDeps): Router {
  return Router();
}
