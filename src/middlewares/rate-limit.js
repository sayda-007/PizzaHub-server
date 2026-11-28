import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { ApiError } from '../utils/api-error.js';

const WINDOW_MS = 15 * 60 * 1000;

// Development is generous so manual testing is not interrupted. Production is
// tighter. Tests get a very high ceiling so suites do not fail by accident.
const LIMITS = Object.freeze({
  development: 500,
  test: 10_000,
  production: 100,
});

// The browser asks for a JWT, a session and JWKS keys while using the app.
// Those are session maintenance, not user actions, and must never consume the
// same small budget as sign-in attempts and business endpoints.
const AUTH_UTILITY_PATHS = new Set([
  '/api/auth/token',
  '/api/auth/get-session',
  '/api/auth/jwks',
]);

// Credential submissions keep their own strict bucket for brute-force
// protection. A burst of menu/order traffic must not leave a vendor with a 429
// before their password is even checked, and session refreshes must not drain
// this bucket either.
const AUTH_CREDENTIAL_PATHS = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/social',
  '/api/auth/sign-up/email',
]);

const AUTH_UTILITY_LIMITS = Object.freeze({
  development: 5_000,
  test: 100_000,
  production: 1_000,
});

const AUTH_CREDENTIAL_LIMITS = Object.freeze({
  development: 500,
  test: 10_000,
  production: 100,
});

function normalizedPath(req) {
  const path = typeof req?.path === 'string' ? req.path : '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** True for high-frequency auth session/key requests, not credential submissions. */
export function isAuthUtilityRequest(req) {
  return AUTH_UTILITY_PATHS.has(normalizedPath(req));
}

/** True for requests that submit credentials or start a credential-based login. */
export function isAuthCredentialRequest(req) {
  return AUTH_CREDENTIAL_PATHS.has(normalizedPath(req));
}

function rateLimitCategory(req) {
  if (isAuthUtilityRequest(req)) return 'auth-utility';
  if (isAuthCredentialRequest(req)) return 'auth-credential';
  return 'api';
}

/**
 * Build the shared API limiter. Rate-limit errors go through ApiError so the
 * client sees the same JSON envelope as every other error.
 */
export function createApiLimiter(env) {
  const environment = env?.NODE_ENV ?? 'development';
  const apiLimit = LIMITS[environment] ?? LIMITS.development;
  const authUtilityLimit =
    AUTH_UTILITY_LIMITS[environment] ?? AUTH_UTILITY_LIMITS.development;
  const authCredentialLimit =
    AUTH_CREDENTIAL_LIMITS[environment] ?? AUTH_CREDENTIAL_LIMITS.development;

  const limitsByCategory = Object.freeze({
    api: apiLimit,
    'auth-utility': authUtilityLimit,
    'auth-credential': authCredentialLimit,
  });

  return rateLimit({
    windowMs: WINDOW_MS,
    limit: (req) => limitsByCategory[rateLimitCategory(req)],

    // Separate buckets stop session refreshes or menu traffic from exhausting
    // the credential budget while keeping one bucket per client IP per category.
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown')}:${rateLimitCategory(req)}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,

    // Health checks are liveness probes, not API usage. Exempting them keeps
    // monitoring from being throttled alongside real requests.
    skip: (req) => normalizedPath(req) === '/api/health',

    handler: (_req, _res, next) => {
      next(ApiError.tooManyRequests('Too many requests. Please try again later.', 'RATE_LIMITED'));
    },
  });
}
