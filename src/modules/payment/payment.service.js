import { ObjectId } from 'mongodb';

import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  USER_ROLES,
} from '../../auth/config/better-auth.js';
import {
  getTransactionsCollection,
  getUsersCollection,
} from '../../database/collections.js';
import {
  createStripeClient,
  requireStripeConfig,
  toSafePaymentError,
} from '../../services/stripe.js';
import { ApiError } from '../../utils/api-error.js';
import { isPremiumSubscription } from '../menu/menu.service.js';
import {
  STRIPE_EVENT_TYPES,
  validateEmptyBody,
} from './payment.validator.js';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const PREMIUM_PURPOSE = 'pizzahub_premium';

/**
 * Equal-timestamp events still need a deterministic winner. Deletion wins over
 * updates, which win over payment events, which win over checkout completion.
 */
export const STRIPE_EVENT_PRIORITY = Object.freeze({
  [STRIPE_EVENT_TYPES.CHECKOUT_SESSION_COMPLETED]: 10,
  [STRIPE_EVENT_TYPES.INVOICE_PAYMENT_FAILED]: 20,
  [STRIPE_EVENT_TYPES.INVOICE_PAID]: 30,
  [STRIPE_EVENT_TYPES.CUSTOMER_SUBSCRIPTION_UPDATED]: 40,
  [STRIPE_EVENT_TYPES.CUSTOMER_SUBSCRIPTION_DELETED]: 50,
});

function toObjectId(id, code = 'INVALID_VENDOR_ID') {
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
    throw ApiError.badRequest('Invalid vendor id.', code);
  }

  return new ObjectId(id);
}

function vendorIdOf(user) {
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' && user.id.trim() !== '') {
    return user.id;
  }

  return user._id?.toString?.() ?? (user._id === undefined ? null : String(user._id));
}

function idOf(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }

  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id !== '') {
    return value.id;
  }

  return null;
}

function metadataVendorIdOf(value) {
  return (
    value?.metadata?.vendorId ??
    value?.subscription_details?.metadata?.vendorId ??
    value?.client_reference_id ??
    null
  );
}

