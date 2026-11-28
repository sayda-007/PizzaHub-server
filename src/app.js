import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { createAuth } from './auth/config/better-auth.js';
import { loadEnv } from './config/env.js';
import {
  getMenuSlotReservationsCollection,
} from './database/collections.js';
import { initializeIndexes } from './database/indexes.js';
import { connectToDatabase, disconnectFromDatabase } from './database/mongo.js';
import { createErrorHandler } from './middlewares/error.js';
import { notFound } from './middlewares/not-found.js';
import { createApiLimiter } from './middlewares/rate-limit.js';
import { createAdminRoutes } from './modules/admin/admin.routes.js';
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
import { buildAllowedOrigins } from './utils/origins.js';

/**
 * Build and return an Express application.
 * The named factory stays available for isolated instances in tests. The
 * default export at the bottom is the single configured app used by Vercel and
 * by the local server.js listener.
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

  // Vercel terminates TLS and forwards each request through one trusted proxy
  // hop. A hop count (instead of `true`) uses the platform-managed forwarded IP
  // for rate limiting and secure-cookie detection without trusting arbitrary
  // forwarded chains.
  app.set('trust proxy', 1);

  // Sets security-related HTTP headers (X-Content-Type-Options, HSTS, etc.).
  app.use(helmet());

  // Only origins listed in the environment are allowed to call the API from a
  // browser. Requests without an Origin header (curl, server-to-server) pass.
  const allowedOrigins = buildAllowedOrigins(env);

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
  // created after the MongoDB connection is opened during module startup,
  // because the adapter needs the shared Db and MongoClient. All /api/auth/*
  // routes bypass express.json().
  const auth = createAuth(env);
  app.all('/api/auth/*splat', toNodeHandler(auth));

  // One injected service dependency set is shared by every feature router. It
  // enables the atomic menu-slot path in production while still allowing tests
  // to inject isolated collections and services.
  const serviceDependencies = dependencies.serviceDependencies ?? {
    ...dependencies,
    slotsCollection: dependencies.slotsCollection ?? getMenuSlotReservationsCollection,
  };
  const sharedDependencies = { ...dependencies, serviceDependencies };
  const adminDependencies = dependencies.adminDependencies ?? sharedDependencies;
  const paymentDependencies = dependencies.paymentDependencies ?? sharedDependencies;

  // Stripe signs the exact bytes it sends. This route must therefore run before
  // express.json(); reconstructing a body from parsed JSON can break signatures.
  app.use('/api/webhooks/stripe', createStripeWebhookRoutes(env, paymentDependencies));

  app.use(express.json({ limit: '1mb' }));

  // Feature routers are mounted under /api. More modules arrive in later
  // milestones through src/routes/index.js.
  app.use('/api/health', healthRoutes);
  app.use('/api/users', createUserRoutes(env, sharedDependencies));
  app.use('/api/menu', createMenuRoutes(env, sharedDependencies));
  app.use('/api/admin/menu', createAdminMenuRoutes(env, adminDependencies));
  app.use('/api/admin', createAdminRoutes(env, adminDependencies));
  app.use('/api/orders', createCustomerOrderRoutes(env, sharedDependencies));
  app.use('/api/vendor/orders', createVendorOrderRoutes(env, sharedDependencies));
  app.use(
    '/api/vendor/subscription',
    createVendorSubscriptionRoutes(env, paymentDependencies),
  );

  app.use(notFound);
  app.use(createErrorHandler(env));

  return app;
}

/**
 * Vercel imports this file directly and expects the default export to be the
 * configured Express app. Load env, prepare MongoDB, then build that one app
 * here so Vercel and the local listener share the same routes and middleware.
 */
let env;

try {
  env = loadEnv();
} catch (error) {
  console.error(`[config] ${error.message}`);
  throw error;
}

try {
  await connectToDatabase(env);
  console.log('[database] Connected to MongoDB.');

  await initializeIndexes();
  console.log('[database] Indexes ready.');
} catch (error) {
  console.error(`[database] ${error.message}`);
  await disconnectFromDatabase().catch(() => {});
  throw error;
}

const app = createApp(env);

export { env };
export default app;
