import { z } from 'zod';

import { USER_ROLES } from '../../auth/config/better-auth.js';
import { ApiError } from '../../utils/api-error.js';

/** The only fields a user may send to PATCH /api/users/me. */
export const PROFILE_UPDATE_FIELDS = Object.freeze(['name', 'image', 'businessName']);

/**
 * These get an explicit, friendly rejection. Any other unknown field is still
 * rejected by Zod's `.strict()` below, so there is no silent pass-through.
 */
const RESERVED_PROFILE_FIELDS = new Set([
  'role',
  'isBlocked',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
  'email',
  'emailVerified',
  'password',
  'passwordHash',
  'resetToken',
  'resetTokenExpiresAt',
  'id',
  '_id',
  'createdAt',
  'updatedAt',
  'session',
  'sessions',
  'account',
  'accounts',
]);

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(120, 'Name must be at most 120 characters.')
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), {
    message: 'Name contains unsupported characters.',
  });

const imageSchema = z.union([
  z
    .url('Image must be a valid URL.')
    .max(2048, 'Image URL is too long.')
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'Image URL must use http or https.',
    }),
  z.null(),
]);

const businessNameTextSchema = z
  .string()
  .trim()
  .min(2, 'Business name must be at least 2 characters.')
  .max(120, 'Business name must be at most 120 characters.')
  .regex(/^[\p{L}\p{N}\s.,&'()\-]+$/u, {
    message: 'Business name contains unsupported characters.',
  });

/** Null lets a vendor clear the field without sending a reserved field. */
const businessNameSchema = z.union([businessNameTextSchema, z.null()]);

const profileUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    image: imageSchema.optional(),
    businessName: businessNameSchema.optional(),
  })
  .strict();

/**
 * Validate a profile patch before any database work happens.
 *
 * Returning a ZodError is intentional: the central error handler already maps
 * it to a safe 400 VALIDATION_ERROR response with field details.
 */
export function validateProfileUpdate(body, options = {}) {
  if (body === null || body === undefined || Array.isArray(body) || typeof body !== 'object') {
    throw ApiError.badRequest('A JSON object with profile fields is required.', 'INVALID_BODY');
  }

  const keys = Object.keys(body);

  if (keys.length === 0) {
    throw ApiError.badRequest('No profile fields to update.', 'EMPTY_UPDATE');
  }

  const attemptedReservedFields = keys.filter((key) => RESERVED_PROFILE_FIELDS.has(key));

  if (attemptedReservedFields.length > 0) {
    throw ApiError.badRequest(
      `These fields cannot be changed here: ${attemptedReservedFields.join(', ')}.`,
      'FORBIDDEN_FIELD',
    );
  }

  if (
    Object.hasOwn(body, 'businessName') &&
    options.role !== USER_ROLES.VENDOR
  ) {
    throw ApiError.forbidden('Only vendors can update businessName.', 'FORBIDDEN_FIELD');
  }

  return profileUpdateSchema.parse(body);
}
