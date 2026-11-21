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
 * Vendor-only menu management routes.
 *
 * Authentication and role checks run before Multer, so unauthenticated users
 * never make the server parse their upload. The parser middleware is scoped to
 * POST / only; no global file upload middleware exists in the application.
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
  router.patch('/:id/availability', authenticate, vendorOnly, controller.toggleAvailability);
  router.patch('/:id', authenticate, vendorOnly, controller.update);
  router.delete('/:id', authenticate, vendorOnly, controller.remove);

  return router;
}

export default createMenuRoutes;
