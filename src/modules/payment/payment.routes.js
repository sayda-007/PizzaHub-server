import express, { Router } from 'express';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { createAuthenticate } from '../../middlewares/authenticate.js';
import { requireRole } from '../../middlewares/authorize.js';
import {
  createPaymentController,
  createStripeWebhookController,
} from './payment.controller.js';
import { createPaymentService } from './payment.service.js';

function resolveService(env, dependencies) {
  if (dependencies.paymentService) {
    return dependencies.paymentService;
  }

  return createPaymentService({ ...dependencies.serviceDependencies, env });
}

/** Authenticated vendor routes for checkout, current status and cancellation. */
export function createVendorSubscriptionRoutes(env, dependencies = {}) {
  const authenticate = dependencies.authenticate ?? createAuthenticate(env);
  const vendorOnly = dependencies.vendorOnly ?? requireRole(USER_ROLES.VENDOR);
  const service = resolveService(env, dependencies);
  const controller = dependencies.paymentController ?? createPaymentController(service);

  const router = Router();

  router.use(authenticate, vendorOnly);

  router.post('/checkout', controller.checkout);
  router.get('/', controller.status);
  router.post('/cancel', controller.cancel);

  return router;
}

/**
 * Public Stripe webhook. The raw parser belongs to this router so app.js can
 * mount it before express.json(); signature verification happens in controller.
 */
export function createStripeWebhookRoutes(env, dependencies = {}) {
  const service = resolveService(env, dependencies);
  const controller =
    dependencies.webhookController ??
    createStripeWebhookController(service, {
      env,
      stripe: dependencies.stripe,
      createStripeClient: dependencies.createStripeClient,
    });

  const router = Router();

  router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), controller);

  return router;
}
