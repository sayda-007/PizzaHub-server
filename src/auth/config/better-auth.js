import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';

import { COLLECTIONS } from '../../database/collections.js';
import { getDb, getMongoClient } from '../../database/mongo.js';

/** The only roles the application recognizes. Admin is created only by a trusted server process. */
export const USER_ROLES = Object.freeze({
  CUSTOMER: 'customer',
  VENDOR: 'vendor',
  ADMIN: 'admin',
});

/** Roles a member of the public is allowed to choose during registration. */
export const PUBLIC_REGISTRATION_ROLES = Object.freeze([
  USER_ROLES.CUSTOMER,
  USER_ROLES.VENDOR,
]);

export const SUBSCRIPTION_PLANS = Object.freeze({
  FREE: 'free',
  PREMIUM: 'premium',
});

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Fields owned by the server. `role` is a valid sign-up input but is forbidden
 * on profile updates, so it is included in this update-protection list.
 */
const SERVER_OWNED_USER_FIELDS = Object.freeze([
  'role',
  'isBlocked',
  'subscriptionPlan',
  'subscriptionExpiresAt',
]);

/** Registration may set `role` (validated separately) and `businessName` only. */
const REGISTRATION_RESERVED_FIELDS = Object.freeze([
  'isBlocked',
  'subscriptionPlan',
  'subscriptionExpiresAt',
]);

function sanitizeBusinessName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim().slice(0, 120) || null;
}

function isPublicRegistrationRole(value) {
  return PUBLIC_REGISTRATION_ROLES.includes(value);
}

/**
 * A direct `auth.api.*` call has no HTTP request or headers. Express always
 * supplies both to Better Auth, so this is the narrow, documented signal that
 * the call came from trusted server code (the seed script), not a browser.
 */
export function isTrustedServerOnlyAuthCall(context) {
  if (!context || typeof context !== 'object') {
    return false;
  }

  return !context.request && !context.headers;
}

/** Admin creation is an explicit opt-in, never a default of createAuth(). */
export function isAdminCreationAllowed(options) {
  return options?.allowAdminCreation === true;
}

/**
 * Second layer for non-API paths (for example OAuth profile mapping): keep a
 * valid customer/vendor choice. Admin is accepted only when BOTH conditions
 * hold: the Better Auth instance was explicitly created with
 * `allowAdminCreation: true`, and the call is a direct server-side API call
 * with no HTTP request or headers. Every other source falls back to customer.
 */
export function resolveRegistrationRole(value, context, options = {}) {
  if (isPublicRegistrationRole(value)) {
    return value;
  }

  if (
    value === USER_ROLES.ADMIN &&
    isAdminCreationAllowed(options) &&
    isTrustedServerOnlyAuthCall(context)
  ) {
    return USER_ROLES.ADMIN;
  }

  return USER_ROLES.CUSTOMER;
}

/**
 * Password complexity for email registration only. Better Auth already rejects
 * a completely missing password; this hook enforces the assignment's rules when
 * a password is supplied. Messages never include the submitted value.
 */
