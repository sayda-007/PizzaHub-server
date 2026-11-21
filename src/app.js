import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { createAuth } from './auth/config/better-auth.js';
import { createErrorHandler } from './middlewares/error.js';
import { notFound } from './middlewares/not-found.js';
import { createApiLimiter } from './middlewares/rate-limit.js';
import { createAdminMenuRoutes } from './modules/admin/admin-menu.routes.js';
import healthRoutes from './modules/health/health.routes.js';
import { createMenuRoutes } from './modules/menu/menu.routes.js';
import {
  createCustomerOrderRoutes,
  createVendorOrderRoutes,
} from './modules/order/order.routes.js';
import {
  createStripeWebhookRoutes,
  createVendorSubscriptionRoutes,
} from './modules/payment/payment.routes.js';
import { createUserRoutes } from './modules/user/user.routes.js';

/**
 * Build and return an Express application.
 * The app is a factory rather than a global singleton so tests can create an
 * isolated instance later without starting a real network listener.
 *
 * Middleware order matters:
 * security headers -> CORS -> rate limit -> Better Auth handler -> Stripe
 * webhook (raw body) -> express.json() -> routes -> 404 -> error handler.
 *
 * Better Auth and Stripe webhooks must see the raw request stream, so both are
 * mounted before express.json(). Express 5 uses the named wildcard `*splat`.
 */
export function createApp(env, dependencies = {}) {
  const app = express();

  // Sets security-related HTTP headers (X-Content-Type-Options, HSTS, etc.).
  app.use(helmet());

  // Only origins listed in the environment are allowed to call the API from a
  // browser. Requests without an Origin header (curl, server-to-server) pass.
  const allowedOrigins = [env.CLIENT_URL, env.BETTER_AUTH_URL].filter(Boolean);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0) {
          return callback(null, true);
        }

        return callback(null, allowedOrigins.includes(origin));
      },
      credentials: true,
    }),
  );

  // Reject abusive clients early, before parsing their request bodies.
  app.use(createApiLimiter(env));

  // Better Auth owns this entire route tree and parses its own bodies. It is
  // created here because the adapter needs the MongoDB connection opened by
  // server.js. All /api/auth/* routes bypass express.json().
  const auth = createAuth(env);
  app.all('/api/auth/*splat', toNodeHandler(auth));

  const paymentDependencies = dependencies.paymentDependencies ?? dependencies;

  // Stripe signs the exact bytes it sends. This route must therefore run before
  // express.json(); reconstructing a body from parsed JSON can break signatures.
  app.use('/api/webhooks/stripe', createStripeWebhookRoutes(env, paymentDependencies));

  app.use(express.json({ limit: '1mb' }));

  // Feature routers are mounted under /api. More modules arrive in later
  // milestones through src/routes/index.js.
  app.use('/api/health', healthRoutes);
  app.use('/api/users', createUserRoutes(env));
  app.use('/api/menu', createMenuRoutes(env));
  app.use('/api/admin/menu', createAdminMenuRoutes(env));
  app.use('/api/orders', createCustomerOrderRoutes(env));
  app.use('/api/vendor/orders', createVendorOrderRoutes(env));
  app.use(
    '/api/vendor/subscription',
    createVendorSubscriptionRoutes(env, paymentDependencies),
  );

  app.use(notFound);
  app.use(createErrorHandler(env));

  return app;
}
