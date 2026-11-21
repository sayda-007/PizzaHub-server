import { ApiError } from '../../utils/api-error.js';
import { createStripeClient, requireStripeConfig } from '../../services/stripe.js';

/** Thin Express adapter; all plan and price values come from the service. */
export function createPaymentController(service) {
  function currentVendor(req) {
    const user = req.user;

    if (!user || typeof user.id !== 'string' || user.id.trim() === '') {
      throw ApiError.unauthorized('Authentication required.', 'UNAUTHORIZED');
    }

    return user.id;
  }

  return {
    async checkout(req, res, next) {
      try {
        const result = await service.createCheckout(currentVendor(req), req.body);

        return res.status(201).json(result);
      } catch (error) {
        return next(error);
      }
    },

    async status(req, res, next) {
      try {
        const result = await service.getStatus(currentVendor(req));

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async cancel(req, res, next) {
      try {
        const result = await service.cancelSubscription(currentVendor(req), req.body);

        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },
  };
}

/**
 * Stripe webhooks are public but never trusted: verification uses the exact raw
 * bytes and the server-side webhook secret before any event is processed.
 */
export function createStripeWebhookController(service, options = {}) {
  const stripeSource = options.stripe;
  const env = options.env ?? {};

  function getStripe() {
    if (typeof stripeSource === 'function') {
      return stripeSource();
    }

    if (stripeSource) {
      return stripeSource;
    }

    if (options.createStripeClient) {
      return options.createStripeClient(env);
    }

    return createStripeClient(env);
  }

  return async function webhook(req, res, next) {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw ApiError.badRequest('A raw JSON body is required.', 'INVALID_STRIPE_EVENT');
      }

      const signature = req.headers['stripe-signature'];

      if (typeof signature !== 'string' || signature.trim() === '') {
        throw ApiError.badRequest('Missing Stripe signature.', 'INVALID_STRIPE_SIGNATURE');
      }

      const config = requireStripeConfig(env);
      let event;

      try {
        event = getStripe().webhooks.constructEvent(req.body, signature, config.webhookSecret);
      } catch {
        throw ApiError.badRequest('Invalid Stripe signature.', 'INVALID_STRIPE_SIGNATURE');
      }

      const result = await service.processWebhookEvent(event);

      return res.json({ received: true, ...result });
    } catch (error) {
      return next(error);
    }
  };
}
