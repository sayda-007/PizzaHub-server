import { Router } from 'express';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { createAuthenticate } from '../../middlewares/authenticate.js';
import { requireRole } from '../../middlewares/authorize.js';
import {
  createImageUploader,
  createImgbbUploader,
} from '../../services/imgbb.js';
import { createMenuController } from './menu.controller.js';
import { createMenuService } from './menu.service.js';

/**
 * Public browsing plus vendor-only menu management routes.
 *
 * GET / is public and exact, so static paths such as /mine are never captured
 * by it. Management routes keep authentication and role checks before Multer,
 * so unauthenticated users never make the server parse their upload. The
 * parser middleware is scoped to POST / only; no global upload middleware exists.
 */
export function createMenuRoutes(env, dependencies = {}) {
  const authenticate = dependencies.authenticate ?? createAuthenticate(env);
  const vendorOnly = dependencies.vendorOnly ?? requireRole(USER_ROLES.VENDOR);

  const service =
    dependencies.menuService ??
    createMenuService(dependencies.serviceDependencies ?? {});
  const imageUploader =
    dependencies.imageUploader ?? createImgbbUploader(env, dependencies.imgbbDependencies);
  const controller =
    dependencies.menuController ?? createMenuController(service, imageUploader);

  const uploadMiddleware = dependencies.uploadMiddleware ?? createImageUploader();

  const router = Router();

  router.post('/', authenticate, vendorOnly, uploadMiddleware, controller.create);
  router.get('/mine', authenticate, vendorOnly, controller.listMine);

  // Exact path only. /mine is registered above and guarded; it cannot be
  // handled by this public route even though both start with `/`.
  router.get('/', controller.listPublic);

  router.patch('/:id/availability', authenticate, vendorOnly, controller.toggleAvailability);
  router.patch('/:id', authenticate, vendorOnly, controller.update);
  router.delete('/:id', authenticate, vendorOnly, controller.remove);

  return router;
}

export default createMenuRoutes;
