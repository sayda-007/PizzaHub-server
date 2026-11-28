// Fake session records for middleware tests. This helper never reads .env or
// contacts MongoDB; every id is supplied by the test's fake token verifier.
export const TEST_SESSION_EXPIRY = '2099-01-01T00:00:00.000Z';

export function findActiveTestSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return null;
  }

  return { userId: sessionId, expiresAt: TEST_SESSION_EXPIRY };
}