function dateFromSeconds(value) {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const date = new Date(seconds * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
}

function asDateOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function currentPeriodEndOf(subscription) {
  const items = subscription?.items?.data;
  const itemEnd = Array.isArray(items)
    ? items.map((item) => Number(item?.current_period_end)).find((value) => Number.isFinite(value))
    : undefined;

  return dateFromSeconds(itemEnd ?? subscription?.current_period_end);
}

/** Translate a Stripe subscription object into the project's flat user fields. */
export function buildSubscriptionState(subscription) {
  const status = subscription?.status;
  const expiresAt = currentPeriodEndOf(subscription);
  const cancelAtPeriodEnd = status === 'canceled' ? false : subscription?.cancel_at_period_end === true;

  switch (status) {
    case 'active':
      return {
        plan: SUBSCRIPTION_PLANS.PREMIUM,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        expiresAt,
        cancelAtPeriodEnd,
      };
    case 'trialing':
    case 'paused':
    case 'incomplete':
      return {
        plan: SUBSCRIPTION_PLANS.PREMIUM,
        status: SUBSCRIPTION_STATUS.INACTIVE,
        expiresAt,
        cancelAtPeriodEnd,
      };
    case 'past_due':
    case 'unpaid':
      return {
        plan: SUBSCRIPTION_PLANS.PREMIUM,
        status: SUBSCRIPTION_STATUS.PAST_DUE,
        expiresAt,
        cancelAtPeriodEnd,
      };
    default:
      return {
        plan: SUBSCRIPTION_PLANS.FREE,
        status: SUBSCRIPTION_STATUS.CANCELED,
        expiresAt: null,
        cancelAtPeriodEnd: false,
      };
  }
}

function canceledState() {
  return {
    plan: SUBSCRIPTION_PLANS.FREE,
    status: SUBSCRIPTION_STATUS.CANCELED,
    expiresAt: null,
    cancelAtPeriodEnd: false,
  };
}

/** Payment failure revokes Premium immediately while retaining the expiry audit field. */
function failedPaymentState(user) {
  return {
    plan: SUBSCRIPTION_PLANS.PREMIUM,
    status: SUBSCRIPTION_STATUS.PAST_DUE,
    expiresAt: asDateOrNull(user?.subscriptionExpiresAt),
    cancelAtPeriodEnd: user?.subscriptionCancelAtPeriodEnd === true,
  };
}

function serializeDate(value) {
  const date = asDateOrNull(value);

  return date ? date.toISOString() : null;
}

/** Deliberately excludes Stripe ids and every private user field. */
export function serializeSubscriptionStatus(user, now = new Date()) {
  const status = user?.subscriptionStatus ?? SUBSCRIPTION_STATUS.INACTIVE;

  return {
    plan: user?.subscriptionPlan ?? SUBSCRIPTION_PLANS.FREE,
    status,
    expiresAt: serializeDate(user?.subscriptionExpiresAt),
    cancelAtPeriodEnd: user?.subscriptionCancelAtPeriodEnd === true,
    isPremium: isPremiumSubscription(user, now),
    // Server-owned UI hint: cancellation is possible only when Stripe has a
    // linked subscription that has not already reached a canceled state.
    canCancel: Boolean(user?.stripeSubscriptionId) && status !== SUBSCRIPTION_STATUS.CANCELED,
  };
}

function isDuplicateKeyError(error) {
  return (
    error?.code === 11000 ||
    error?.codeName === 'DuplicateKey' ||
    error?.writeErrors?.some?.((writeError) => writeError?.code === 11000) === true
  );
}

function isMissingStripeResource(error) {
  return error?.code === 'resource_missing' || error?.statusCode === 404;
}

function requireEvent(event) {
  if (
    !event ||
    typeof event.id !== 'string' ||
    event.id === '' ||
    typeof event.type !== 'string' ||
    !event.data ||
    typeof event.data.object !== 'object' ||
    event.data.object === null
  ) {
    throw ApiError.badRequest('Invalid Stripe event payload.', 'INVALID_STRIPE_EVENT');
  }

  const created = Number(event.created ?? event.data.object.created);

  if (!Number.isFinite(created)) {
    throw ApiError.badRequest('Invalid Stripe event timestamp.', 'INVALID_STRIPE_EVENT');
  }

  return Math.floor(created);
}

function mismatchError() {
  return ApiError.badRequest(
    'Stripe event metadata does not match the vendor.',
    'STRIPE_VENDOR_MISMATCH',
  );
}

/**
 * MongoDB work and Stripe calls for Premium subscriptions.
 *
 * Collections, the clock and the Stripe client are injectable so tests use
 * in-memory stores and fake API objects. Nothing here reads .env directly.
 */
export function createPaymentService(dependencies = {}) {
  const usersSource = dependencies.usersCollection ?? dependencies.users;
  const transactionsSource = dependencies.transactionsCollection ?? dependencies.transactions;
  const stripeSource = dependencies.stripe;
  const now = dependencies.now ?? (() => new Date());
  const env = dependencies.env ?? {};

  function getUsers() {
    if (typeof usersSource === 'function') {
      return usersSource();
    }

    return usersSource ?? getUsersCollection();
  }

  function getTransactions() {
    if (typeof transactionsSource === 'function') {
      return transactionsSource();
    }

    return transactionsSource ?? getTransactionsCollection();
  }

  function getStripe() {
    if (typeof stripeSource === 'function') {
      return stripeSource();
    }

    if (stripeSource) {
      return stripeSource;
    }

    return createStripeClient(env, { sdk: dependencies.sdk });
  }

  async function findVendorById(vendorId) {
    if (typeof vendorId !== 'string' || !OBJECT_ID_PATTERN.test(vendorId)) {
      throw ApiError.badRequest('Invalid vendor id.', 'INVALID_VENDOR_ID');
    }

    const user = await getUsers().findOne({
      _id: new ObjectId(vendorId),
      role: USER_ROLES.VENDOR,
    });

    if (!user) {
      throw ApiError.notFound('Vendor not found.', 'VENDOR_NOT_FOUND');
    }

    return user;
  }

  async function findVendorLoose(vendorId) {
    if (typeof vendorId !== 'string' || !OBJECT_ID_PATTERN.test(vendorId)) {
      return null;
    }

    return getUsers().findOne({ _id: new ObjectId(vendorId), role: USER_ROLES.VENDOR });
  }

  /** Stripe events are matched by server-set metadata first, then stored ids. */
  async function resolveVendorForEvent({ vendorId, customerId, subscriptionId }) {
    let user = await findVendorLoose(vendorId);

    if (!user && customerId) {
      user = await getUsers().findOne({
        stripeCustomerId: customerId,
        role: USER_ROLES.VENDOR,
      });
    }

    if (!user && subscriptionId) {
      user = await getUsers().findOne({
        stripeSubscriptionId: subscriptionId,
        role: USER_ROLES.VENDOR,
      });
    }

    if (!user) {
      throw ApiError.badRequest('No vendor matches this Stripe event.', 'STRIPE_VENDOR_NOT_FOUND');
    }

    return user;
  }

  function assertVendorMatchesEvent(user, { vendorId, customerId, subscriptionId, metadataVendorId }) {
    const expectedVendorId = vendorIdOf(user);

    for (const candidate of [vendorId, metadataVendorId]) {
      if (candidate !== null && candidate !== undefined && String(candidate) !== String(expectedVendorId)) {
        throw mismatchError();
      }
    }

    if (user.stripeCustomerId && customerId && user.stripeCustomerId !== customerId) {
      throw mismatchError();
    }

    if (user.stripeSubscriptionId && subscriptionId && user.stripeSubscriptionId !== subscriptionId) {
      throw mismatchError();
    }
  }

  /**
   * Conditional write: an older, duplicate or equal-but-lower-priority event can
   * never replace newer subscription state, even when events arrive out of order.
   */
  async function applyUserSubscriptionState({
    user,
    subscriptionId,
    customerId,
    state,
    eventCreated,
    eventPriority,
    eventId,
    eventType,
  }) {
    const orderGuard = {
      $or: [
        { subscriptionLastStripeEventCreated: { $exists: false } },
        { subscriptionLastStripeEventCreated: { $lt: eventCreated } },
        {
          subscriptionLastStripeEventCreated: eventCreated,
          subscriptionLastStripeEventPriority: { $lte: eventPriority },
        },
      ],
    };

    const conditions = [orderGuard];

    if (subscriptionId) {
      conditions.push({
        $or: [
          { stripeSubscriptionId: { $exists: false } },
          { stripeSubscriptionId: null },
          { stripeSubscriptionId: subscriptionId },
        ],
      });
    }

    const set = {
      subscriptionPlan: state.plan,
      subscriptionStatus: state.status,
      subscriptionExpiresAt: state.expiresAt,
      subscriptionCancelAtPeriodEnd: state.cancelAtPeriodEnd,
      subscriptionLastStripeEventCreated: eventCreated,
      subscriptionLastStripeEventPriority: eventPriority,
      subscriptionLastStripeEventType: eventType,
      subscriptionLastStripeEventId: eventId,
      updatedAt: now(),
    };

    if (subscriptionId) {
      set.stripeSubscriptionId = subscriptionId;
    }

    if (customerId && !user.stripeCustomerId) {
      set.stripeCustomerId = customerId;
    }

    const result = await getUsers().updateOne(
      {
        _id: toObjectId(vendorIdOf(user)),
        role: USER_ROLES.VENDOR,
        $and: conditions,
      },
      { $set: set },
    );

    return (result?.matchedCount ?? 0) > 0 || (result?.modifiedCount ?? 0) > 0;
  }

  /**
   * One transaction per Stripe identifier. The invoice unique index is the
   * atomic duplicate guard; the event timestamp prevents stale overwrites.
   */
  async function upsertTransaction(specification) {
    const collection = getTransactions();
    const filter = specification.stripeInvoiceId
      ? { stripeInvoiceId: specification.stripeInvoiceId }
      : { stripeSessionId: specification.stripeCheckoutSessionId };
    const existing = await collection.findOne(filter);

    if (existing && Number(existing.stripeEventCreated ?? 0) > specification.eventCreated) {
      return false;
    }

    const timestamp = now();
    const onInsert = {
      vendorId: specification.vendorId,
      stripeSubscriptionId: specification.stripeSubscriptionId,
      createdAt: timestamp,
      ...(specification.stripeInvoiceId ? { stripeInvoiceId: specification.stripeInvoiceId } : {}),
      ...(specification.stripeCheckoutSessionId
        ? {
            stripeSessionId: specification.stripeCheckoutSessionId,
            stripeCheckoutSessionId: specification.stripeCheckoutSessionId,
          }
        : {}),
    };
    const set = {
      paymentStatus: specification.paymentStatus,
      // `status` is retained for the existing admin/index contract.
      status: specification.paymentStatus,
      amount: specification.amount,
      currency: specification.currency,
      stripeSubscriptionId: specification.stripeSubscriptionId,
      stripeEventId: specification.eventId,
      stripeEventCreated: specification.eventCreated,
      eventType: specification.eventType,
      updatedAt: timestamp,
    };

    try {
      await collection.updateOne(filter, { $setOnInsert: onInsert, $set: set }, { upsert: true });
      return true;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw toSafePaymentError(error);
      }

      // Another delivery inserted the same immutable Stripe id first.
      const result = await collection.updateOne(
        {
          ...filter,
          $or: [
            { stripeEventCreated: { $lte: specification.eventCreated } },
            { stripeEventCreated: { $exists: false } },
          ],
        },
        { $set: set },
      );

      return (result?.matchedCount ?? 0) > 0 || (result?.modifiedCount ?? 0) > 0;
    }
  }

  async function ensureCustomer(user, stripe) {
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const created = await stripe.customers.create(
      {
        email: user.email,
        metadata: { vendorId: vendorIdOf(user), purpose: PREMIUM_PURPOSE },
      },
      { idempotencyKey: `pizzahub-customer-${vendorIdOf(user)}` },
    );
    const customerId = idOf(created);

    if (!customerId) {
      throw new Error('Stripe customer creation returned no id.');
    }

    const result = await getUsers().updateOne(
      {
        _id: toObjectId(vendorIdOf(user)),
        role: USER_ROLES.VENDOR,
        $or: [
          { stripeCustomerId: { $exists: false } },
          { stripeCustomerId: null },
          { stripeCustomerId: customerId },
        ],
      },
      { $set: { stripeCustomerId: customerId, updatedAt: now() } },
    );

    if ((result?.matchedCount ?? 0) === 0) {
      const reloaded = await getUsers().findOne({ _id: toObjectId(vendorIdOf(user)) });
      return reloaded?.stripeCustomerId ?? customerId;
    }

    return customerId;
  }

  async function createCheckout(vendorId, body) {
    validateEmptyBody(body);

    const user = await findVendorById(vendorId);
    const config = requireStripeConfig(env);

    if (isPremiumSubscription(user, now())) {
      throw ApiError.conflict('Premium is already active.', 'SUBSCRIPTION_ALREADY_ACTIVE');
    }

    const stripe = getStripe();
    let session;

    try {
      const customerId = await ensureCustomer(user, stripe);
      const successUrl = `${config.clientUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${config.clientUrl}/subscription/cancel`;

      session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: customerId,
          line_items: [{ price: config.premiumPriceId, quantity: 1 }],
          client_reference_id: vendorIdOf(user),
          metadata: { vendorId: vendorIdOf(user), purpose: PREMIUM_PURPOSE },
          subscription_data: {
            metadata: { vendorId: vendorIdOf(user), purpose: PREMIUM_PURPOSE },
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
        {
          idempotencyKey:
            `pizzahub-premium-checkout:${vendorIdOf(user)}:${config.premiumPriceId}:` +
            now().toISOString().slice(0, 10),
        },
      );
    } catch (error) {
      throw toSafePaymentError(error);
    }

    const checkoutUrl = typeof session?.url === 'string' ? session.url : null;

    if (!checkoutUrl) {
      throw new ApiError(502, 'The payment service could not create a checkout.', 'PAYMENT_UNAVAILABLE');
    }

    return { checkoutUrl, sessionId: idOf(session) };
  }

  async function getStatus(vendorId) {
    const user = await findVendorById(vendorId);

    return { subscription: serializeSubscriptionStatus(user, now()) };
  }

  async function cancelSubscription(vendorId, body) {
    validateEmptyBody(body);

    const user = await findVendorById(vendorId);
    const subscriptionId = user.stripeSubscriptionId;

    if (!subscriptionId) {
      throw ApiError.notFound('No subscription is linked to this vendor.', 'SUBSCRIPTION_NOT_FOUND');
    }

    if (user.subscriptionStatus === SUBSCRIPTION_STATUS.CANCELED) {
      return getStatus(vendorId);
    }

    if (user.subscriptionCancelAtPeriodEnd !== true) {
      const stripe = getStripe();

      try {
        await stripe.subscriptions.update(
          subscriptionId,
          { cancel_at_period_end: true },
          { idempotencyKey: `pizzahub-premium-cancel:${subscriptionId}` },
        );
      } catch (error) {
        if (isMissingStripeResource(error)) {
          await applyUserSubscriptionState({
            user,
            subscriptionId,
            customerId: null,
            state: canceledState(),
            eventCreated: Math.floor(now().getTime() / 1000),
            eventPriority: STRIPE_EVENT_PRIORITY[STRIPE_EVENT_TYPES.CUSTOMER_SUBSCRIPTION_DELETED],
            eventId: `local-cancel-${subscriptionId}`,
            eventType: STRIPE_EVENT_TYPES.CUSTOMER_SUBSCRIPTION_DELETED,
          });
          return getStatus(vendorId);
        }

        throw toSafePaymentError(error);
      }

      await getUsers().updateOne(
        { _id: toObjectId(vendorId), role: USER_ROLES.VENDOR, stripeSubscriptionId: subscriptionId },
        { $set: { subscriptionCancelAtPeriodEnd: true, updatedAt: now() } },
      );
    }

    return getStatus(vendorId);
  }

  async function handleCheckoutCompleted(event, eventCreated) {
    const session = event.data.object;

    if (session.mode !== 'subscription') {
      return { ignored: true, reason: 'NOT_SUBSCRIPTION_CHECKOUT' };
    }

    const metadataVendorId = metadataVendorIdOf(session);
    const vendorId = session.client_reference_id ?? metadataVendorId;
    const subscriptionId = idOf(session.subscription);
    const customerId = idOf(session.customer);

    if (!vendorId || !subscriptionId) {
      throw ApiError.badRequest('Checkout session is missing subscription data.', 'INVALID_STRIPE_EVENT');
    }

    const user = await resolveVendorForEvent({ vendorId, customerId, subscriptionId });
    const stripe = getStripe();
    let subscription;

    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      throw toSafePaymentError(error);
    }

    assertVendorMatchesEvent(user, {
      vendorId,
      metadataVendorId: metadataVendorId ?? metadataVendorIdOf(subscription),
      customerId: idOf(subscription?.customer) ?? customerId,
      subscriptionId,
    });

    await applyUserSubscriptionState({
      user,
      subscriptionId,
      customerId: idOf(subscription?.customer) ?? customerId,
      state: buildSubscriptionState(subscription),
      eventCreated,
      eventPriority: STRIPE_EVENT_PRIORITY[STRIPE_EVENT_TYPES.CHECKOUT_SESSION_COMPLETED],
      eventId: event.id,
      eventType: event.type,
    });

    await upsertTransaction({
      vendorId: vendorIdOf(user),
      stripeCheckoutSessionId: session.id,
      stripeSubscriptionId: subscriptionId,
      amount: Number(session.amount_total ?? 0) || 0,
      currency: String(session.currency ?? 'usd').toLowerCase(),
      paymentStatus: 'pending',
      eventCreated,
      eventId: event.id,
      eventType: event.type,
    });

    return { handled: true };
  }

  async function handleInvoice(event, eventCreated, failed) {
    const invoice = event.data.object;
    const subscriptionId = idOf(invoice.subscription);

    if (!subscriptionId) {
      return { ignored: true, reason: 'NOT_SUBSCRIPTION_INVOICE' };
    }

    const customerId = idOf(invoice.customer);
    const metadataVendorId = metadataVendorIdOf(invoice);
    const user = await resolveVendorForEvent({ vendorId: metadataVendorId, customerId, subscriptionId });

    assertVendorMatchesEvent(user, {
      vendorId: metadataVendorId,
      customerId,
      subscriptionId,
    });

    let state = failedPaymentState(user);

    if (!failed) {
      const stripe = getStripe();
      let subscription;

      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (error) {
        throw toSafePaymentError(error);
      }

      assertVendorMatchesEvent(user, {
        vendorId: metadataVendorIdOf(subscription),
        customerId: idOf(subscription?.customer),
        subscriptionId,
      });
      state = buildSubscriptionState(subscription);
    }

    await applyUserSubscriptionState({
      user,
      subscriptionId,
      customerId,
      state,
      eventCreated,
      eventPriority: STRIPE_EVENT_PRIORITY[event.type],
      eventId: event.id,
      eventType: event.type,
    });

    await upsertTransaction({
      vendorId: vendorIdOf(user),
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscriptionId,
      amount: Number((failed ? invoice.amount_due : invoice.amount_paid) ?? invoice.amount_total ?? 0) || 0,
      currency: String(invoice.currency ?? 'usd').toLowerCase(),
      paymentStatus: failed ? 'failed' : 'paid',
      eventCreated,
      eventId: event.id,
      eventType: event.type,
    });

    return { handled: true };
  }

  async function handleSubscriptionChange(event, eventCreated, deleted) {
    const subscription = event.data.object;
    const subscriptionId = idOf(subscription);

    if (!subscriptionId) {
      throw ApiError.badRequest('Subscription event is missing an id.', 'INVALID_STRIPE_EVENT');
    }

    const customerId = idOf(subscription.customer);
    const metadataVendorId = metadataVendorIdOf(subscription);
    const user = await resolveVendorForEvent({ vendorId: metadataVendorId, customerId, subscriptionId });

    assertVendorMatchesEvent(user, { vendorId: metadataVendorId, customerId, subscriptionId });

    await applyUserSubscriptionState({
      user,
      subscriptionId,
      customerId,
      state: deleted ? canceledState() : buildSubscriptionState(subscription),
      eventCreated,
      eventPriority: STRIPE_EVENT_PRIORITY[event.type],
      eventId: event.id,
      eventType: event.type,
    });

    return { handled: true };
  }

  async function processWebhookEvent(event) {
    const eventCreated = requireEvent(event);

    switch (event.type) {
      case STRIPE_EVENT_TYPES.CHECKOUT_SESSION_COMPLETED:
        return handleCheckoutCompleted(event, eventCreated);
      case STRIPE_EVENT_TYPES.INVOICE_PAID:
        return handleInvoice(event, eventCreated, false);
      case STRIPE_EVENT_TYPES.INVOICE_PAYMENT_FAILED:
        return handleInvoice(event, eventCreated, true);
      case STRIPE_EVENT_TYPES.CUSTOMER_SUBSCRIPTION_UPDATED:
        return handleSubscriptionChange(event, eventCreated, false);
      case STRIPE_EVENT_TYPES.CUSTOMER_SUBSCRIPTION_DELETED:
        return handleSubscriptionChange(event, eventCreated, true);
      default:
        return { ignored: true, reason: 'UNSUPPORTED_EVENT' };
    }
  }

  return {
    createCheckout,
    getStatus,
    cancelSubscription,
    processWebhookEvent,
    findVendorById,
  };
}
