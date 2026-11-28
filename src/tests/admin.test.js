import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { ObjectId } from 'mongodb';
import Stripe from 'stripe';

import {
  buildUserIdFilter,
  createAuthenticate,
  findUserById,
} from '../middlewares/authenticate.js';
import { findActiveTestSession } from './auth-session-helper.js';
import { createErrorHandler } from '../middlewares/error.js';
import { notFound } from '../middlewares/not-found.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import { createAdminService } from '../modules/admin/admin.service.js';
import { createAdminMenuRoutes } from '../modules/admin/admin-menu.routes.js';
import { MENU_STATUS } from '../modules/menu/menu.validator.js';
import {
  createCustomerOrderRoutes,
  createVendorOrderRoutes,
} from '../modules/order/order.routes.js';
import {
  createStripeWebhookRoutes,
  createVendorSubscriptionRoutes,
} from '../modules/payment/payment.routes.js';
import { createPaymentService } from '../modules/payment/payment.service.js';
import { createUserRoutes } from '../modules/user/user.routes.js';
import { createUserService } from '../modules/user/user.service.js';

// Fake values only. This suite never reads .env, contacts Atlas, calls Stripe's
// network API, uploads images, or makes any external request.
const STRIPE_ENV = Object.freeze({
  CLIENT_URL: 'https://client.example.test',
  STRIPE_SECRET_KEY: 'sk_test_local_only_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_local_only_secret',
  STRIPE_PREMIUM_PRICE_ID: 'price_local_only_premium',
});

const ADMIN_ID = '65b000000000000000000001';
const SECOND_ADMIN_ID = '65b000000000000000000002';
const VENDOR_ID = '65b000000000000000000003';
const CUSTOMER_ID = '65b000000000000000000004';
const OTHER_VENDOR_ID = '65b000000000000000000005';
const CUSTOMER_TWO_ID = '65b000000000000000000006';
const MISSING_ID = '65b000000000000000000099';

const ITEM_ID = '65c000000000000000000001';
const PENDING_ITEM_ID = '65c000000000000000000002';
const REJECTED_ITEM_ID = '65c000000000000000000003';

const TRANSACTION_ID = '65d000000000000000000001';
const SECOND_TRANSACTION_ID = '65d000000000000000000002';
const THIRD_TRANSACTION_ID = '65d000000000000000000003';

const SUBSCRIPTION_ID = 'sub_local_only_001';
const FIXED_NOW = new Date('2026-01-10T00:00:00.000Z');
const FUTURE_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000) + 86_400;

const TOKEN_SUBJECTS = Object.freeze({
  'admin-token': ADMIN_ID,
  'second-admin-token': SECOND_ADMIN_ID,
  'vendor-token': VENDOR_ID,
  'customer-token': CUSTOMER_ID,
  'other-vendor-token': OTHER_VENDOR_ID,
});

// Deliberately wrong role claims: authorization must use MongoDB.
const TOKEN_CLAIM_ROLES = Object.freeze({
  'admin-token': 'customer',
  'second-admin-token': 'vendor',
  'vendor-token': 'admin',
  'customer-token': 'vendor',
  'other-vendor-token': 'customer',
});

const sdk = new Stripe(STRIPE_ENV.STRIPE_SECRET_KEY);

