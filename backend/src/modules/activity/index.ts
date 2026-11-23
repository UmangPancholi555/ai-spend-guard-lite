// STUB - owned by the activity module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createActivityRouter(_deps: AppDeps): Router {
  return Router();
}
