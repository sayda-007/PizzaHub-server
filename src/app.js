import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import healthRoutes from './modules/health/health.routes.js';

/**
 * Build and return an Express application.
 * The app is a factory rather than a global singleton so tests can create an
 * isolated instance later without starting a real network listener.
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

  app.use(express.json({ limit: '1mb' }));

  // Feature routers are mounted under /api. More modules arrive in later
  // milestones through src/routes/index.js.
  app.use('/api/health', healthRoutes);

  // Temporary fallback. Milestone 2 replaces this with a dedicated
  // middlewares/not-found.js and a centralized error handler.
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      message: 'Resource not found',
    });
  });

  return app;
}
