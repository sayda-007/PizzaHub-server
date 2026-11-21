import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { createAuth, USER_ROLES } from '../auth/config/better-auth.js';
import { loadEnv } from '../config/env.js';
import { COLLECTIONS } from '../database/collections.js';
import {
  connectToDatabase,
  disconnectFromDatabase,
  getDb,
} from '../database/mongo.js';
import { ApiError } from '../utils/api-error.js';

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;

/** Example-file values must never become real admin credentials. */
const CREDENTIAL_PLACEHOLDER = /(replace[-_]?with|your[-_]|change[-_]?me|placeholder|dummy|fake|paste[-_]|todo|xxx|<[^>]+>)/i;

function isPlaceholderText(value) {
  return typeof value !== 'string' || CREDENTIAL_PLACEHOLDER.test(value.trim());
}

function isPlaceholderEmail(value) {
  if (isPlaceholderText(value)) {
    return true;
  }

  return /@example\.(com|org|net|test)$/i.test(value.trim());
}

const adminConfigSchema = z.object({
  ADMIN_NAME: z
    .string()
    .trim()
    .min(1, 'ADMIN_NAME is required.')
    .refine((value) => !isPlaceholderText(value), {
      message: 'ADMIN_NAME must not be a placeholder value.',
    }),
  ADMIN_EMAIL: z
    .email('ADMIN_EMAIL must be a valid email address.')
    .refine((value) => !isPlaceholderEmail(value), {
      message: 'ADMIN_EMAIL must be a real address, not an example placeholder.',
    }),
  ADMIN_PASSWORD: z
    .string()
    .min(1, 'ADMIN_PASSWORD is required.')
    .refine((value) => !isPlaceholderText(value), {
      message: 'ADMIN_PASSWORD must not be a placeholder value.',
    })
    .refine((value) => value.length >= MIN_PASSWORD_LENGTH, {
      message: `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    })
    .refine((value) => value.length <= MAX_PASSWORD_LENGTH, {
      message: `ADMIN_PASSWORD must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    })
    .refine((value) => /[A-Z]/.test(value), {
      message: 'ADMIN_PASSWORD must include at least one uppercase letter.',
    })
    .refine((value) => /[a-z]/.test(value), {
      message: 'ADMIN_PASSWORD must include at least one lowercase letter.',
    }),
});

/**
 * Validate seed-only environment values before opening a database connection.
 * Error details name variables and rules only; submitted values are never
 * included, so the password cannot leak into logs or terminal history output.
 */
