import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 *
 * Every variable from .env.example is declared here so the whole team can see
 * what the server expects. Optional integrations are validated as a group:
 * missing/placeholder values disable them, while a partial real configuration
 * is rejected at startup.
 */

/** Values copied straight from an example file must never be used as credentials. */
const CREDENTIAL_PLACEHOLDER = /(replace[-_]?with|your[-_]|change[-_]?me|placeholder|dummy|fake|paste[-_]|todo|xxx|<[^>]+>)/i;

function isPlaceholderCredential(value) {
  return typeof value !== 'string' || CREDENTIAL_PLACEHOLDER.test(value);
}

/**
 * Better Auth, JWT claim checks and CORS all need the same base URL spelling.
 * Trailing slashes are removed while any intentional path prefix is preserved.
 */
export function normalizeBaseUrl(value) {
  const parsed = new URL(value);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URLs must use http or https.');
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');

  return parsed.href.replace(/\/+$/, '');
}

const envSchema = z
  .object({
    // --- HTTP server -------------------------------------------------------
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // --- Database (required from Milestone 2) -------------------------------
    MONGODB_URI: z
      .string()
      .trim()
      .min(1, 'MONGODB_URI is required')
      .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),
    MONGODB_DB_NAME: z.string().trim().min(1, 'MONGODB_DB_NAME is required'),

    // --- Better Auth (required from Milestone 5) ----------------------------
    BETTER_AUTH_SECRET: z
      .string()
      .trim()
      .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters')
      .refine((value) => !isPlaceholderCredential(value), {
        message: 'BETTER_AUTH_SECRET must not be a placeholder value.',
      }),
    BETTER_AUTH_URL: z.url().transform(normalizeBaseUrl),
    CLIENT_URL: z.url().transform(normalizeBaseUrl),

    // --- Google OAuth (optional, but both or neither) -----------------------
    GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),

    // --- Stripe subscriptions ---------------------------------------------
    STRIPE_SECRET_KEY: z
      .string()
      .trim()
      .regex(/^sk_(test|live)_/, 'STRIPE_SECRET_KEY must be a Stripe secret key.')
      .optional(),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .trim()
      .regex(/^whsec_/, 'STRIPE_WEBHOOK_SECRET must be a Stripe webhook secret.')
      .optional(),
    STRIPE_PREMIUM_PRICE_ID: z
      .string()
      .trim()
      .regex(/^price_/, 'STRIPE_PREMIUM_PRICE_ID must be a Stripe price id.')
      .optional(),

    // --- ImgBB uploads (Milestone 7) ---------------------------------------
    IMGBB_API_KEY: z.string().trim().min(1).optional(),

    // --- Admin seed script (manual; optional at server startup) -------------
    // loadEnv() includes these so `npm run seed:admin` receives them. The seed
    // script performs the stricter validation when it actually runs.
    ADMIN_NAME: z.string().trim().min(1).optional(),
    ADMIN_EMAIL: z.email().optional(),
    ADMIN_PASSWORD: z.string().trim().min(1).optional(),
  })
  .refine(
    (data) => Boolean(data.GOOGLE_CLIENT_ID) === Boolean(data.GOOGLE_CLIENT_SECRET),
    {
      path: ['GOOGLE_CLIENT_ID'],
      message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be supplied together.',
    },
  )
  .refine(
    (data) => {
      const configured = [
        data.STRIPE_SECRET_KEY,
        data.STRIPE_WEBHOOK_SECRET,
        data.STRIPE_PREMIUM_PRICE_ID,
      ].filter(Boolean).length;

      return configured === 0 || configured === 3;
    },
    {
      path: ['STRIPE_SECRET_KEY'],
      message: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PREMIUM_PRICE_ID must be supplied together.',
    },
  );

/**
 * Parse and validate process.env, throwing a readable error on failure.
 * Keeping this as a function (instead of a side effect at import time) makes
 * the failure easy to catch and report from the entry point.
 */
export function loadEnv() {
  // Copy before normalizing so process.env is never mutated. Empty values and
  // example-file placeholders count as "not supplied", which lets developers
  // run the API with email/password only. Their values are never logged.
  const input = { ...process.env };
  const ignored = [];

  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    const value = input[name];

    if (typeof value !== 'string' || value.trim() === '' || isPlaceholderCredential(value.trim())) {
      delete input[name];
      ignored.push(name);
    }
  }

  if (ignored.length > 0) {
    console.warn('[config] Placeholder or empty Google credentials were ignored; Google sign-in is disabled.');
  }

  const ignoredStripe = [];

  for (const name of [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PREMIUM_PRICE_ID',
  ]) {
    const value = input[name];

    if (typeof value !== 'string' || value.trim() === '' || isPlaceholderCredential(value.trim())) {
      delete input[name];
      ignoredStripe.push(name);
    }
  }

  if (ignoredStripe.length > 0) {
    console.warn('[config] Placeholder or empty Stripe settings were ignored; Premium subscriptions are disabled.');
  }

  const result = envSchema.safeParse(input);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
