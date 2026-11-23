import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import Stripe from 'stripe';

import { createAuthenticate } from '../middlewares/authenticate.js';
import { createErrorHandler } from '../middlewares/error.js';
import { createMenuService, FREE_MENU_ITEM_LIMIT } from '../modules/menu/menu.service.js';
import { MENU_STATUS } from '../modules/menu/menu.validator.js';
import {
  createStripeWebhookRoutes,
  createVendorSubscriptionRoutes,
} from '../modules/payment/payment.routes.js';
import { createPaymentService } from '../modules/payment/payment.service.js';

// Fake ids and credentials only. This suite never reads .env, contacts Atlas,
// calls Stripe's network API, or uploads images.
const ENV = Object.freeze({
  CLIENT_URL: 'https://client.example.test',
  STRIPE_SECRET_KEY: 'sk_test_local_only_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_local_only_secret',
  STRIPE_PREMIUM_PRICE_ID: 'price_local_only_premium',
});

const VENDOR_ID = '65b000000000000000000002';
const OTHER_VENDOR_ID = '65b000000000000000000003';
const CUSTOMER_ID = '65b000000000000000000004';
const CUSTOMER_ID_FOR_STRIPE = 'cus_local_fake_001';
const SUBSCRIPTION_ID = 'sub_local_fake_001';
const OTHER_SUBSCRIPTION_ID = 'sub_local_fake_002';
const CHECKOUT_SESSION_ID = 'cs_test_local_fake_001';
const INVOICE_ID = 'in_local_fake_001';
const BASE_EVENT_CREATED = 1_800_000_000;
const FUTURE_SECONDS = BASE_EVENT_CREATED + 2_592_000;
const FIXED_NOW = new Date(BASE_EVENT_CREATED * 1000);
const IMAGE_URL = 'https://i.ibb.co/test/pizza.png';

const TOKEN_SUBJECTS = Object.freeze({
  'vendor-token': VENDOR_ID,
  'other-vendor-token': OTHER_VENDOR_ID,
  'customer-token': CUSTOMER_ID,
});

// Deliberately wrong role claims: authorization must use MongoDB.
const TOKEN_CLAIM_ROLES = Object.freeze({
  'vendor-token': 'customer',
  'other-vendor-token': 'admin',
  'customer-token': 'vendor',
});

const sdk = new Stripe(ENV.STRIPE_SECRET_KEY);

function valuesEqual(left, right) {
  if (left instanceof ObjectIdLike || right instanceof ObjectIdLike) {
    return String(left) === String(right);
  }

  if (left && typeof left === 'object' && typeof left.toString === 'function') {
    return String(left) === String(right);
  }

  return left === right;
}

// A tiny marker used so fake ObjectIds and strings compare naturally.
function ObjectIdLike() {}

function matchesValue(expected, actual) {
  if (expected instanceof RegExp) {
    return expected.test(String(actual ?? ''));
  }

  if (!expected || typeof expected !== 'object') {
    return valuesEqual(expected, actual);
  }

  if (Object.hasOwn(expected, '$in')) {
    return expected.$in.some((candidate) => valuesEqual(candidate, actual));
  }

  if (Object.hasOwn(expected, '$ne')) {
    return !valuesEqual(expected.$ne, actual);
  }

  if (Object.hasOwn(expected, '$exists')) {
    return expected.$exists ? actual !== undefined : actual === undefined;
  }

  if (Object.hasOwn(expected, '$lt')) {
    return Number(actual) < Number(expected.$lt);
  }

  if (Object.hasOwn(expected, '$lte')) {
    return Number(actual) <= Number(expected.$lte);
  }

  return valuesEqual(expected, actual);
}

function matches(filter, item) {
  return Object.entries(filter ?? {}).every(([key, expected]) => {
    if (key === '$and') {
      return expected.every((condition) => matches(condition, item));
    }

    if (key === '$or') {
      return expected.some((condition) => matches(condition, item));
    }

    return matchesValue(expected, item?.[key]);
  });
}

