import { z } from 'zod';

import { ApiError } from '../../utils/api-error.js';
import {
  MENU_CATEGORIES,
  MENU_STATUS,
} from '../menu/menu.validator.js';

/** Only these two target states are valid moderation decisions. */
export const MODERATION_TARGET_STATUSES = Object.freeze([
  MENU_STATUS.APPROVED,
  MENU_STATUS.REJECTED,
]);

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

const adminListSchema = z
  .object({
    search: textSchema('Search', 1, MAX_SEARCH_LENGTH).optional(),
    status: z.enum(Object.values(MENU_STATUS)).optional(),
    category: z.enum(MENU_CATEGORIES).optional(),
    location: textSchema('Location', 1, 120).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

const moderationSchema = z
  .object({
    status: z.enum(MODERATION_TARGET_STATUSES),
  })
  .strict();

const publishedAvailabilitySchema = z
  .object({
    isAvailable: z.boolean(),
  })
  .strict();

/** A moderation request owns only the target status, never an item field. */
const MODERATION_RESERVED_FIELDS = new Set([
  'vendorId',
  'itemName',
  'category',
  'description',
  'price',
  'location',
  'images',
  'createdAt',
  'updatedAt',
  'isAvailable',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
  'id',
  '_id',
]);

/**
 * Published availability owns only `isAvailable`. `status` is deliberately
 * reserved here so this route cannot become a second moderation path.
 */
const PUBLISHED_AVAILABILITY_RESERVED_FIELDS = new Set([
  ...[...MODERATION_RESERVED_FIELDS].filter((field) => field !== 'isAvailable'),
  'status',
]);

function requireObject(body) {
  if (body === null || body === undefined || Array.isArray(body) || typeof body !== 'object') {
    throw ApiError.badRequest('A JSON object is required.', 'INVALID_BODY');
  }
}

/** Strict query validation prevents operator objects reaching MongoDB. */
export function validateAdminMenuQuery(query) {
  return adminListSchema.parse(query ?? {});
}

/**
 * Moderation accepts exactly `{ status: 'approved' | 'rejected' }`. Reserved
 * fields get the project's explicit FORBIDDEN_FIELD response; any other extra
 * key is rejected by Zod's strict object.
 */
export function validateModerationBody(body) {
  requireObject(body);

  const reserved = Object.keys(body).filter((key) => MODERATION_RESERVED_FIELDS.has(key));

  if (reserved.length > 0) {
    throw ApiError.badRequest(
      `These fields cannot be set here: ${reserved.join(', ')}.`,
      'FORBIDDEN_FIELD',
    );
  }

  return moderationSchema.parse(body);
}

/**
 * Admin-only published-item availability control. It accepts exactly
 * `{ isAvailable: boolean }`; moderation status stays on its own route.
 */
export function validatePublishedAvailabilityBody(body) {
  requireObject(body);

  const reserved = Object.keys(body).filter((key) =>
    PUBLISHED_AVAILABILITY_RESERVED_FIELDS.has(key),
  );

  if (reserved.length > 0) {
    throw ApiError.badRequest(
      `These fields cannot be set here: ${reserved.join(', ')}.`,
      'FORBIDDEN_FIELD',
    );
  }

  return publishedAvailabilitySchema.parse(body);
}
