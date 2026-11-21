import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { createErrorHandler } from './middlewares/error.js';
import { notFound } from './middlewares/not-found.js';
import { createApiLimiter } from './middlewares/rate-limit.js';
import healthRoutes from './modules/health/health.routes.js';

/**
 * Build and return an Express application.
 * The app is a factory rather than a global singleton so tests can create an
 * isolated instance later without starting a real network listener.
 *
 * Middleware order matters:
 * security headers -> CORS -> rate limit -> body parsing -> routes
 * -> 404 -> error handler (must be last).
 */
export function createApp(env) {
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

  app.use(express.json({ limit: '1mb' }));

  // Feature routers are mounted under /api. More modules arrive in later
  // milestones through src/routes/index.js.
  app.use('/api/health', healthRoutes);

  app.use(notFound);
  app.use(createErrorHandler(env));

  return app;
}
