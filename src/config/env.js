import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 *
 * Every variable from .env.example is declared here so the whole team can see
 * what the server expects. Variables for features that are not implemented yet
 * are optional on purpose; they will become required in the milestone that
 * introduces the feature. This lets the project grow without breaking startup.
 */
const envSchema = z.object({
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

  // --- Authentication (Milestone 4) --------------------------------------
  BETTER_AUTH_SECRET: z.string().trim().min(1).optional(),
  BETTER_AUTH_URL: z.url().optional(),
  CLIENT_URL: z.url().optional(),

  // --- Google OAuth (Milestone 4) ----------------------------------------
  GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),

  // --- Stripe subscriptions (Milestone 13) -------------------------------
  STRIPE_SECRET_KEY: z.string().trim().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  STRIPE_PRICE_ID: z.string().trim().min(1).optional(),

  // --- ImgBB uploads (Milestone 7) ---------------------------------------
  IMGBB_API_KEY: z.string().trim().min(1).optional(),

  // --- Admin seed script (Milestone 6) -----------------------------------
  ADMIN_NAME: z.string().trim().min(1).optional(),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().trim().min(1).optional(),
});

/**
 * Parse and validate process.env, throwing a readable error on failure.
 * Keeping this as a function (instead of a side effect at import time) makes
 * the failure easy to catch and report from the entry point.
 */
export function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