function equalityFields(filter, target = {}) {
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (key === '$and' && Array.isArray(value)) {
      for (const condition of value) {
        equalityFields(condition, target);
      }
      continue;
    }

    if (key.startsWith('$')) {
      continue;
    }

    target[key] = value;
  }

  return target;
}

function applyUpdate(document, update, inserting) {
  if (inserting && update?.$setOnInsert) {
    Object.assign(document, update.$setOnInsert);
  }

  if (update?.$set) {
    Object.assign(document, update.$set);
  }

  if (update?.$unset) {
    for (const field of Object.keys(update.$unset)) {
      delete document[field];
    }
  }
}

function createFakeCollection(uniqueFields = []) {
  const state = { items: [] };

  function assertUnique(candidate, exceptIndex) {
    for (const field of uniqueFields) {
      const value = candidate[field];

      if (value === null || value === undefined) {
        continue;
      }

      const conflict = state.items.some(
        (item, index) => index !== exceptIndex && item[field] === value,
      );

      if (conflict) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
    }
  }

  return {
    state,
    async findOne(filter) {
      return state.items.find((item) => matches(filter, item)) ?? null;
    },
    async countDocuments(filter) {
      return state.items.filter((item) => matches(filter, item)).length;
    },
    async insertOne(document) {
      assertUnique(document);
      state.items.push(document);
      return { insertedId: document._id };
    },
    async updateOne(filter, update, options = {}) {
      const index = state.items.findIndex((item) => matches(filter, item));

      if (index === -1) {
        if (!options.upsert) {
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        }

        const document = equalityFields(filter);
        applyUpdate(document, update, true);
        assertUnique(document);
        state.items.push(document);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: document._id };
      }

      const candidate = { ...state.items[index] };
      applyUpdate(candidate, update, false);
      assertUnique(candidate, index);
      state.items[index] = candidate;
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },
  };
}

