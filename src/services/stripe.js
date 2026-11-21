import Stripe from 'stripe';

import { ApiError } from '../utils/api-error.js';

/**
 * Server-only Stripe configuration.
 *
 * Values are supplied by loadEnv(), which removes example placeholders before
 * the app starts. This layer repeats the checks so a manually built env object
 * cannot silently reach a payment provider with bad configuration.
 */
const CREDENTIAL_PLACEHOLDER = /(replace[-_]?with|your[-_]|change[-_]?me|placeholder|dummy|fake|paste[-_]|todo|xxx|<[^>]+>)/i;

const REQUIRED_VARIABLES = Object.freeze([
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PREMIUM_PRICE_ID',
]);

function isUsable(value) {
  return typeof value === 'string' && value.trim() !== '' && !CREDENTIAL_PLACEHOLDER.test(value.trim());
}

function paymentUnavailable() {
  return new ApiError(
    503,
    'Premium subscriptions are not configured on this server.',
    'PAYMENT_UNAVAILABLE',
  );
}

/** Validate every Stripe setting without ever including a value in an error. */
export function requireStripeConfig(env = {}) {
  const values = Object.fromEntries(
    REQUIRED_VARIABLES.map((name) => [name, typeof env[name] === 'string' ? env[name].trim() : '']),
  );

  if (REQUIRED_VARIABLES.some((name) => !isUsable(values[name]))) {
    throw paymentUnavailable();
  }

  const clientUrl = typeof env.CLIENT_URL === 'string' ? env.CLIENT_URL.trim() : '';

  if (!isUsable(clientUrl)) {
    throw paymentUnavailable();
  }

  let parsedClientUrl;

  try {
    parsedClientUrl = new URL(clientUrl);
  } catch {
    throw paymentUnavailable();
  }

  if (!['http:', 'https:'].includes(parsedClientUrl.protocol)) {
    throw paymentUnavailable();
  }

  if (!/^sk_(test|live)_/.test(values.STRIPE_SECRET_KEY)) {
    throw paymentUnavailable();
  }

  if (!/^whsec_/.test(values.STRIPE_WEBHOOK_SECRET)) {
    throw paymentUnavailable();
  }

  if (!/^price_/.test(values.STRIPE_PREMIUM_PRICE_ID)) {
    throw paymentUnavailable();
  }

  return Object.freeze({
    secretKey: values.STRIPE_SECRET_KEY,
    webhookSecret: values.STRIPE_WEBHOOK_SECRET,
    premiumPriceId: values.STRIPE_PREMIUM_PRICE_ID,
    clientUrl: parsedClientUrl.origin,
  });
}

/** Return true when all Stripe settings are present and safe. */
export function isStripeConfigured(env) {
  try {
    requireStripeConfig(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the official Stripe SDK client. The SDK's default API version is used
 * deliberately; pinning an old version here would drift from the installed
 * client. `sdk` is injectable only for tests.
 */
export function createStripeClient(env, options = {}) {
  const config = requireStripeConfig(env);
  const sdk = options.sdk ?? Stripe;

  return new sdk(config.secretKey, { maxNetworkRetries: 2 });
}

/** Raw provider errors are never allowed to reach a client. */
export function toSafePaymentError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError(502, 'The payment service could not complete the request.', 'PAYMENT_UNAVAILABLE');
}
