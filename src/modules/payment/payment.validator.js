import { z } from 'zod';

import { ApiError } from '../../utils/api-error.js';

/** Subscription endpoints must not accept prices, ids or plan fields. */
const FORBIDDEN_FIELDS = new Set([
  'price',
  'priceId',
  'price_id',
  'customerId',
  'customer_id',
  'subscriptionId',
  'subscription_id',
  'plan',
  'subscriptionPlan',
  'subscriptionStatus',
  'subscriptionExpiresAt',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'amount',
  'currency',
  'vendorId',
  'role',
  '_id',
  'id',
]);

const EMPTY_BODY_SCHEMA = z.object({}).strict();

/**
 * Checkout and cancellation take no client input. Unknown keys fail with the
 * normal Zod validation envelope; server-owned keys get a specific safe code.
 */
export function validateEmptyBody(body) {
  const value = body ?? {};

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const forbidden = Object.keys(value).find((key) => FORBIDDEN_FIELDS.has(key));

    if (forbidden) {
      throw ApiError.badRequest(
        `The field '${forbidden}' is managed by the server.`,
        'FORBIDDEN_FIELD',
      );
    }
  }

  const result = EMPTY_BODY_SCHEMA.safeParse(value);

  if (!result.success) {
    throw result.error;
  }

  return {};
}

/** Fixed event names; unknown Stripe events are ignored without state changes. */
export const STRIPE_EVENT_TYPES = Object.freeze({
  CHECKOUT_SESSION_COMPLETED: 'checkout.session.completed',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
  CUSTOMER_SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
  CUSTOMER_SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
});

export const HANDLED_STRIPE_EVENT_TYPES = Object.freeze(Object.values(STRIPE_EVENT_TYPES));