function seedUsers() {
  return [
    {
      _id: VENDOR_ID,
      id: VENDOR_ID,
      email: 'vendor@example.test',
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
    {
      _id: OTHER_VENDOR_ID,
      id: OTHER_VENDOR_ID,
      email: 'other-vendor@example.test',
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
    {
      _id: CUSTOMER_ID,
      id: CUSTOMER_ID,
      email: 'customer@example.test',
      role: 'customer',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
  ];
}

function subscriptionObject(overrides = {}) {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    customer: CUSTOMER_ID_FOR_STRIPE,
    status: 'active',
    cancel_at_period_end: false,
    metadata: { vendorId: VENDOR_ID, purpose: 'pizzahub_premium' },
    items: { data: [{ current_period_end: FUTURE_SECONDS }] },
    ...overrides,
  };
}

function checkoutSessionObject(overrides = {}) {
  return {
    id: CHECKOUT_SESSION_ID,
    object: 'checkout.session',
    mode: 'subscription',
    client_reference_id: VENDOR_ID,
    customer: CUSTOMER_ID_FOR_STRIPE,
    subscription: SUBSCRIPTION_ID,
    metadata: { vendorId: VENDOR_ID, purpose: 'pizzahub_premium' },
    amount_total: 900,
    currency: 'usd',
    ...overrides,
  };
}

function invoiceObject(overrides = {}) {
  return {
    id: INVOICE_ID,
    object: 'invoice',
    customer: CUSTOMER_ID_FOR_STRIPE,
    subscription: SUBSCRIPTION_ID,
    subscription_details: { metadata: { vendorId: VENDOR_ID } },
    amount_paid: 900,
    amount_due: 900,
    currency: 'usd',
    ...overrides,
  };
}

let eventCounter = 0;

function stripeEvent(type, object, overrides = {}) {
  eventCounter += 1;
  return {
    id: `evt_local_fake_${eventCounter}`,
    type,
    created: BASE_EVENT_CREATED,
    data: { object },
    ...overrides,
  };
}

const fakeStripeState = {
  calls: [],
  subscriptions: new Map(),
  checkoutFailure: null,
  retrieveFailure: null,
};

const fakeStripe = {
  customers: {
    async create(params, options) {
      fakeStripeState.calls.push({ api: 'customers.create', params, options });
      return { id: CUSTOMER_ID_FOR_STRIPE, object: 'customer' };
    },
  },
  checkout: {
    sessions: {
      async create(params, options) {
        fakeStripeState.calls.push({ api: 'checkout.sessions.create', params, options });

        if (fakeStripeState.checkoutFailure) {
          throw fakeStripeState.checkoutFailure;
        }

        return {
          id: CHECKOUT_SESSION_ID,
          url: 'https://checkout.example.test/session',
        };
      },
    },
  },
  subscriptions: {
    async retrieve(id) {
      fakeStripeState.calls.push({ api: 'subscriptions.retrieve', id });

      if (fakeStripeState.retrieveFailure) {
        throw fakeStripeState.retrieveFailure;
      }

      return fakeStripeState.subscriptions.get(id) ?? subscriptionObject({ id });
    },
    async update(id, params, options) {
      fakeStripeState.calls.push({ api: 'subscriptions.update', id, params, options });
      const current = fakeStripeState.subscriptions.get(id) ?? subscriptionObject({ id });
      const updated = { ...current, ...params };
      fakeStripeState.subscriptions.set(id, updated);
      return updated;
    },
  },
  webhooks: sdk.webhooks,
};

function resetFakeStripe() {
  fakeStripeState.calls.length = 0;
  fakeStripeState.subscriptions.clear();
  fakeStripeState.subscriptions.set(SUBSCRIPTION_ID, subscriptionObject());
  fakeStripeState.checkoutFailure = null;
  fakeStripeState.retrieveFailure = null;
}

let server;
let baseUrl;
let fakeUsers;
let fakeTransactions;
let fakeMenu;
let paymentService;
let menuService;
const originalConsoleError = console.error;

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function apiRequest(path, { method = 'GET', token = 'vendor-token', body } = {}) {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  return request(`/api/vendor/subscription${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function postWebhook(event, { secret = ENV.STRIPE_WEBHOOK_SECRET, signature, payload } = {}) {
  const body = payload ?? JSON.stringify(event);
  const header =
    signature ??
    sdk.webhooks.generateTestHeaderString({
      payload: body,
      secret,
    });

  return request('/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': header,
    },
    body,
  });
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  return body;
}

function validMenuData(overrides = {}) {
  return {
    itemName: 'Margherita',
    category: 'Classic Pizzas',
    description: 'Tomato, mozzarella and basil.',
    price: 12.5,
    location: 'Downtown',
    ...overrides,
  };
}

before(async () => {
  console.error = () => {};

  fakeUsers = createFakeCollection();
  fakeTransactions = createFakeCollection(['stripeInvoiceId', 'stripeSessionId']);
  fakeMenu = createFakeCollection();

  paymentService = createPaymentService({
    env: ENV,
    usersCollection: () => fakeUsers,
    transactionsCollection: () => fakeTransactions,
    stripe: fakeStripe,
    now: () => FIXED_NOW,
  });
  menuService = createMenuService({ collection: () => fakeMenu, now: () => FIXED_NOW });

  const authenticate = createAuthenticate(
    { BETTER_AUTH_URL: 'https://auth.example.test' },
    {
      verifyToken: async (token) => {
        const subject = TOKEN_SUBJECTS[token];

        if (!subject) {
          throw new Error('invalid test token');
        }

        return { sub: subject, role: TOKEN_CLAIM_ROLES[token] };
      },
      findUser: async (userId) =>
        fakeUsers.state.items.find(
          (item) => String(item._id) === String(userId) || item.id === userId,
        ) ?? null,
    },
  );

  const app = express();

  // Same order as production: webhook raw body before express.json().
  app.use(
    '/api/webhooks/stripe',
    createStripeWebhookRoutes(ENV, { paymentService, stripe: fakeStripe }),
  );
  app.use(express.json());
  app.use(
    '/api/vendor/subscription',
    createVendorSubscriptionRoutes(ENV, { authenticate, paymentService }),
  );
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  fakeUsers.state.items = seedUsers();
  fakeTransactions.state.items = [];
  fakeMenu.state.items = [];
  resetFakeStripe();
  eventCounter = 0;
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('subscription endpoints require authentication and the vendor database role', async () => {
  const cases = [
    { method: 'POST', path: '/checkout', body: {} },
    { method: 'GET', path: '/' },
    { method: 'POST', path: '/cancel', body: {} },
  ];

  for (const endpoint of cases) {
    await expectError(await apiRequest(endpoint.path, { ...endpoint, token: null }), 401, 'UNAUTHORIZED');
    await expectError(
      await apiRequest(endpoint.path, { ...endpoint, token: 'customer-token' }),
      403,
      'FORBIDDEN',
    );
  }
});

test('checkout uses only the server price, trusted client URL and authenticated vendor', async () => {
  const response = await apiRequest('/checkout', { method: 'POST', body: {} });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.checkoutUrl, 'https://checkout.example.test/session');
  assert.equal(body.sessionId, CHECKOUT_SESSION_ID);

  const calls = fakeStripeState.calls;
  const createCall = calls.find((call) => call.api === 'checkout.sessions.create');

  assert.equal(createCall.params.mode, 'subscription');
  assert.deepEqual(createCall.params.line_items, [
    { price: ENV.STRIPE_PREMIUM_PRICE_ID, quantity: 1 },
  ]);
  assert.equal(createCall.params.customer, CUSTOMER_ID_FOR_STRIPE);
  assert.equal(createCall.params.client_reference_id, VENDOR_ID);
  assert.equal(createCall.params.metadata.vendorId, VENDOR_ID);
  assert.equal(createCall.params.subscription_data.metadata.vendorId, VENDOR_ID);
  assert.equal(
    createCall.params.success_url,
    'https://client.example.test/subscription/success?session_id={CHECKOUT_SESSION_ID}',
  );
  assert.equal(createCall.params.cancel_url, 'https://client.example.test/subscription/cancel');
  assert.doesNotMatch(JSON.stringify(createCall), /sk_test_local_only_key/);

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);

  assert.equal(user.stripeCustomerId, CUSTOMER_ID_FOR_STRIPE);
});

test('checkout rejects client-supplied price or identity fields', async () => {
  for (const body of [{ priceId: 'price_evil' }, { amount: 1 }, { vendorId: OTHER_VENDOR_ID }]) {
    await expectError(
      await apiRequest('/checkout', { method: 'POST', body }),
      400,
      'FORBIDDEN_FIELD',
    );
  }
});

test('checkout rejects an already active Premium vendor', async () => {
  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);
  user.subscriptionPlan = 'premium';
  user.subscriptionStatus = 'active';
  user.subscriptionExpiresAt = new Date(FIXED_NOW.getTime() + 1000);

  await expectError(
    await apiRequest('/checkout', { method: 'POST', body: {} }),
    409,
    'SUBSCRIPTION_ALREADY_ACTIVE',
  );
});

test('checkout reports an unknown vendor without leaking provider details', async () => {
  await assert.rejects(
    paymentService.createCheckout('65b000000000000000000099', {}),
    (error) => error?.code === 'VENDOR_NOT_FOUND',
  );
});

test('raw webhook body and real signature verification are enforced', async () => {
  const event = stripeEvent('ping', { id: 'evt_ping' });
  const valid = await postWebhook(event);

  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { received: true, ignored: true, reason: 'UNSUPPORTED_EVENT' });

  await expectError(
    await postWebhook(event, { signature: 't=1,v1=deadbeef' }),
    400,
    'INVALID_STRIPE_SIGNATURE',
  );

  const missingSignature = await request('/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  await expectError(missingSignature, 400, 'INVALID_STRIPE_SIGNATURE');

  // Signature over compact bytes must fail when a parser re-serializes the JSON.
  const compact = JSON.stringify(event);
  const pretty = JSON.stringify(event, null, 2);
  const compactSignature = sdk.webhooks.generateTestHeaderString({
    payload: compact,
    secret: ENV.STRIPE_WEBHOOK_SECRET,
  });

  await expectError(
    await postWebhook(event, { payload: pretty, signature: compactSignature }),
    400,
    'INVALID_STRIPE_SIGNATURE',
  );
});

test('checkout.session.completed activates Premium once and records one checkout transaction', async () => {
  const event = stripeEvent('checkout.session.completed', checkoutSessionObject());

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await postWebhook(event);
    assert.equal(response.status, 200);
  }

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);

  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.subscriptionStatus, 'active');
  assert.equal(user.stripeSubscriptionId, SUBSCRIPTION_ID);
  assert.equal(user.subscriptionExpiresAt.toISOString(), new Date(FUTURE_SECONDS * 1000).toISOString());
  assert.equal(fakeTransactions.state.items.length, 1);
  assert.equal(fakeTransactions.state.items[0].paymentStatus, 'pending');
  assert.equal(fakeTransactions.state.items[0].stripeSessionId, CHECKOUT_SESSION_ID);
});

test('webhook metadata mismatch never changes user or transaction state', async () => {
  const event = stripeEvent(
    'checkout.session.completed',
    checkoutSessionObject({ metadata: { vendorId: OTHER_VENDOR_ID } }),
  );

  await expectError(await postWebhook(event), 400, 'STRIPE_VENDOR_MISMATCH');
  assert.equal(fakeUsers.state.items.find((item) => item._id === VENDOR_ID).subscriptionPlan, 'free');
  assert.equal(fakeTransactions.state.items.length, 0);
});

test('webhook unknown vendor is rejected safely', async () => {
  const event = stripeEvent(
    'checkout.session.completed',
    checkoutSessionObject({
      client_reference_id: '65b000000000000000000099',
      metadata: { vendorId: '65b000000000000000000099' },
    }),
  );

  await expectError(await postWebhook(event), 400, 'STRIPE_VENDOR_NOT_FOUND');
  assert.equal(fakeTransactions.state.items.length, 0);
});

test('invoice.paid activates Premium and stores only payment metadata', async () => {
  const event = stripeEvent('invoice.paid', invoiceObject());

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await postWebhook(event)).status, 200);
  }

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);
  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.subscriptionStatus, 'active');

  assert.equal(fakeTransactions.state.items.length, 1);
  const transaction = fakeTransactions.state.items[0];

  assert.equal(transaction.vendorId, VENDOR_ID);
  assert.equal(transaction.stripeInvoiceId, INVOICE_ID);
  assert.equal(transaction.stripeSubscriptionId, SUBSCRIPTION_ID);
  assert.equal(transaction.amount, 900);
  assert.equal(transaction.currency, 'usd');
  assert.equal(transaction.paymentStatus, 'paid');
  assert.equal(transaction.status, 'paid');
  assert.ok(transaction.createdAt instanceof Date);
  assert.ok(transaction.updatedAt instanceof Date);
  assert.doesNotMatch(JSON.stringify(transaction), /card|cvc|number/i);
});

test('invoice.payment_failed records failure and removes Premium access', async () => {
  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);
  user.subscriptionPlan = 'premium';
  user.subscriptionStatus = 'active';
  user.subscriptionExpiresAt = new Date(FIXED_NOW.getTime() + 1000);

  const event = stripeEvent('invoice.payment_failed', invoiceObject());

  assert.equal((await postWebhook(event)).status, 200);
  assert.equal((await postWebhook(event)).status, 200);

  const updatedUser = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);
  assert.equal(updatedUser.subscriptionStatus, 'past_due');
  assert.equal(fakeTransactions.state.items.length, 1);
  assert.equal(fakeTransactions.state.items[0].paymentStatus, 'failed');
});

test('out-of-order older events cannot overwrite newer subscription state', async () => {
  const deleted = stripeEvent(
    'customer.subscription.deleted',
    subscriptionObject({ status: 'canceled', cancel_at_period_end: false }),
    { created: BASE_EVENT_CREATED + 100 },
  );
  assert.equal((await postWebhook(deleted)).status, 200);

  const oldPaid = stripeEvent('invoice.paid', invoiceObject(), {
    created: BASE_EVENT_CREATED,
  });
  assert.equal((await postWebhook(oldPaid)).status, 200);

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);

  assert.equal(user.subscriptionPlan, 'free');
  assert.equal(user.subscriptionStatus, 'canceled');
  assert.equal(user.subscriptionLastStripeEventCreated, BASE_EVENT_CREATED + 100);
});

test('subscription.updated honors cancellation at period end while Premium remains active', async () => {
  const event = stripeEvent(
    'customer.subscription.updated',
    subscriptionObject({ cancel_at_period_end: true }),
  );

  assert.equal((await postWebhook(event)).status, 200);

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);

  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.subscriptionStatus, 'active');
  assert.equal(user.subscriptionCancelAtPeriodEnd, true);
});

test('subscription.deleted revokes Premium and stores a future expiry rule safely', async () => {
  await postWebhook(stripeEvent('checkout.session.completed', checkoutSessionObject()));

  const deleted = stripeEvent(
    'customer.subscription.deleted',
    subscriptionObject({ status: 'canceled' }),
    { created: BASE_EVENT_CREATED + 1 },
  );
  assert.equal((await postWebhook(deleted)).status, 200);

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);

  assert.equal(user.subscriptionPlan, 'free');
  assert.equal(user.subscriptionStatus, 'canceled');
  assert.equal(user.subscriptionExpiresAt, null);
  assert.equal(user.subscriptionCancelAtPeriodEnd, false);
});

test('cancel endpoint uses stored subscription ids and is idempotent', async () => {
  await postWebhook(stripeEvent('checkout.session.completed', checkoutSessionObject()));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await apiRequest('/cancel', { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.subscription.plan, 'premium');
    assert.equal(body.subscription.status, 'active');
    assert.equal(body.subscription.cancelAtPeriodEnd, true);
  }

  const updateCalls = fakeStripeState.calls.filter((call) => call.api === 'subscriptions.update');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, SUBSCRIPTION_ID);
  assert.deepEqual(updateCalls[0].params, { cancel_at_period_end: true });
  assert.ok(updateCalls[0].options.idempotencyKey.includes(SUBSCRIPTION_ID));
});

test('cancel rejects a vendor with no linked subscription', async () => {
  const statusResponse = await apiRequest('/');
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).subscription.canCancel, false);

  await expectError(
    await apiRequest('/cancel', { method: 'POST', body: {} }),
    404,
    'SUBSCRIPTION_NOT_FOUND',
  );
});

test('status endpoint returns only safe subscription fields', async () => {
  await postWebhook(stripeEvent('checkout.session.completed', checkoutSessionObject()));

  const response = await apiRequest('/');
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['subscription']);
  assert.deepEqual(Object.keys(body.subscription).sort(), [
    'canCancel',
    'cancelAtPeriodEnd',
    'expiresAt',
    'isPremium',
    'plan',
    'status',
  ]);
  assert.equal(body.subscription.canCancel, true);
  assert.equal(body.subscription.isPremium, true);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SUBSCRIPTION_ID));
  assert.doesNotMatch(JSON.stringify(body), new RegExp(CUSTOMER_ID_FOR_STRIPE));
});

test('expired Premium no longer grants menu slots; active Premium does', async () => {
  for (let index = 0; index < FREE_MENU_ITEM_LIMIT; index += 1) {
    await fakeMenu.insertOne({
      _id: `65c00000000000000000000${index + 1}`,
      vendorId: VENDOR_ID,
      status: MENU_STATUS.PENDING,
      isAvailable: true,
    });
  }

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);
  await assert.rejects(
    menuService.create(VENDOR_ID, validMenuData(), [IMAGE_URL], user),
    (error) => error?.code === 'MENU_ITEM_LIMIT_REACHED',
  );

  user.subscriptionPlan = 'premium';
  user.subscriptionStatus = 'active';
  user.subscriptionExpiresAt = new Date(FIXED_NOW.getTime() - 1000);
  await assert.rejects(
    menuService.create(VENDOR_ID, validMenuData(), [IMAGE_URL], user),
    (error) => error?.code === 'MENU_ITEM_LIMIT_REACHED',
  );

  user.subscriptionExpiresAt = new Date(FIXED_NOW.getTime() + 1000);
  const created = await menuService.create(VENDOR_ID, validMenuData(), [IMAGE_URL], user);
  assert.equal(created.itemName, 'Margherita');
  assert.equal(fakeMenu.state.items.length, FREE_MENU_ITEM_LIMIT + 1);
});

test('Stripe and configuration failures are sanitized for clients', async () => {
  fakeStripeState.checkoutFailure = Object.assign(new Error('raw sk_live_secret leaked'), {
    code: 'card_error',
    rawMessage: 'raw sk_live_secret leaked',
  });

  const response = await apiRequest('/checkout', { method: 'POST', body: {} });
  const body = await expectError(response, 502, 'PAYMENT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(body), /sk_live_secret|rawMessage|card_error/i);

  const unconfigured = createPaymentService({
    env: {},
    stripe: fakeStripe,
    usersCollection: () => fakeUsers,
    transactionsCollection: () => fakeTransactions,
  });
  await assert.rejects(
    unconfigured.createCheckout(VENDOR_ID, {}),
    (error) => error?.code === 'PAYMENT_UNAVAILABLE' && error?.statusCode === 503,
  );
});

test('missing Stripe subscription data and invalid events are rejected safely', async () => {
  const missingSubscription = stripeEvent(
    'checkout.session.completed',
    checkoutSessionObject({ subscription: null }),
  );
  await expectError(await postWebhook(missingSubscription), 400, 'INVALID_STRIPE_EVENT');

  const malformed = await request('/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': sdk.webhooks.generateTestHeaderString({
        payload: '{"id":"evt_bad"}',
        secret: ENV.STRIPE_WEBHOOK_SECRET,
      }),
    },
    body: '{"id":"evt_bad"}',
  });
  await expectError(malformed, 400, 'INVALID_STRIPE_EVENT');
});

test('a newer paid invoice cannot be downgraded by a stale failed event', async () => {
  const paid = stripeEvent('invoice.paid', invoiceObject(), { created: BASE_EVENT_CREATED + 10 });
  assert.equal((await postWebhook(paid)).status, 200);

  const failed = stripeEvent(
    'invoice.payment_failed',
    invoiceObject({ id: 'in_local_fake_002' }),
    { created: BASE_EVENT_CREATED },
  );
  assert.equal((await postWebhook(failed)).status, 200);

  const user = fakeUsers.state.items.find((item) => item._id === VENDOR_ID);
  assert.equal(user.subscriptionStatus, 'active');

  const paidTransaction = fakeTransactions.state.items.find(
    (item) => item.stripeInvoiceId === INVOICE_ID,
  );
  assert.equal(paidTransaction.paymentStatus, 'paid');

  const failedTransaction = fakeTransactions.state.items.find(
    (item) => item.stripeInvoiceId === 'in_local_fake_002',
  );
  assert.equal(failedTransaction.paymentStatus, 'failed');
});