export function validateAdminConfig(env) {
  const parsed = adminConfigSchema.safeParse({
    ADMIN_NAME: env?.ADMIN_NAME,
    ADMIN_EMAIL: env?.ADMIN_EMAIL,
    ADMIN_PASSWORD: env?.ADMIN_PASSWORD,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid admin seed configuration:\n${details}`);
  }

  return Object.freeze({
    name: parsed.data.ADMIN_NAME,
    email: parsed.data.ADMIN_EMAIL.trim().toLowerCase(),
    password: parsed.data.ADMIN_PASSWORD,
  });
}

/** Better Auth stores emails in lowercase, so lookups use the same form. */
export async function findUserByEmail(email, collection) {
  const users = collection ?? getDb().collection(COLLECTIONS.USERS);

  return users.findOne(
    { email: String(email).trim().toLowerCase() },
    { projection: { _id: 1, id: 1, email: 1, role: 1 } },
  );
}

const DUPLICATE_USER_CODES = new Set([
  'USER_ALREADY_EXISTS',
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
]);

/**
 * Detect Better Auth's duplicate-email failure without exposing its message.
 * Numeric 409/11000 checks also cover a direct MongoDB unique-key error.
 */
export function isDuplicateUserError(error) {
  const code = error?.body?.code ?? error?.code;

  if (DUPLICATE_USER_CODES.has(code)) {
    return true;
  }

  if (error?.status === 'CONFLICT' || error?.statusCode === 409 || error?.code === 11000) {
    return true;
  }

  return (
    error?.status === 'UNPROCESSABLE_ENTITY' &&
    typeof error?.message === 'string' &&
    /already exists/i.test(error.message)
  );
}

function safeUserId(user) {
  return user?.id ?? user?._id?.toString?.() ?? null;
}

function nonAdminConflict() {
  return ApiError.conflict(
    'ADMIN_EMAIL is already used by an account with a different role.',
    'ADMIN_EMAIL_IN_USE',
  );
}

/**
 * Create the single Admin account, or do nothing when it already exists.
 *
 * The auth factory is called with fresh env config each run and the explicit
 * `allowAdminCreation: true` opt-in. `signUpEmail` is then invoked as a direct
 * server call with NO `headers` and NO `request`; Better Auth's hook requires
 * both that option and this call shape, so no browser /sign-up call can assign
 * Admin. The same Better Auth path hashes the password and writes through the
 * shared MongoDB adapter. No Admin plugin or second authentication system is
 * added.
 */
export async function seedAdmin(env, dependencies = {}) {
  const config = validateAdminConfig(env);
  const connect = dependencies.connectToDatabase ?? connectToDatabase;
  const disconnect = dependencies.disconnectFromDatabase ?? disconnectFromDatabase;
  const authFactory = dependencies.createAuth ?? createAuth;
  const findExisting = dependencies.findUserByEmail ?? findUserByEmail;
  const logger = dependencies.logger ?? console;

  let connected = false;

  try {
    await connect(env);
    connected = true;

    const existingUser = await findExisting(config.email);

    if (existingUser) {
      if (existingUser.role === USER_ROLES.ADMIN) {
        logger.log('[seed] Admin account already exists. No changes were made.');

        return { status: 'already-exists', id: safeUserId(existingUser) };
      }

      throw nonAdminConflict();
    }

    let createdUser;

    try {
      const auth = authFactory(env, { allowAdminCreation: true });
      const result = await auth.api.signUpEmail({
        body: {
          name: config.name,
          email: config.email,
          password: config.password,
          role: USER_ROLES.ADMIN,
        },
      });

      createdUser = result?.user;
    } catch (error) {
      // Two concurrent seeds can both pass the pre-check. If the loser sees
      // that the winner created an Admin, it becomes a harmless no-op too.
      if (!isDuplicateUserError(error)) {
        throw error;
      }

      const racedUser = await findExisting(config.email);

      if (racedUser?.role === USER_ROLES.ADMIN) {
        logger.log('[seed] Admin account already exists. No changes were made.');

        return { status: 'already-exists', id: safeUserId(racedUser) };
      }

      throw nonAdminConflict();
    }

    logger.log('[seed] Admin account created.');

    return { status: 'created', id: safeUserId(createdUser) };
  } finally {
    if (connected) {
      await disconnect();
    }
  }
}

/** CLI errors are reduced to safe text; raw driver/auth messages are hidden. */
export function formatSeedError(error) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (
    error instanceof Error &&
    /^Invalid (admin seed|environment) configuration:/.test(error.message)
  ) {
    return error.message;
  }

  return 'Admin seed failed. Check the server configuration and try again.';
}

/**
 * Testable CLI runner.
 *
 * Dependencies are injectable so a test can prove that the loader result is
 * passed to the seed and that the seed promise is awaited, without touching
 * the real .env, MongoDB Atlas or process.exitCode. Raw errors are replaced
 * with the safe message from formatSeedError before being rethrown.
 */
export async function runSeedCli(dependencies = {}) {
  const load = dependencies.loadEnv ?? loadEnv;
  const runSeed = dependencies.seedAdmin ?? seedAdmin;
  const seedDependencies = dependencies.seedDependencies ?? {};

  try {
    const env = load();

    return await runSeed(env, seedDependencies);
  } catch (error) {
    throw new Error(formatSeedError(error));
  }
}

async function main() {
  return runSeedCli();
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    // runSeedCli has already removed secrets and driver details from the message.
    console.error(`[seed] ${error.message}`);
    process.exitCode = 1;
  });
}
