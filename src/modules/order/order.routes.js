import { Router } from 'express';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { createAuthenticate } from '../../middlewares/authenticate.js';
import { requireRole } from '../../middlewares/authorize.js';
import { createOrderController } from './order.controller.js';
import { createOrderService } from './order.service.js';

function buildOrderModule(env, dependencies, role) {
  const authenticate = dependencies.authenticate ?? createAuthenticate(env);
  const roleGuard =
    role === USER_ROLES.CUSTOMER
      ? dependencies.customerOnly ?? requireRole(USER_ROLES.CUSTOMER)
      : dependencies.vendorOnly ?? requireRole(USER_ROLES.VENDOR);

  const service =
    dependencies.orderService ??
    createOrderService(dependencies.serviceDependencies ?? {});
  const controller = dependencies.orderController ?? createOrderController(service);

  return { authenticate, roleGuard, controller };
}

/**
 * Customer order routes. `/mine` is registered before `/:id` so the static
 * path can never be captured by the id handler. Every route requires the
 * customer role from the MongoDB-loaded req.user.
 */
export function createCustomerOrderRoutes(env, dependencies = {}) {
  const { authenticate, roleGuard, controller } = buildOrderModule(
    env,
    dependencies,
    USER_ROLES.CUSTOMER,
  );

  const router = Router();

  router.use(authenticate, roleGuard);

  router.post('/', controller.create);
  router.get('/mine', controller.listMine);
  router.get('/:id', controller.getMine);
  router.patch('/:id/cancel', controller.cancel);

  return router;
}

/** Vendor order routes. Both endpoints are scoped by the vendor id from req.user. */
export function createVendorOrderRoutes(env, dependencies = {}) {
  const { authenticate, roleGuard, controller } = buildOrderModule(
    env,
    dependencies,
    USER_ROLES.VENDOR,
  );

  const router = Router();

  router.use(authenticate, roleGuard);

  router.get('/', controller.vendorList);
  router.patch('/:id/status', controller.vendorUpdateStatus);

  return router;
}
