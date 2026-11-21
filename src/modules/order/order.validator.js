import { z } from 'zod';

import { ApiError } from '../../utils/api-error.js';

/** Server-owned order states. Clients never choose their own initial state. */
export const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

/** Pending and accepted orders reserve the duplicate-order key. */
export const ACTIVE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.ACCEPTED,
]);

/** Vendors may move a pending order to exactly one of these two states. */
export const VENDOR_ORDER_TARGET_STATUSES = Object.freeze([
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.REJECTED,
]);

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const MAX_ADDRESS_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 500;

/**
 * A real YYYY-MM-DD calendar date. This rejects impossible dates such as
 * 2026-02-30 without relying on Date's lenient rollover behavior.
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const textSchema = (field, min, max) =>
  z
    .string()
    .trim()
    .min(min, `${field} must be at least ${min} character${min === 1 ? '' : 's'}.`)
    .max(max, `${field} must be at most ${max} characters.`)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), {
      message: `${field} contains unsupported characters.`,
    });

const createSchema = z
  .object({
    itemId: z
      .string()
      .trim()
      .regex(OBJECT_ID_PATTERN, 'Item id must be a 24-character hexadecimal MongoDB id.')
      .transform((value) => value.toLowerCase()),
    deliveryDate: z
      .string()
      .refine(isCalendarDate, 'Delivery date must be a real YYYY-MM-DD calendar date.'),
    deliveryAddress: textSchema('Delivery address', 1, MAX_ADDRESS_LENGTH),
    additionalMessage: textSchema('Additional message', 1, MAX_MESSAGE_LENGTH).optional(),
  })
  .strict();

const statusSchema = z
  .object({
    status: z.enum(VENDOR_ORDER_TARGET_STATUSES),
  })
  .strict();

const customerPaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

const vendorPaginationSchema = z
  .object({
    status: z.enum(Object.values(ORDER_STATUS)).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

const emptyBodySchema = z.object({}).strict();

/** Fields that must never come from a client when placing an order. */
const CREATE_RESERVED_FIELDS = new Set([
  'customerId',
  'vendorId',
  'price',
  'status',
  'itemSnapshot',
  'activeOrderKey',
  'createdAt',
  'updatedAt',
  'id',
  '_id',
  'role',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
]);

/** Fields that must never come from a client during a vendor status change. */
const STATUS_RESERVED_FIELDS = new Set([
  'customerId',
  'vendorId',
  'itemId',
  'price',
  'deliveryDate',
  'deliveryAddress',
  'additionalMessage',
  'itemSnapshot',
  'activeOrderKey',
  'createdAt',
  'updatedAt',
  'id',
  '_id',
  'role',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
]);

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

/** Strict order creation body. Server-owned values are rejected explicitly. */
export function validateOrderCreate(body) {
  requireObject(body);
  rejectReservedFields(body, CREATE_RESERVED_FIELDS);

  return createSchema.parse(body);
}

/** Vendor status updates own only the target status. */
export function validateOrderStatusUpdate(body) {
  requireObject(body);
  rejectReservedFields(body, STATUS_RESERVED_FIELDS);

  return statusSchema.parse(body);
}

/** The customer cancellation route has no body. */
export function validateCancelBody(body) {
  if (body === undefined || body === null) {
    return {};
  }

  requireObject(body);

  return emptyBodySchema.parse(body);
}

/** Strict customer pagination query. Unknown/operator keys never reach MongoDB. */
export function validateCustomerOrderQuery(query) {
  return customerPaginationSchema.parse(query ?? {});
}

/** Vendor pagination with an optional exact status filter. */
export function validateVendorOrderQuery(query) {
  return vendorPaginationSchema.parse(query ?? {});
}
