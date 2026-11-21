import { Router } from 'express';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { createAuthenticate } from '../../middlewares/authenticate.js';
import { requireRole } from '../../middlewares/authorize.js';
import { createAdminMenuController } from './admin-menu.controller.js';
import { createAdminMenuService } from './admin-menu.service.js';

/**
 * Every Admin menu endpoint is protected. The role check reads req.user.role,
 * which authenticate fills from the current MongoDB user record; JWT role
 * claims and client-supplied roles are never trusted.
 */
export function createAdminMenuRoutes(env, dependencies = {}) {
  const authenticate = dependencies.authenticate ?? createAuthenticate(env);
  const adminOnly = dependencies.adminOnly ?? requireRole(USER_ROLES.ADMIN);

  const service =
    dependencies.adminMenuService ??
    createAdminMenuService(dependencies.serviceDependencies ?? {});
  const controller =
    dependencies.adminMenuController ?? createAdminMenuController(service);

  const router = Router();

  router.use(authenticate, adminOnly);

  router.get('/', controller.list);
  router.patch('/:id/status', controller.moderate);
  router.delete('/:id', controller.remove);

  return router;
}

export default createAdminMenuRoutes;
