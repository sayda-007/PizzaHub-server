import { z } from 'zod';

import { ApiError } from '../../utils/api-error.js';

/** Exactly the categories from the assignment. */
export const MENU_CATEGORIES = Object.freeze([
  'Classic Pizzas',
  'Vegetarian Pizzas',
  'Meat Lovers',
  'Specialty / Gourmet Pizzas',
  'Sides & Appetizers',
  'Beverages & Desserts',
]);

export const MENU_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  INACTIVE: 'inactive',
});

const MAX_PRICE = 10_000;

/** Fields the server owns. Sending any of these is always a client error. */
const CREATE_RESERVED_FIELDS = new Set([
  'images',
  'status',
  'vendorId',
  'createdAt',
  'updatedAt',
  'isAvailable',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
  'id',
  '_id',
]);

const UPDATE_RESERVED_FIELDS = new Set([
  'images',
  'status',
  'vendorId',
  'createdAt',
  'updatedAt',
  'isAvailable',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
  'id',
  '_id',
]);

const textSchema = (field, min, max) =>
  z
    .string()
    .trim()
    .min(min, `${field} must be at least ${min} character${min === 1 ? '' : 's'}.`)
    .max(max, `${field} must be at most ${max} characters.`)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), {
      message: `${field} contains unsupported characters.`,
    });

const itemNameSchema = textSchema('Item name', 2, 120);
const descriptionSchema = textSchema('Description', 1, 1000);
const locationSchema = textSchema('Location', 1, 120);

const categorySchema = z.enum(MENU_CATEGORIES);

/**
 * Multipart text fields arrive as strings, while JSON clients send numbers.
 * The regex rejects scientific notation, negatives and more than two decimals
 * before the value ever reaches MongoDB.
 */
const priceSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();

    return /^\d+(?:\.\d{1,2})?$/.test(trimmed) ? Number(trimmed) : trimmed;
  },
  z
    .number()
    .refine(Number.isFinite, { message: 'Price must be a finite number.' })
    .refine((value) => value > 0, { message: 'Price must be greater than zero.' })
    .refine((value) => value <= MAX_PRICE, { message: `Price must not exceed ${MAX_PRICE}.` })
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, {
      message: 'Price must have at most two decimal places.',
    }),
);

const createSchema = z
  .object({
    itemName: itemNameSchema,
    category: categorySchema,
    description: descriptionSchema,
    price: priceSchema,
    location: locationSchema,
  })
  .strict();

const updateSchema = z
  .object({
    itemName: itemNameSchema.optional(),
    category: categorySchema.optional(),
    description: descriptionSchema.optional(),
    price: priceSchema.optional(),
    location: locationSchema.optional(),
  })
  .strict();

const paginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

function requireObject(body) {
  if (body === null || body === undefined || Array.isArray(body) || typeof body !== 'object') {
    throw ApiError.badRequest('A JSON object is required.', 'INVALID_BODY');
  }
}

function rejectReservedFields(body, reservedFields) {
  const attempted = Object.keys(body).filter((key) => reservedFields.has(key));

  if (attempted.length > 0) {
    throw ApiError.badRequest(
      `These fields cannot be set here: ${attempted.join(', ')}.`,
      'FORBIDDEN_FIELD',
    );
  }
}

/** Validate the text fields of a multipart create before calling ImgBB. */
export function validateMenuCreate(body) {
  requireObject(body);
  rejectReservedFields(body, CREATE_RESERVED_FIELDS);

  return createSchema.parse(body);
}

/** Validate a JSON patch; unknown and server-owned fields are rejected. */
export function validateMenuUpdate(body) {
  requireObject(body);

  const keys = Object.keys(body);

  if (keys.length === 0) {
    throw ApiError.badRequest('No menu fields to update.', 'EMPTY_UPDATE');
  }

  rejectReservedFields(body, UPDATE_RESERVED_FIELDS);

  return updateSchema.parse(body);
}

/** Strict query validation prevents operator objects reaching MongoDB. */
export function validateMenuPagination(query) {
  return paginationSchema.parse(query ?? {});
}
