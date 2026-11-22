import { z } from 'zod';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { ApiError } from '../../utils/api-error.js';

/** Only roles that can exist in Better Auth's `users` collection. */
export const ADMIN_USER_ROLES = Object.freeze(Object.values(USER_ROLES));

/** Values written by the verified Stripe webhook implementation. */
export const ADMIN_TRANSACTION_STATUSES = Object.freeze(['pending', 'paid', 'failed']);

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const MAX_SEARCH_LENGTH = 100;

const textSchema = (field, min, max) =>
  z
    .string()
    .trim()
    .min(min, `${field} must be at least ${min} character${min === 1 ? '' : 's'}.`)
    .max(max, `${field} must be at most ${max} characters.`)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), {
      message: `${field} contains unsupported characters.`,
    });

const adminUserQuerySchema = z
  .object({
    search: textSchema('Search', 1, MAX_SEARCH_LENGTH).optional(),
    role: z.enum(ADMIN_USER_ROLES).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const dateSchema = z
  .string()
  .refine(isCalendarDate, 'Date must be a real YYYY-MM-DD calendar date.');

const adminTransactionQuerySchema = z
  .object({
    status: z.enum(ADMIN_TRANSACTION_STATUSES).optional(),
    vendorId: z
      .string()
      .trim()
      .regex(OBJECT_ID_PATTERN, 'Vendor id must be a 24-character hexadecimal MongoDB id.')
      .transform((value) => value.toLowerCase())
      .optional(),
    fromDate: dateSchema.optional(),
    toDate: dateSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict()
  .refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, {
    path: ['toDate'],
    message: 'toDate must be on or after fromDate.',
  });

const EMPTY_BODY_SCHEMA = z.object({}).strict();

/**
 * Block/unblock owns exactly one server field. These get an explicit safe code;
 * every other unknown key is still rejected by the strict schema.
 */
const FORBIDDEN_BLOCK_FIELDS = new Set([
  'role',
  'isBlocked',
  'email',
  'emailVerified',
  'password',
  'passwordHash',
  'resetToken',
  'resetTokenExpiresAt',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'subscriptionLastStripeEventCreated',
  'subscriptionLastStripeEventPriority',
  'vendorId',
  'paymentStatus',
  'status',
  'amount',
  'currency',
  'menuItems',
  'orders',
  'transactions',
  'account',
  'accounts',
  'session',
  'sessions',
  'verification',
  'createdAt',
  'updatedAt',
  'id',
  '_id',
]);

function requireObject(body) {
  if (body === null || body === undefined || Array.isArray(body) || typeof body !== 'object') {
    throw ApiError.badRequest('A JSON object is required.', 'INVALID_BODY');
  }
}

/** Strict Admin user query. Unknown/operator keys never reach MongoDB. */
export function validateAdminUserQuery(query) {
  return adminUserQuerySchema.parse(query ?? {});
}

/** Strict, read-only transaction query using the existing payment schema. */
export function validateAdminTransactionQuery(query) {
  return adminTransactionQuerySchema.parse(query ?? {});
}

/** Require a canonical ObjectId instead of allowing operator-shaped ids. */
export function validateAdminUserId(id) {
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
    throw ApiError.badRequest('Invalid user id.', 'INVALID_USER_ID');
  }

  return id.toLowerCase();
}

/** Block and unblock accept an empty body and nothing else. */
export function validateAdminBlockBody(body) {
  const value = body ?? {};

  requireObject(value);

  const attempted = Object.keys(value).filter((key) => FORBIDDEN_BLOCK_FIELDS.has(key));

  if (attempted.length > 0) {
    throw ApiError.badRequest(
      `These fields cannot be changed here: ${attempted.join(', ')}.`,
      'FORBIDDEN_FIELD',
    );
  }

  return EMPTY_BODY_SCHEMA.parse(value);
}
