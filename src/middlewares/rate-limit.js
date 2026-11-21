import rateLimit from 'express-rate-limit';

import { ApiError } from '../utils/api-error.js';

const WINDOW_MS = 15 * 60 * 1000;

// Development is generous so manual testing is not interrupted. Production is
// tighter. Tests get a very high ceiling so suites do not fail by accident.
const LIMITS = Object.freeze({
  development: 500,
  test: 10_000,
  production: 100,
});

/**
 * Build the shared API limiter. Rate-limit errors go through ApiError so the
 * client sees the same JSON envelope as every other error.
 */
export function createApiLimiter(env) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: LIMITS[env.NODE_ENV] ?? LIMITS.development,
    standardHeaders: 'draft-7',
    legacyHeaders: false,

    // Health checks are liveness probes, not API usage. Exempting them keeps
    // monitoring from being throttled alongside real requests.
    skip: (req) => req.path === '/api/health',

    handler: (_req, _res, next) => {
      next(ApiError.tooManyRequests('Too many requests. Please try again later.', 'RATE_LIMITED'));
    },
  });
}