function validateEmailPassword(password) {
  if (typeof password !== 'string') {
    throw new APIError('BAD_REQUEST', {
      message: 'Password must be a string.',
    });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new APIError('BAD_REQUEST', {
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new APIError('BAD_REQUEST', {
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    });
  }

  if (!/[A-Z]/.test(password)) {
    throw new APIError('BAD_REQUEST', {
      message: 'Password must include at least one uppercase letter.',
    });
  }

  if (!/[a-z]/.test(password)) {
    throw new APIError('BAD_REQUEST', {
      message: 'Password must include at least one lowercase letter.',
    });
  }
}

/**
 * Build a Better Auth instance.
 *
 * This is a factory on purpose: the adapter needs the MongoDB connection that
 * server.js opens first, so creating the instance at import time would fail.
 *
 * `allowAdminCreation` is OFF by default. Only the seed script may turn it on,
 * and even then the Admin role is accepted only from a direct server-side
 * auth.api call with no HTTP request or headers.
 */
export function createAuth(env, options = {}) {
  const allowAdminCreation = isAdminCreationAllowed(options);
  const database = options.database;

  // Google is enabled only when real credentials are configured. Local
  // development works with email/password alone.
  const socialProviders = {};

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.CLIENT_URL, env.BETTER_AUTH_URL].filter(Boolean),

    // One driver, one database, one client: no second connection pool. Passing
    // the client also enables transactions on Atlas replica sets.
    database: database ?? mongodbAdapter(getDb(), { client: getMongoClient() }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },

    socialProviders,

    plugins: [jwt()],

    user: {
      // Better Auth's `user` model is stored in the assignment's `users` collection.
      modelName: COLLECTIONS.USERS,
      additionalFields: {
        role: {
          // The public schema only knows the two public roles. Admin is created
          // exclusively by the trusted server-only seed script.
          type: [...PUBLIC_REGISTRATION_ROLES],
          required: false,
          defaultValue: USER_ROLES.CUSTOMER,
          input: true,
        },
        isBlocked: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
        },
        businessName: {
          type: 'string',
          required: false,
          input: true,
        },
        subscriptionPlan: {
          type: [SUBSCRIPTION_PLANS.FREE, SUBSCRIPTION_PLANS.PREMIUM],
          required: false,
          defaultValue: SUBSCRIPTION_PLANS.FREE,
          input: false,
        },
        subscriptionExpiresAt: {
          type: 'date',
          required: false,
          input: false,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Runs for every sign-up method (email/password and OAuth). A valid
          // public choice is preserved; anything else becomes a customer.
          before: async (user, context) => ({
            data: {
              ...user,
              role: resolveRegistrationRole(user.role, context, { allowAdminCreation }),
              isBlocked: false,
              subscriptionPlan: SUBSCRIPTION_PLANS.FREE,
              subscriptionExpiresAt: null,
              businessName: sanitizeBusinessName(user.businessName),
            },
          }),
        },
        update: {
          // Even if a future endpoint forgets the request-hook checks, these
          // fields can never be changed through a normal user update request.
          before: async (user) => {
            const data = { ...user };

            for (const field of SERVER_OWNED_USER_FIELDS) {
              delete data[field];
            }

            if ('businessName' in data) {
              data.businessName = sanitizeBusinessName(data.businessName);
            }

            return { data };
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const isRegistration = typeof ctx.path === 'string' && ctx.path.startsWith('/sign-up');
        const isEmailRegistration = ctx.path === '/sign-up/email';
        const isProfileUpdate = ctx.path === '/update-user';

        if (!isRegistration && !isProfileUpdate) {
          return;
        }

        const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};

        // Registration is the one place where `role` is allowed, but a browser
        // may only choose a public role. Admin needs BOTH the explicit seed-only
        // opt-in on this Better Auth instance AND a direct server-side call.
        if (
          isRegistration &&
          'role' in body &&
          !isPublicRegistrationRole(body.role) &&
          !(
            body.role === USER_ROLES.ADMIN &&
            allowAdminCreation &&
            isTrustedServerOnlyAuthCall(ctx)
          )
        ) {
          throw new APIError('BAD_REQUEST', {
            message: `Role must be one of: ${PUBLIC_REGISTRATION_ROLES.join(', ')}.`,
          });
        }

        const reservedFields = isRegistration
          ? REGISTRATION_RESERVED_FIELDS
          : SERVER_OWNED_USER_FIELDS;
        const attempted = reservedFields.filter((field) => field in body);

        if (attempted.length > 0) {
          throw new APIError('BAD_REQUEST', {
            message: `Reserved fields cannot be set here: ${attempted.join(', ')}.`,
          });
        }

        // Only email/password registration has a password. Google OAuth and
        // other paths bypass this check entirely.
        if (isEmailRegistration && 'password' in body) {
          validateEmailPassword(body.password);
        }
      }),
    },
  });
}
