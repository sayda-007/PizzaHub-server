/** CORS compares browser origins, never full URLs with paths or slashes. */
export function buildAllowedOrigins(env) {
  const origins = new Set();

  for (const value of [env?.CLIENT_URL, env?.BETTER_AUTH_URL].filter(Boolean)) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Invalid values are rejected by loadEnv(); defensive here for tests.
    }
  }

  return [...origins];
}
