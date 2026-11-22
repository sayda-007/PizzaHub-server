import { Router } from 'express';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { createAuthenticate } from '../../middlewares/authenticate.js';
import { requireRole } from '../../middlewares/authorize.js';
import { createAdminController } from './admin.controller.js';
import { createAdminService } from './admin.service.js';

/**
 * Every route in this router requires a verified JWT and an Admin role loaded
 * from MongoDB. Transaction access is deliberately GET-only: there is no Admin
 * endpoint that can create, edit, refund or mark a payment successful.
 */
export function createAdminRoutes(env, dependencies = {}) {
  const authenticate = dependencies.authenticate ?? createAuthenticate(env);
  const adminOnly = dependencies.adminOnly ?? requireRole(USER_ROLES.ADMIN);
  const service =
    dependencies.adminService ?? createAdminService(dependencies.serviceDependencies ?? {});
  const controller = dependencies.adminController ?? createAdminController(service);

  const router = Router();

  router.use(authenticate, adminOnly);

  router.get('/dashboard/stats', controller.dashboardStats);
  router.get('/users', controller.listUsers);
  router.get('/users/:id', controller.getUser);
  router.patch('/users/:id/block', controller.blockUser);
  router.patch('/users/:id/unblock', controller.unblockUser);
  router.get('/transactions', controller.listTransactions);

  return router;
}

export default createAdminRoutes;