function valuesEqual(left, right) {
  if (left instanceof ObjectId || right instanceof ObjectId) {
    return String(left) === String(right);
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return left === right;
}

function matchesValue(expected, actual) {
  if (expected instanceof RegExp) {
    return expected.test(String(actual ?? ''));
  }

  if (
    expected &&
    typeof expected === 'object' &&
    !(expected instanceof Date) &&
    !(expected instanceof ObjectId)
  ) {
    let foundOperator = false;
    let result = true;

    for (const [operator, operand] of Object.entries(expected)) {
      if (operator === '$options') {
        continue;
      }

      foundOperator = true;

      switch (operator) {
        case '$regex': {
          const source = typeof operand === 'string' ? operand : operand.source;
          const flags = expected.$options ?? operand.flags ?? '';

          result &&= new RegExp(source, flags).test(String(actual ?? ''));
          break;
        }
        case '$in':
          result &&= operand.some((candidate) => valuesEqual(candidate, actual));
          break;
        case '$ne':
          result &&= !valuesEqual(operand, actual);
          break;
        case '$exists':
          result &&= operand ? actual !== undefined : actual === undefined;
          break;
        case '$lt':
          result &&= Number(actual) < Number(operand);
          break;
        case '$lte':
          result &&= Number(actual) <= Number(operand);
          break;
        case '$gt':
          result &&= Number(actual) > Number(operand);
          break;
        case '$gte':
          result &&= Number(actual) >= Number(operand);
          break;
        default:
          result &&= valuesEqual(operand, actual?.[operator]);
      }
    }

    if (foundOperator) {
      return result;
    }
  }

  return valuesEqual(expected, actual);
}

function matches(filter, item) {
  return Object.entries(filter ?? {}).every(([key, expected]) => {
    if (key === '$or') {
      return expected.some((condition) => matches(condition, item));
    }

    if (key === '$and') {
      return expected.every((condition) => matches(condition, item));
    }

    return matchesValue(expected, item?.[key]);
  });
}

function compareValues(left, right) {
  if (left instanceof Date || right instanceof Date) {
    return Number(left ?? 0) - Number(right ?? 0);
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  return String(left ?? '').localeCompare(String(right ?? ''));
}

function applyProjection(item, projection) {
  if (!projection) {
    return item;
  }

  const isInclusion = Object.entries(projection).some(
    ([field, value]) => field !== '_id' && value === 1,
  );

  if (!isInclusion) {
    const result = { ...item };

    for (const [field, value] of Object.entries(projection)) {
      if (value === 0) {
        delete result[field];
      }
    }

    return result;
  }

  const result = {};

  for (const [field, value] of Object.entries(projection)) {
    if (value === 1 && Object.hasOwn(item, field)) {
      result[field] = item[field];
    }
  }

  return result;
}

function createFakeCollection() {
  const state = { items: [], calls: [] };

  function record(method, details) {
    state.calls.push({ method, ...details });
  }

  function assertUnique(candidate, exceptIndex) {
    for (const field of ['stripeInvoiceId', 'stripeSessionId']) {
      const value = candidate[field];

      if (value === null || value === undefined) {
        continue;
      }

      if (state.items.some((item, index) => index !== exceptIndex && item[field] === value)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
    }
  }

  return {
    state,

    async findOne(filter, options = {}) {
      record('findOne', { filter, options });

      const found = state.items.find((item) => matches(filter, item)) ?? null;

      return found ? applyProjection(found, options.projection) : null;
    },

    async countDocuments(filter) {
      record('countDocuments', { filter });
      return state.items.filter((item) => matches(filter, item)).length;
    },

    find(filter) {
      record('find', { filter });

      let projection = null;
      let sortSpec = null;
      let skipCount = 0;
      let limitCount = Infinity;

      const cursor = {
        project(spec) {
          projection = spec;
          record('project', { projection: spec });
          return cursor;
        },
        sort(spec) {
          sortSpec = spec;
          record('sort', { sort: spec });
          return cursor;
        },
        skip(count) {
          skipCount = count;
          record('skip', { skip: count });
          return cursor;
        },
        limit(count) {
          limitCount = count;
          record('limit', { limit: count });
          return cursor;
        },
        async toArray() {
          const selected = state.items.filter((item) => matches(filter, item));

          if (sortSpec) {
            selected.sort((left, right) => {
              for (const [field, direction] of Object.entries(sortSpec)) {
                const comparison = compareValues(left[field], right[field]);

                if (comparison !== 0) {
                  return comparison * direction;
                }
              }

              return 0;
            });
          }

          return selected
            .slice(skipCount, skipCount + limitCount)
            .map((item) => applyProjection(item, projection));
        },
      };

      return cursor;
    },

    async insertOne(document) {
      record('insertOne', { document });
      assertUnique(document);
      state.items.push(document);
      return { insertedId: document._id };
    },

    async updateOne(filter, update, options = {}) {
      record('updateOne', { filter, update, options });

      const index = state.items.findIndex((item) => matches(filter, item));

      if (index === -1) {
        if (!options.upsert) {
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        }

        const document = {};

        for (const [key, value] of Object.entries(filter)) {
          if (!key.startsWith('$')) {
            document[key] = value;
          }
        }

        Object.assign(document, update.$setOnInsert ?? {}, update.$set ?? {});
        assertUnique(document);
        state.items.push(document);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }

      const candidate = { ...state.items[index] };

      Object.assign(candidate, update.$set ?? {});

      for (const field of Object.keys(update.$unset ?? {})) {
        delete candidate[field];
      }

      assertUnique(candidate, index);
      state.items[index] = candidate;
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },

    async deleteOne(filter) {
      record('deleteOne', { filter });

      const index = state.items.findIndex((item) => matches(filter, item));

      if (index === -1) {
        return { deletedCount: 0 };
      }

      state.items.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

function seedUsers() {
  const base = {
    image: null,
    isBlocked: false,
    subscriptionPlan: 'free',
    subscriptionStatus: 'inactive',
    subscriptionExpiresAt: null,
    passwordHash: 'secret-hash-must-not-leak',
    resetToken: 'secret-reset-must-not-leak',
    sessionToken: 'secret-session-must-not-leak',
    privateNote: 'internal only',
  };

  return [
    {
      ...base,
      _id: new ObjectId(ADMIN_ID),
      name: 'Primary Admin',
      email: 'primary.admin@example.test',
      role: 'admin',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
    {
      ...base,
      _id: new ObjectId(SECOND_ADMIN_ID),
      name: 'Second Admin',
      email: 'second.admin@example.test',
      role: 'admin',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
    {
      ...base,
      _id: new ObjectId(VENDOR_ID),
      name: 'Vendor One',
      email: 'vendor.one@example.test',
      role: 'vendor',
      businessName: 'Vendor One Pizzeria',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
    {
      ...base,
      _id: new ObjectId(CUSTOMER_ID),
      name: 'Customer One',
      email: 'customer.one@example.test',
      role: 'customer',
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
    {
      ...base,
      _id: new ObjectId(OTHER_VENDOR_ID),
      name: 'Other Vendor',
      email: 'other.vendor@example.test',
      role: 'vendor',
      businessName: 'Other Pizzeria',
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
    {
      ...base,
      _id: new ObjectId(CUSTOMER_TWO_ID),
      name: 'Customer Two',
      email: 'customer.two@example.test',
      role: 'customer',
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
  ];
}

function seedMenu() {
  const base = {
    vendorId: VENDOR_ID,
    itemName: 'Test Pizza',
    category: 'Classic Pizzas',
    description: 'A controlled test item.',
    price: 12.5,
    location: 'Downtown',
    images: ['https://i.ibb.co/test/pizza.png'],
    isAvailable: true,
    updatedAt: FIXED_NOW,
  };

  return [
    {
      ...base,
      _id: new ObjectId(ITEM_ID),
      status: MENU_STATUS.APPROVED,
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    },
    {
      ...base,
      _id: new ObjectId(PENDING_ITEM_ID),
      vendorId: OTHER_VENDOR_ID,
      status: MENU_STATUS.PENDING,
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
    },
    {
      ...base,
      _id: new ObjectId(REJECTED_ITEM_ID),
      status: MENU_STATUS.REJECTED,
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
    },
  ];
}

function seedTransactions() {
  return [
    {
      _id: new ObjectId(TRANSACTION_ID),
      vendorId: VENDOR_ID,
      stripeInvoiceId: 'in_local_only_001',
      stripeSubscriptionId: SUBSCRIPTION_ID,
      amount: 900,
      currency: 'usd',
      paymentStatus: 'paid',
      status: 'paid',
      eventType: 'invoice.paid',
      stripeEventId: 'evt_local_only_001',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
      cardNumber: '4111111111111111',
      cvc: '123',
    },
    {
      _id: new ObjectId(SECOND_TRANSACTION_ID),
      vendorId: OTHER_VENDOR_ID,
      stripeSessionId: 'cs_test_local_only_001',
      amount: 900,
      currency: 'usd',
      paymentStatus: 'pending',
      status: 'pending',
      eventType: 'checkout.session.completed',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
      cardNumber: '4111111111111111',
      cvc: '456',
    },
    {
      _id: new ObjectId(THIRD_TRANSACTION_ID),
      vendorId: VENDOR_ID,
      stripeInvoiceId: 'in_local_only_002',
      amount: 900,
      currency: 'usd',
      paymentStatus: 'failed',
      status: 'failed',
      eventType: 'invoice.payment_failed',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
      cardNumber: '4111111111111111',
      cvc: '789',
    },
  ];
}

function subscriptionObject() {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    customer: 'cus_local_only_001',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { vendorId: VENDOR_ID, purpose: 'pizzahub_premium' },
    items: { data: [{ current_period_end: FUTURE_SECONDS }] },
  };
}

const fakeStripeState = { calls: [] };

const fakeStripe = {
  webhooks: sdk.webhooks,
  customers: {
    async create() {
      fakeStripeState.calls.push('customers.create');
      return { id: 'cus_local_only_001' };
    },
  },
  checkout: {
    sessions: {
      async create() {
        fakeStripeState.calls.push('checkout.sessions.create');
        return { id: 'cs_test_local_only_001', url: 'https://checkout.example.test/session' };
      },
    },
  },
  subscriptions: {
    async retrieve(id) {
      fakeStripeState.calls.push(`subscriptions.retrieve:${id}`);
      return subscriptionObject();
    },
    async update(id, params) {
      fakeStripeState.calls.push(`subscriptions.update:${id}`);
      return { ...subscriptionObject(), ...params };
    },
  },
};

let server;
let baseUrl;
let fakeUsers;
let fakeMenu;
let fakeTransactions;
let fakeOrders;
let adminService;
let paymentService;
const originalConsoleError = console.error;

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function apiRequest(path, { method = 'GET', token = 'admin-token', body } = {}) {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  return request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  return body;
}

async function postWebhook(event) {
  const payload = JSON.stringify(event);
  const signature = sdk.webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_ENV.STRIPE_WEBHOOK_SECRET,
  });

  return request('/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    body: payload,
  });
}

before(async () => {
  console.error = () => {};

  fakeUsers = createFakeCollection();
  fakeMenu = createFakeCollection();
  fakeTransactions = createFakeCollection();
  fakeOrders = { items: [] };

  adminService = createAdminService({
    usersCollection: () => fakeUsers,
    menuCollection: () => fakeMenu,
    transactionsCollection: () => fakeTransactions,
    now: () => FIXED_NOW,
  });
  paymentService = createPaymentService({
    env: STRIPE_ENV,
    usersCollection: () => fakeUsers,
    transactionsCollection: () => fakeTransactions,
    stripe: fakeStripe,
    now: () => FIXED_NOW,
  });

  const authenticate = createAuthenticate(
    {},
    {
      verifyToken: async (token) => {
        const subject = TOKEN_SUBJECTS[token];

        if (!subject) {
          throw new Error('invalid test token');
        }

        return { sub: subject, sid: subject, role: TOKEN_CLAIM_ROLES[token] };
      },
      findUser: async (userId) => fakeUsers.findOne(buildUserIdFilter(userId)),
      findSession: findActiveTestSession,
    },
  );

  const userService = createUserService({
    collection: () => fakeUsers,
    findUserById,
  });

  const app = express();

  app.use('/api/webhooks/stripe', createStripeWebhookRoutes(STRIPE_ENV, { paymentService, stripe: fakeStripe }));
  app.use(express.json());
  app.use('/api/users', createUserRoutes({}, { authenticate, userService }));
  app.use(
    '/api/admin/menu',
    createAdminMenuRoutes({}, {
      authenticate,
      serviceDependencies: {
        collection: () => fakeMenu,
        usersCollection: () => fakeUsers,
        now: () => FIXED_NOW,
      },
    }),
  );
  app.use('/api/admin', createAdminRoutes({}, { authenticate, adminService }));
  app.use('/api/orders', createCustomerOrderRoutes({}, { authenticate }));
  app.use('/api/vendor/orders', createVendorOrderRoutes({}, { authenticate }));
  app.use(
    '/api/vendor/subscription',
    createVendorSubscriptionRoutes(STRIPE_ENV, { authenticate, paymentService }),
  );
  app.use(notFound);
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  fakeUsers.state.items = seedUsers();
  fakeUsers.state.calls = [];
  fakeMenu.state.items = seedMenu();
  fakeMenu.state.calls = [];
  fakeTransactions.state.items = seedTransactions();
  fakeTransactions.state.calls = [];
  fakeOrders.items = [];
  fakeStripeState.calls = [];
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('admin dashboard returns all six counts and enforces roles from MongoDB', async () => {
  const response = await apiRequest('/api/admin/dashboard/stats');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    stats: {
      totalUsers: 6,
      totalVendors: 2,
      totalCustomers: 2,
      totalMenuItems: 3,
      pendingMenuItems: 1,
      totalTransactions: 3,
    },
  });

  await expectError(
    await apiRequest('/api/admin/dashboard/stats', { token: null }),
    401,
    'UNAUTHORIZED',
  );

  // The vendor token deliberately claims role=admin; MongoDB wins.
  await expectError(
    await apiRequest('/api/admin/dashboard/stats', { token: 'vendor-token' }),
    403,
    'FORBIDDEN',
  );
  await expectError(
    await apiRequest('/api/admin/dashboard/stats', { token: 'customer-token' }),
    403,
    'FORBIDDEN',
  );
});

test('admin dashboard returns zero counts for empty business collections', async () => {
  // Keep only the authenticated Admin: the caller must still resolve as a user.
  fakeUsers.state.items = fakeUsers.state.items.filter(
    (user) => user._id.toString() === ADMIN_ID,
  );
  fakeMenu.state.items = [];
  fakeTransactions.state.items = [];

  const response = await apiRequest('/api/admin/dashboard/stats');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    stats: {
      totalUsers: 1,
      totalVendors: 0,
      totalCustomers: 0,
      totalMenuItems: 0,
      pendingMenuItems: 0,
      totalTransactions: 0,
    },
  });
});

test('admin user listing supports escaped search, role filtering and pagination', async () => {
  const response = await apiRequest('/api/admin/users?search=vendor&role=vendor&page=1&limit=1');

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.pagination.totalItems, 2);
  assert.equal(body.pagination.page, 1);
  assert.equal(body.pagination.limit, 1);
  assert.equal(body.pagination.totalPages, 2);
  assert.equal(body.users.length, 1);
  assert.equal(body.users[0].name, 'Other Vendor');

  const byEmail = await apiRequest('/api/admin/users?search=customer.one@&role=customer');

  assert.equal(byEmail.status, 200);
  const emailBody = await byEmail.json();
  assert.equal(emailBody.pagination.totalItems, 1);
  assert.equal(emailBody.users[0].email, 'customer.one@example.test');

  const operatorSearch = await apiRequest('/api/admin/users?search[$ne]=null');

  await expectError(operatorSearch, 400, 'VALIDATION_ERROR');

  const escapedSearch = await apiRequest('/api/admin/users?search=.*');

  assert.equal(escapedSearch.status, 200);
  assert.equal((await escapedSearch.json()).pagination.totalItems, 0);
});

test('admin user listing never returns Better Auth secrets or private fields', async () => {
  const response = await apiRequest('/api/admin/users');
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(body.users.length, 6);
  assert.doesNotMatch(serialized, /passwordHash|resetToken|sessionToken|privateNote|secret-hash-must-not-leak/);

  assert.deepEqual(Object.keys(body.users[0]).sort(), [
    'businessName',
    'createdAt',
    'email',
    'id',
    'image',
    'isBlocked',
    'name',
    'role',
    'subscriptionExpiresAt',
    'subscriptionPlan',
    'subscriptionStatus',
    'updatedAt',
  ]);
});

test('admin user details return safe fields and reject malformed or missing ids', async () => {
  const response = await apiRequest(`/api/admin/users/${VENDOR_ID}`);

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.user.id, VENDOR_ID);
  assert.equal(body.user.businessName, 'Vendor One Pizzeria');
  assert.equal(body.user.isBlocked, false);
  assert.equal(body.user.createdAt, '2026-01-03T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(body), /passwordHash|resetToken|sessionToken|privateNote/);

  await expectError(await apiRequest('/api/admin/users/not-an-id'), 400, 'INVALID_USER_ID');
  await expectError(await apiRequest(`/api/admin/users/${MISSING_ID}`), 404, 'USER_NOT_FOUND');
  await expectError(await apiRequest('/api/admin/users?role=superadmin'), 400, 'VALIDATION_ERROR');
  await expectError(await apiRequest('/api/admin/users?limit=999'), 400, 'VALIDATION_ERROR');
  await expectError(await apiRequest('/api/admin/users?page=0'), 400, 'VALIDATION_ERROR');
});

test('blocking and unblocking a vendor uses only the server-owned boolean', async () => {
  const blocked = await apiRequest(`/api/admin/users/${VENDOR_ID}/block`, {
    method: 'PATCH',
    body: {},
  });

  assert.equal(blocked.status, 200);
  assert.equal((await blocked.json()).user.isBlocked, true);

  const denied = await apiRequest('/api/users/me', { token: 'vendor-token' });
  const deniedBody = await expectError(denied, 403, 'FORBIDDEN');

  assert.equal(deniedBody.message, 'This account is blocked.');
  assert.doesNotMatch(JSON.stringify(deniedBody), /sk_test|stripe|password/i);

  const unblocked = await apiRequest(`/api/admin/users/${VENDOR_ID}/unblock`, {
    method: 'PATCH',
    body: {},
  });

  assert.equal(unblocked.status, 200);
  assert.equal((await unblocked.json()).user.isBlocked, false);
  assert.equal((await apiRequest('/api/users/me', { token: 'vendor-token' })).status, 200);

  const updates = fakeUsers.state.calls.filter(
    (call) => call.method === 'updateOne' && Object.hasOwn(call.update?.$set ?? {}, 'isBlocked'),
  );

  assert.equal(updates.length, 2);

  for (const update of updates) {
    assert.deepEqual(Object.keys(update.update.$set).sort(), ['isBlocked', 'updatedAt']);
    assert.deepEqual(Object.keys(update.filter).sort(), ['_id', 'isBlocked', 'role']);
    assert.equal(update.filter.role.$ne, 'admin');
    assert.equal(update.filter.isBlocked.$ne, update.update.$set.isBlocked);
  }
});

test('a blocked customer is denied protected platform features', async () => {
  assert.equal((await apiRequest('/api/users/me', { token: 'customer-token' })).status, 200);

  await apiRequest(`/api/admin/users/${CUSTOMER_ID}/block`, { method: 'PATCH', body: {} });

  await expectError(
    await apiRequest('/api/users/me', { token: 'customer-token' }),
    403,
    'FORBIDDEN',
  );
  await expectError(
    await apiRequest('/api/orders', { token: 'customer-token', method: 'POST', body: {} }),
    403,
    'FORBIDDEN',
  );
  await expectError(
    await apiRequest('/api/vendor/orders', { token: 'customer-token' }),
    403,
    'FORBIDDEN',
  );
  assert.equal((await apiRequest('/api/vendor/subscription', { token: 'vendor-token' })).status, 200);
});

test('a blocked vendor is denied vendor APIs but not Stripe webhooks', async () => {
  await apiRequest(`/api/admin/users/${VENDOR_ID}/block`, { method: 'PATCH', body: {} });

  for (const path of ['/api/users/me', '/api/vendor/orders', '/api/vendor/subscription']) {
    await expectError(await apiRequest(path, { token: 'vendor-token' }), 403, 'FORBIDDEN');
  }

  await expectError(
    await apiRequest('/api/admin/menu', { token: 'vendor-token' }),
    403,
    'FORBIDDEN',
  );

  const event = {
    id: 'evt_local_only_blocked_vendor_access',
    type: 'customer.subscription.updated',
    created: Math.floor(FIXED_NOW.getTime() / 1000) + 1,
    data: {
      object: subscriptionObject(),
    },
  };

  assert.equal((await postWebhook(event)).status, 200);
});

test('repeated block and unblock requests are idempotent', async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await apiRequest(`/api/admin/users/${VENDOR_ID}/block`, {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.isBlocked, true);
  }

  const writes = fakeUsers.state.calls.filter(
    (call) => call.method === 'updateOne' && Object.hasOwn(call.update?.$set ?? {}, 'isBlocked'),
  );

  assert.equal(writes.length, 1);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await apiRequest(`/api/admin/users/${VENDOR_ID}/unblock`, {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.isBlocked, false);
  }
});

test('self-block and Admin blocking are prevented', async () => {
  await expectError(
    await apiRequest(`/api/admin/users/${ADMIN_ID}/block`, { method: 'PATCH', body: {} }),
    400,
    'SELF_BLOCK_NOT_ALLOWED',
  );
  await expectError(
    await apiRequest(`/api/admin/users/${SECOND_ADMIN_ID}/block`, { method: 'PATCH', body: {} }),
    403,
    'ADMIN_ACCOUNT_PROTECTED',
  );
  await expectError(
    await apiRequest(`/api/admin/users/${SECOND_ADMIN_ID}/unblock`, { method: 'PATCH', body: {} }),
    403,
    'ADMIN_ACCOUNT_PROTECTED',
  );

  assert.equal(fakeUsers.state.items.find((user) => user._id.toString() === ADMIN_ID).isBlocked, false);
  assert.equal(
    fakeUsers.state.items.find((user) => user._id.toString() === SECOND_ADMIN_ID).isBlocked,
    false,
  );
});

test('block bodies cannot modify roles, subscriptions or unrelated fields', async () => {
  const badBodies = [
    { role: 'customer' },
    { subscriptionPlan: 'premium' },
    { subscriptionStatus: 'active' },
    { subscriptionExpiresAt: '2099-01-01' },
    { isBlocked: true },
    { email: 'changed@example.test' },
    { stripeCustomerId: 'cus_injected' },
    { paymentStatus: 'paid' },
  ];

  for (const body of badBodies) {
    await expectError(
      await apiRequest(`/api/admin/users/${VENDOR_ID}/block`, { method: 'PATCH', body }),
      400,
      'FORBIDDEN_FIELD',
    );
  }

  const vendor = fakeUsers.state.items.find((user) => user._id.toString() === VENDOR_ID);

  assert.equal(vendor.role, 'vendor');
  assert.equal(vendor.isBlocked, false);
  assert.equal(vendor.subscriptionPlan, 'free');
  assert.equal(vendor.subscriptionStatus, 'inactive');
  assert.equal(vendor.email, 'vendor.one@example.test');
  assert.equal(
    fakeUsers.state.calls.filter((call) => call.method === 'updateOne').length,
    0,
  );
});

test('blocking does not alter orders, menu items, transactions, subscriptions or Stripe', async () => {
  const ordersSnapshot = JSON.stringify(fakeOrders.items);
  const menuSnapshot = JSON.stringify(fakeMenu.state.items);
  const transactionsSnapshot = JSON.stringify(fakeTransactions.state.items);
  const vendor = fakeUsers.state.items.find((user) => user._id.toString() === VENDOR_ID);

  vendor.subscriptionPlan = 'premium';
  vendor.subscriptionStatus = 'active';
  vendor.subscriptionExpiresAt = new Date(FIXED_NOW.getTime() + 86_400_000);
  vendor.stripeCustomerId = 'cus_local_only_001';
  vendor.stripeSubscriptionId = SUBSCRIPTION_ID;
  const subscriptionSnapshot = JSON.stringify({
    plan: vendor.subscriptionPlan,
    status: vendor.subscriptionStatus,
    expiresAt: vendor.subscriptionExpiresAt,
    stripeCustomerId: vendor.stripeCustomerId,
    stripeSubscriptionId: vendor.stripeSubscriptionId,
  });

  const response = await apiRequest(`/api/admin/users/${VENDOR_ID}/block`, {
    method: 'PATCH',
    body: {},
  });

  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(fakeOrders.items), ordersSnapshot);
  assert.equal(JSON.stringify(fakeMenu.state.items), menuSnapshot);
  assert.equal(JSON.stringify(fakeTransactions.state.items), transactionsSnapshot);
  assert.equal(
    JSON.stringify({
      plan: vendor.subscriptionPlan,
      status: vendor.subscriptionStatus,
      expiresAt: vendor.subscriptionExpiresAt,
      stripeCustomerId: vendor.stripeCustomerId,
      stripeSubscriptionId: vendor.stripeSubscriptionId,
    }),
    subscriptionSnapshot,
  );
  assert.equal(
    fakeStripeState.calls.some((call) => call.startsWith('subscriptions.update')),
    false,
  );
});

test('verified Stripe webhooks still update a blocked vendor billing state', async () => {
  const vendor = fakeUsers.state.items.find((user) => user._id.toString() === VENDOR_ID);

  vendor.isBlocked = true;

  const event = {
    id: 'evt_local_only_blocked_vendor',
    type: 'invoice.paid',
    created: Math.floor(FIXED_NOW.getTime() / 1000),
    data: {
      object: {
        id: 'in_local_only_blocked_vendor',
        object: 'invoice',
        customer: 'cus_local_only_001',
        subscription: SUBSCRIPTION_ID,
        subscription_details: { metadata: { vendorId: VENDOR_ID } },
        amount_paid: 900,
        currency: 'usd',
      },
    },
  };

  const response = await postWebhook(event);

  assert.equal(response.status, 200);
  const reloadedVendor = fakeUsers.state.items.find(
    (user) => user._id.toString() === VENDOR_ID,
  );

  assert.equal(reloadedVendor.isBlocked, true);
  assert.equal(reloadedVendor.subscriptionPlan, 'premium');
  assert.equal(reloadedVendor.subscriptionStatus, 'active');
  assert.equal(reloadedVendor.stripeSubscriptionId, SUBSCRIPTION_ID);
  assert.equal(fakeTransactions.state.items.length, 4);
});

test('admin transactions are paginated newest-first with safe fields', async () => {
  const response = await apiRequest('/api/admin/transactions');

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.transactions.map((item) => item.id), [
    TRANSACTION_ID,
    SECOND_TRANSACTION_ID,
    THIRD_TRANSACTION_ID,
  ]);
  assert.equal(body.pagination.totalItems, 3);
  assert.equal(body.pagination.totalPages, 1);
  assert.doesNotMatch(JSON.stringify(body), /cardNumber|cvc|4111111111111111/);

  assert.deepEqual(Object.keys(body.transactions[0]).sort(), [
    'amount',
    'createdAt',
    'currency',
    'eventType',
    'id',
    'paymentStatus',
    'status',
    'stripeCheckoutSessionId',
    'stripeEventCreated',
    'stripeEventId',
    'stripeInvoiceId',
    'stripeSessionId',
    'stripeSubscriptionId',
    'updatedAt',
    'vendorId',
  ]);

  const paginated = await apiRequest('/api/admin/transactions?page=2&limit=2');

  assert.equal(paginated.status, 200);
  assert.equal((await paginated.json()).transactions.length, 1);
});

test('admin transaction status, vendor and date filters use the existing schema', async () => {
  const failed = await apiRequest(`/api/admin/transactions?status=failed&vendorId=${VENDOR_ID}`);

  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  assert.equal(failedBody.pagination.totalItems, 1);
  assert.equal(failedBody.transactions[0].paymentStatus, 'failed');
  assert.equal(failedBody.transactions[0].stripeInvoiceId, 'in_local_only_002');

  // Legacy rows may store only paymentStatus, or a stale status alongside it.
  // The filter must agree with serializeAdminTransaction() in both cases.
  fakeTransactions.state.items.push(
    {
      _id: new ObjectId('65d000000000000000000004'),
      vendorId: VENDOR_ID,
      paymentStatus: 'failed',
      amount: 900,
      currency: 'usd',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
    {
      _id: new ObjectId('65d000000000000000000005'),
      vendorId: VENDOR_ID,
      paymentStatus: 'paid',
      status: 'failed',
      amount: 900,
      currency: 'usd',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: FIXED_NOW,
    },
  );

  const legacyFailed = await apiRequest(`/api/admin/transactions?status=failed&vendorId=${VENDOR_ID}`);
  assert.equal((await legacyFailed.json()).pagination.totalItems, 2);

  const authoritativePaymentStatus = await apiRequest(
    `/api/admin/transactions?status=paid&vendorId=${VENDOR_ID}`,
  );
  const authoritativeBody = await authoritativePaymentStatus.json();
  assert.equal(authoritativeBody.pagination.totalItems, 2);
  assert.deepEqual(
    authoritativeBody.transactions.map((item) => item.paymentStatus),
    ['paid', 'paid'],
  );

  const dateRange = await apiRequest(
    '/api/admin/transactions?fromDate=2026-01-02&toDate=2026-01-03',
  );

  assert.equal(dateRange.status, 200);
  const dateBody = await dateRange.json();
  assert.deepEqual(dateBody.transactions.map((item) => item.id), [
    TRANSACTION_ID,
    SECOND_TRANSACTION_ID,
  ]);

  const noMatch = await apiRequest('/api/admin/transactions?status=paid&vendorId=65b000000000000000000099');

  assert.equal(noMatch.status, 200);
  assert.equal((await noMatch.json()).pagination.totalItems, 0);

  await expectError(
    await apiRequest('/api/admin/transactions?fromDate=2026-02-30'),
    400,
    'VALIDATION_ERROR',
  );
  await expectError(
    await apiRequest('/api/admin/transactions?fromDate=2026-01-05&toDate=2026-01-01'),
    400,
    'VALIDATION_ERROR',
  );
  await expectError(
    await apiRequest('/api/admin/transactions?where[$ne]=null'),
    400,
    'VALIDATION_ERROR',
  );
});

test('transaction listing is Admin-only and strictly read-only', async () => {
  await expectError(await apiRequest('/api/admin/transactions', { token: null }), 401, 'UNAUTHORIZED');
  await expectError(
    await apiRequest('/api/admin/transactions', { token: 'customer-token' }),
    403,
    'FORBIDDEN',
  );
  await expectError(
    await apiRequest('/api/admin/transactions', { token: 'vendor-token' }),
    403,
    'FORBIDDEN',
  );

  for (const [method, path] of [
    ['POST', '/api/admin/transactions'],
    ['PATCH', `/api/admin/transactions/${TRANSACTION_ID}`],
    ['DELETE', `/api/admin/transactions/${TRANSACTION_ID}`],
    ['PUT', `/api/admin/transactions/${TRANSACTION_ID}`],
  ]) {
    await expectError(
      await apiRequest(path, {
        method,
        body: { paymentStatus: 'paid', status: 'paid', amount: 1 },
      }),
      404,
      'NOT_FOUND',
    );
  }

  const transaction = fakeTransactions.state.items.find(
    (item) => item._id.toString() === THIRD_TRANSACTION_ID,
  );

  assert.equal(transaction.paymentStatus, 'failed');
  assert.equal(transaction.status, 'failed');
  assert.equal(transaction.amount, 900);
});

test('admin can deactivate and reactivate a published menu item using the existing availability field', async () => {
  const deactivate = await apiRequest(`/api/admin/menu/${ITEM_ID}/availability`, {
    method: 'PATCH',
    body: { isAvailable: false },
  });

  assert.equal(deactivate.status, 200);
  assert.equal((await deactivate.json()).item.isAvailable, false);
  assert.equal(
    fakeMenu.state.items.find((item) => item._id.toString() === ITEM_ID).isAvailable,
    false,
  );

  const reactivate = await apiRequest(`/api/admin/menu/${ITEM_ID}/availability`, {
    method: 'PATCH',
    body: { isAvailable: true },
  });

  assert.equal(reactivate.status, 200);
  assert.equal((await reactivate.json()).item.isAvailable, true);

  const write = fakeMenu.state.calls.find(
    (call) => call.method === 'updateOne' && Object.hasOwn(call.update?.$set ?? {}, 'isAvailable'),
  );

  assert.deepEqual(Object.keys(write.update.$set).sort(), ['isAvailable', 'updatedAt']);
});

test('published availability checks published state, free slots and protected fields', async () => {
  await expectError(
    await apiRequest(`/api/admin/menu/${PENDING_ITEM_ID}/availability`, {
      method: 'PATCH',
      body: { isAvailable: false },
    }),
    409,
    'MENU_ITEM_NOT_PUBLISHED',
  );
  await expectError(
    await apiRequest(`/api/admin/menu/${ITEM_ID}/availability`, {
      method: 'PATCH',
      body: { isAvailable: false, status: MENU_STATUS.REJECTED },
    }),
    400,
    'FORBIDDEN_FIELD',
  );
  await expectError(
    await apiRequest(`/api/admin/menu/${ITEM_ID}/availability`, {
      token: 'vendor-token',
      method: 'PATCH',
      body: { isAvailable: false },
    }),
    403,
    'FORBIDDEN',
  );

  for (let index = 0; index < 3; index += 1) {
    fakeMenu.state.items.push({
      _id: new ObjectId(`65e00000000000000000000${index + 1}`),
      vendorId: VENDOR_ID,
      itemName: `Extra Pizza ${index + 1}`,
      status: MENU_STATUS.APPROVED,
      isAvailable: true,
      createdAt: new Date(Date.UTC(2026, 0, 10 + index)),
    });
  }

  assert.equal(
    (
      await apiRequest(`/api/admin/menu/${ITEM_ID}/availability`, {
        method: 'PATCH',
        body: { isAvailable: false },
      })
    ).status,
    200,
  );

  await expectError(
    await apiRequest(`/api/admin/menu/${ITEM_ID}/availability`, {
      method: 'PATCH',
      body: { isAvailable: true },
    }),
    409,
    'MENU_ITEM_LIMIT_REACHED',
  );
});
