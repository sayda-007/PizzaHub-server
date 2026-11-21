import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Better Auth's jwt() plugin uses EdDSA (Ed25519) by default. This verifier is
 * for the current configuration, which does not override keyPairConfig.alg.
 * Pinning the algorithm prevents an attacker from choosing a weaker algorithm.
 */
export const BETTER_AUTH_JWT_ALGORITHMS = Object.freeze(['EdDSA']);

const JWKS_PATH = '/api/auth/jwks';
const VERIFICATION_ERROR_MESSAGE = 'JWT verification failed.';
const JWKS_UNAVAILABLE_MESSAGE = 'JWT verification keys are currently unavailable.';

/**
 * jose uses stable `code` values for bad tokens/claims. Those are client
 * failures. Fetch/timeout errors have other codes and are infrastructure
 * failures, which must not be reported as bad credentials.
 */
const TOKEN_ERROR_CODE_PREFIXES = Object.freeze([
  'ERR_JWS_',
  'ERR_JWT_',
  'ERR_JOSE_',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

class InvalidTokenError extends Error {}

/** Raised when public keys cannot be fetched; the central handler owns it. */
export class JwksUnavailableError extends Error {
  constructor() {
    super(JWKS_UNAVAILABLE_MESSAGE);
    this.name = 'JwksUnavailableError';
  }
}

function isJwtTokenError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';

  return TOKEN_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * Turn the configured Better Auth base URL into the JWKS URL exposed by the
 * plugin. Trailing slashes are removed so `https://host/` and `https://host`
 * produce the same URL.
 */
export function buildJwksUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('BETTER_AUTH_URL is required to build the JWKS URL.');
  }

  const normalizedBase = baseUrl.trim().replace(/\/+$/, '');

  return new URL(`${normalizedBase}${JWKS_PATH}`);
}

/**
 * Create one verifier for the whole process.
 *
 * The remote JWKS resolver is created once and caches public keys. It is not
 * rebuilt for each request. Dependencies can be injected in tests so no HTTP
 * request or real Better Auth database is needed.
 */
export function createJwtVerifier(env, dependencies = {}) {
  const baseUrl = env?.BETTER_AUTH_URL;

  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('BETTER_AUTH_URL is required to verify JWTs.');
  }

  const jwksUrl = buildJwksUrl(baseUrl);
  const makeRemoteJWKSet = dependencies.createRemoteJWKSet ?? createRemoteJWKSet;
  const verify = dependencies.jwtVerify ?? jwtVerify;

  // Better Auth signs tokens with `options.baseURL` as both issuer and audience.
  // Use the configured value rather than inventing separate settings.
  const expectedClaims = Object.freeze({
    algorithms: [...BETTER_AUTH_JWT_ALGORITHMS],
    issuer: baseUrl,
    audience: baseUrl,
  });

  const keyResolver = makeRemoteJWKSet(jwksUrl);

  return async function verifyJwt(token) {
    try {
      const { payload } = await verify(token, keyResolver, expectedClaims);

      if (!payload || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
        throw new InvalidTokenError('JWT is missing a valid subject.');
      }

      return payload;
    } catch (error) {
      if (error instanceof InvalidTokenError || isJwtTokenError(error)) {
        // Verification details can mention keys or claims. The middleware only
        // needs to know that this token is not acceptable.
        throw new Error(VERIFICATION_ERROR_MESSAGE);
      }

      // A remote JWKS failure is an infrastructure problem, not bad
      // credentials. Forward a generic error so the central handler returns 500.
      throw new JwksUnavailableError();
    }
  };
}
