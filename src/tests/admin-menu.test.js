import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { ObjectId } from 'mongodb';

import { createAuthenticate } from '../middlewares/authenticate.js';
import { findActiveTestSession } from './auth-session-helper.js';
import { createFakeMenuSlots } from './menu-slot-fake.js';
import { createErrorHandler } from '../middlewares/error.js';
import { createAdminMenuRoutes } from '../modules/admin/admin-menu.routes.js';
import {
  ADMIN_MENU_PROJECTION,
  createAdminMenuService,
} from '../modules/admin/admin-menu.service.js';
import { createMenuSlotService } from '../modules/menu/menu-slots.js';
import { createMenuRoutes } from '../modules/menu/menu.routes.js';
import {
  FREE_MENU_ITEM_LIMIT,
  buildSlotFilter,
  createMenuService,
} from '../modules/menu/menu.service.js';
import { MENU_STATUS } from '../modules/menu/menu.validator.js';

// Fake ids and values only. This suite never reads .env or contacts Atlas.
const AUTH_URL = 'https://auth.example.test';
const CUSTOMER_ID = '65b000000000000000000001';
const VENDOR_ID = '65b000000000000000000002';
const ADMIN_ID = '65b000000000000000000003';
const ITEM_ID = '65c000000000000000000001';
const MISSING_ITEM_ID = '65c000000000000000000099';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const IMAGE_URL = 'https://i.ibb.co/test/pizza.png';

const TOKEN_SUBJECTS = Object.freeze({
  'customer-token': CUSTOMER_ID,
  'vendor-token': VENDOR_ID,
  'admin-token': ADMIN_ID,
});

const users = new Map([
  [
    CUSTOMER_ID,
    {
      _id: new ObjectId(CUSTOMER_ID),
      role: 'customer',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
  ],
  [
    VENDOR_ID,
    {
      _id: new ObjectId(VENDOR_ID),
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
  ],
  [
    ADMIN_ID,
    {
      _id: new ObjectId(ADMIN_ID),
      role: 'admin',
      isBlocked: false,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
  ],
]);

function valuesEqual(left, right) {
  if (left instanceof ObjectId || right instanceof ObjectId) {
    return String(left) === String(right);
  }

  return left === right;
}

function matchesValue(expected, actual) {
  if (expected instanceof RegExp) {
    return expected.test(String(actual ?? ''));
  }

  if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$regex')) {
    const source =
      typeof expected.$regex === 'string' ? expected.$regex : expected.$regex.source;
    const flags = expected.$options ?? expected.$regex.flags ?? '';

    return new RegExp(source, flags).test(String(actual ?? ''));
  }

  if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$in')) {
    return expected.$in.some((candidate) => valuesEqual(candidate, actual));
  }

  if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$ne')) {
    return !valuesEqual(expected.$ne, actual);
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

    return matchesValue(expected, item[key]);
  });
}

function applyProjection(item, projection) {
  if (!projection) {
    return item;
  }

  const fields = Object.entries(projection);
  const isInclusion = fields.some(([field, value]) => field !== '_id' && value === 1);

  if (isInclusion) {
    const result = {};

    for (const [field, value] of fields) {
      if (value === 1 && Object.hasOwn(item, field)) {
        result[field] = item[field];
      }
    }

    return result;
  }

  const result = { ...item };

  for (const [field, value] of fields) {
    if (value === 0) {
      delete result[field];
    }
  }

  return result;
}

function createFakeCollection() {
  const state = { items: [], calls: [] };

  function record(method, details) {
    state.calls.push({ method, ...details });
  }

  function seedItem(overrides = {}) {
    const item = {
      _id: new ObjectId(ITEM_ID),
      vendorId: VENDOR_ID,
      itemName: 'Original Pizza',
      category: 'Classic Pizzas',
      description: 'A tested pizza.',
      price: 12.5,
      location: 'Downtown',
      images: [IMAGE_URL],
      status: MENU_STATUS.PENDING,
      isAvailable: true,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      ...overrides,
    };

    state.items.push(item);

    return item;
  }

  const collection = {
    state,
    seedItem,

    async findOne(filter) {
      record('findOne', { filter });

      return state.items.find((item) => matches(filter, item)) ?? null;
    },

    find(filter) {
      record('find', { filter });

      let selected = state.items.filter((item) => matches(filter, item));
      let projection = null;
      let skipCount = 0;
      let limitCount = Infinity;

      const cursor = {
        project(spec) {
          projection = spec;
          record('project', { projection: spec });
          return cursor;
        },
        sort(spec) {
          record('sort', { spec });
          const entries = Object.entries(spec);
          selected = [...selected].sort((left, right) => {
            for (const [field, direction] of entries) {
              const a = left[field];
              const b = right[field];

              if (typeof a === 'number' && typeof b === 'number') {
                if (a !== b) {
                  return a < b ? -direction : direction;
                }
              } else if (a instanceof Date && b instanceof Date) {
                if (a.getTime() !== b.getTime()) {
                  return a.getTime() < b.getTime() ? -direction : direction;
                }
              } else if (String(a) !== String(b)) {
                return String(a) < String(b) ? -direction : direction;
              }
            }

            return 0;
          });

          return cursor;
        },
        skip(count) {
          skipCount = count;
          record('skip', { count });
          return cursor;
        },
        limit(count) {
          limitCount = count;
          record('limit', { count });
          return cursor;
        },
        async toArray() {
          return selected
            .slice(skipCount, skipCount + limitCount)
            .map((item) => applyProjection(item, projection));
        },
      };

      return cursor;
    },

    async countDocuments(filter) {
      record('countDocuments', { filter });

      return state.items.filter((item) => matches(filter, item)).length;
    },

    async updateOne(filter, update) {
      record('updateOne', { filter, update });
      const index = state.items.findIndex((candidate) => matches(filter, candidate));

      if (index === -1) {
        return { matchedCount: 0 };
      }

      // MongoDB returns a document snapshot to the caller; mutating the same
      // in-memory object would make a pre-update snapshot appear updated.
      state.items[index] = { ...state.items[index], ...update.$set };

      return { matchedCount: 1 };
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

  return collection;
}

let fakeCollection;
let fakeSlots;
let server;
let baseUrl;
const originalConsoleError = console.error;

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

function bearer(path, token, options = {}) {
  return request(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

function sendJson(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return request(path, { method, headers, body: JSON.stringify(body) });
}

async function expectStatus(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.success, false);

  if (code) {
    assert.equal(body.code, code);
  }

  return body;
}

before(async () => {
  console.error = () => {};
  fakeCollection = createFakeCollection();
  fakeSlots = createFakeMenuSlots();

  // Every token deliberately claims the admin role. authenticate() must ignore
  // JWT claims and reload the role from the fake MongoDB user map above.
  const authenticate = createAuthenticate(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      verifyToken: async (token) => {
        const subject = TOKEN_SUBJECTS[token];

        if (!subject) {
          throw new Error('invalid test token');
        }

        return {
          sub: subject,
          sid: subject,
          role: 'admin',
          subscriptionPlan: 'premium',
          subscriptionStatus: 'active',
          subscriptionExpiresAt: '2099-01-01T00:00:00.000Z',
        };
      },
      findUser: async (userId) => users.get(userId) ?? null,
      findSession: findActiveTestSession,
    },
  );

  // Match app.js: route tests must exercise the atomic slots collection, not
  // the legacy count fallback used when no slotsCollection is injected.
  const adminMenuService = createAdminMenuService({
    collection: () => fakeCollection,
    slotsCollection: () => fakeSlots,
    now: () => FIXED_DATE,
  });
  const menuService = createMenuService({
    collection: () => fakeCollection,
    slotsCollection: () => fakeSlots,
    now: () => FIXED_DATE,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin/menu',
    createAdminMenuRoutes({}, { authenticate, adminMenuService }),
  );
  app.use(
    '/api/menu',
    createMenuRoutes({}, {
      authenticate,
      menuService,
      imageUploader: { uploadImages: async () => [] },
    }),
  );
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  const fresh = createFakeCollection();
  fakeCollection.state.items = fresh.state.items;
  fakeCollection.state.calls = fresh.state.calls;

  const freshSlots = createFakeMenuSlots();
  fakeSlots.state.documents = freshSlots.state.documents;
  fakeSlots.state.calls = freshSlots.state.calls;
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('admin endpoints require authentication and an admin database role', async () => {
  const endpoints = [
    { method: 'GET', path: '/api/admin/menu' },
    {
      method: 'PATCH',
      path: `/api/admin/menu/${ITEM_ID}/status`,
      body: { status: MENU_STATUS.APPROVED },
    },
    { method: 'DELETE', path: `/api/admin/menu/${ITEM_ID}` },
  ];

  for (const endpoint of endpoints) {
    if (endpoint.body) {
      await expectStatus(
        await sendJson(endpoint.method, endpoint.path, null, endpoint.body),
        401,
        'UNAUTHORIZED',
      );

      for (const token of ['customer-token', 'vendor-token']) {
        await expectStatus(
          await sendJson(endpoint.method, endpoint.path, token, endpoint.body),
          403,
          'FORBIDDEN',
        );
      }
    } else {
      await expectStatus(
        await request(endpoint.path, { method: endpoint.method }),
        401,
        'UNAUTHORIZED',
      );

      for (const token of ['customer-token', 'vendor-token']) {
        await expectStatus(
          await bearer(endpoint.path, token, { method: endpoint.method }),
          403,
          'FORBIDDEN',
        );
      }
    }
  }

  assert.equal(fakeCollection.state.calls.length, 0);
});

test('an authenticated admin can list all menu statuses without private user data', async () => {
  const seedWithStatus = (status, itemName, day) =>
    fakeCollection.seedItem({
      _id: new ObjectId(),
      status,
      itemName,
      createdAt: new Date(Date.UTC(2026, 0, day)),
      passwordHash: 'must-not-leak',
      resetToken: 'must-not-leak',
      authSecret: 'must-not-leak',
    });

  seedWithStatus(MENU_STATUS.PENDING, 'Pending Pizza', 1);
  seedWithStatus(MENU_STATUS.APPROVED, 'Approved Pizza', 2);
  seedWithStatus(MENU_STATUS.REJECTED, 'Rejected Pizza', 3);
  seedWithStatus(MENU_STATUS.INACTIVE, 'Inactive Pizza', 4);

  const response = await bearer('/api/admin/menu', 'admin-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 4);
  assert.deepEqual(
    body.items.map((item) => item.status),
    [
      MENU_STATUS.INACTIVE,
      MENU_STATUS.REJECTED,
      MENU_STATUS.APPROVED,
      MENU_STATUS.PENDING,
    ],
  );

  for (const item of body.items) {
    assert.equal(item.vendorId, VENDOR_ID);
    assert.equal(Object.hasOwn(item, 'status'), true);

    for (const secret of ['passwordHash', 'resetToken', 'authSecret']) {
      assert.equal(Object.hasOwn(item, secret), false);
    }
  }

  assert.deepEqual(body.pagination, {
    page: 1,
    limit: 12,
    totalItems: 4,
    totalPages: 1,
  });
  assert.deepEqual(fakeCollection.state.calls.find((call) => call.method === 'find').filter, {});
  assert.deepEqual(
    fakeCollection.state.calls.find((call) => call.method === 'project').projection,
    ADMIN_MENU_PROJECTION,
  );
});

test('admin search matches names and descriptions case-insensitively', async () => {
  const byName = fakeCollection.seedItem({
    _id: new ObjectId(),
    itemName: 'Pepperoni Feast',
    description: 'Classic',
    status: MENU_STATUS.PENDING,
  });
  const byDescription = fakeCollection.seedItem({
    _id: new ObjectId(),
    itemName: 'Veggie Delight',
    description: 'Pepperoni surprise',
    status: MENU_STATUS.APPROVED,
  });
  fakeCollection.seedItem({
    _id: new ObjectId(),
    itemName: 'Plain Cheese',
    description: 'Simple',
    status: MENU_STATUS.REJECTED,
  });

  const response = await bearer(
    `/api/admin/menu?search=${encodeURIComponent('pepperoni')}`,
    'admin-token',
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.id).sort(),
    [String(byName._id), String(byDescription._id)].sort(),
  );
  assert.deepEqual(
    fakeCollection.state.calls.find((call) => call.method === 'find').filter.$or,
    [
      { itemName: { $regex: 'pepperoni', $options: 'i' } },
      { description: { $regex: 'pepperoni', $options: 'i' } },
    ],
  );
});

test('admin status, category and location filters work together', async () => {
  fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.PENDING,
    category: 'Classic Pizzas',
    location: 'Downtown',
    itemName: 'Target',
  });
  fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.APPROVED,
    category: 'Beverages & Desserts',
    location: 'South Campus',
    itemName: 'Other',
  });

  const statusResponse = await bearer(
    `/api/admin/menu?status=${MENU_STATUS.PENDING}`,
    'admin-token',
  );
  const categoryResponse = await bearer(
    `/api/admin/menu?category=${encodeURIComponent('Beverages & Desserts')}`,
    'admin-token',
  );
  const locationResponse = await bearer(
    `/api/admin/menu?location=${encodeURIComponent('South Campus')}`,
    'admin-token',
  );
  const combinedResponse = await bearer(
    `/api/admin/menu?status=${MENU_STATUS.PENDING}&category=${encodeURIComponent('Classic Pizzas')}&location=Downtown`,
    'admin-token',
  );

  for (const response of [statusResponse, categoryResponse, locationResponse, combinedResponse]) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items.length, 1);
  }

  const filters = fakeCollection.state.calls
    .filter((call) => call.method === 'find')
    .map((call) => call.filter);

  assert.equal(filters[0].status, MENU_STATUS.PENDING);
  assert.equal(filters[1].category, 'Beverages & Desserts');
  assert.equal(filters[2].location, 'South Campus');
  assert.deepEqual(filters[3], {
    status: MENU_STATUS.PENDING,
    category: 'Classic Pizzas',
    location: 'Downtown',
  });
});

test('admin search text is escaped and invalid queries are rejected', async () => {
  const literal = fakeCollection.seedItem({
    _id: new ObjectId(),
    itemName: 'Pizza (Special)',
  });
  fakeCollection.seedItem({ _id: new ObjectId(), itemName: 'Pizza Special' });

  const literalResponse = await bearer(
    `/api/admin/menu?search=${encodeURIComponent('Pizza (Special)')}`,
    'admin-token',
  );
  const literalBody = await literalResponse.json();

  assert.equal(literalResponse.status, 200);
  assert.deepEqual(literalBody.items.map((item) => item.id), [String(literal._id)]);

  const wildcardResponse = await bearer(
    `/api/admin/menu?search=${encodeURIComponent('.*')}`,
    'admin-token',
  );
  assert.equal(wildcardResponse.status, 200);
  assert.deepEqual((await wildcardResponse.json()).items, []);

  const wildcardFilter = fakeCollection.state.calls
    .filter((call) => call.method === 'find')
    .at(-1).filter;

  assert.deepEqual(wildcardFilter.$or[0].itemName, {
    $regex: '\\.\\*',
    $options: 'i',
  });

  const callsBefore = fakeCollection.state.calls.length;
  const badPaths = [
    '/api/admin/menu?sort=newest',
    '/api/admin/menu?limit=500',
    '/api/admin/menu?page=0',
    `/api/admin/menu?status=${encodeURIComponent('unknown')}`,
    `/api/admin/menu?category=${encodeURIComponent('Nope')}`,
    '/api/admin/menu?where[$ne]=null',
    '/api/admin/menu?search[$ne]=null',
    '/api/admin/menu?unknown=1',
  ];

  for (const path of badPaths) {
    await expectStatus(await bearer(path, 'admin-token'), 400, 'VALIDATION_ERROR');
  }

  assert.equal(fakeCollection.state.calls.length, callsBefore);
});

test('admin listing paginates with MongoDB skip and limit', async () => {
  for (let day = 1; day <= 5; day += 1) {
    fakeCollection.seedItem({
      _id: new ObjectId(),
      itemName: `Item ${day}`,
      createdAt: new Date(Date.UTC(2026, 0, day)),
    });
  }

  const response = await bearer('/api/admin/menu?page=2&limit=2', 'admin-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items.map((item) => item.itemName), ['Item 3', 'Item 2']);
  assert.deepEqual(body.pagination, {
    page: 2,
    limit: 2,
    totalItems: 5,
    totalPages: 3,
  });
  assert.equal(fakeCollection.state.calls.find((call) => call.method === 'skip').count, 2);
  assert.equal(fakeCollection.state.calls.find((call) => call.method === 'limit').count, 2);
});

test('admin listing handles an empty collection', async () => {
  const response = await bearer('/api/admin/menu', 'admin-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items, []);
  assert.deepEqual(body.pagination, {
    page: 1,
    limit: 12,
    totalItems: 0,
    totalPages: 0,
  });
});

test('an admin can approve a pending item without changing other fields or slots', async () => {
  const target = fakeCollection.seedItem({
    _id: new ObjectId(ITEM_ID),
    status: MENU_STATUS.PENDING,
    itemName: 'Approve Me',
    price: 9.5,
    isAvailable: true,
  });
  fakeCollection.seedItem({ _id: new ObjectId(), status: MENU_STATUS.APPROVED });
  const slotsBefore = await fakeCollection.countDocuments(buildSlotFilter(VENDOR_ID));

  const response = await sendJson(
    'PATCH',
    `/api/admin/menu/${ITEM_ID}/status`,
    'admin-token',
    { status: MENU_STATUS.APPROVED },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.item.status, MENU_STATUS.APPROVED);
  assert.equal(body.item.vendorId, VENDOR_ID);
  assert.equal(body.item.itemName, 'Approve Me');
  assert.equal(body.item.price, 9.5);
  assert.equal(body.item.isAvailable, true);
  assert.deepEqual(body.item.updatedAt, FIXED_DATE.toISOString());

  const update = fakeCollection.state.calls.find((call) => call.method === 'updateOne');

  assert.equal(String(update.filter._id), String(target._id));
  assert.equal(update.filter.status, MENU_STATUS.PENDING);
  assert.deepEqual(Object.keys(update.update.$set).sort(), ['status', 'updatedAt']);
  assert.equal(update.update.$set.status, MENU_STATUS.APPROVED);

  const slotsAfter = await fakeCollection.countDocuments(buildSlotFilter(VENDOR_ID));
  assert.equal(slotsAfter, slotsBefore);
});

test('an admin can reject a pending item', async () => {
  fakeCollection.seedItem({
    _id: new ObjectId(ITEM_ID),
    status: MENU_STATUS.PENDING,
  });
  fakeSlots.state.documents.push({ _id: VENDOR_ID, itemIds: [ITEM_ID] });

  const response = await sendJson(
    'PATCH',
    `/api/admin/menu/${ITEM_ID}/status`,
    'admin-token',
    { status: MENU_STATUS.REJECTED },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.item.status, MENU_STATUS.REJECTED);

  const update = fakeCollection.state.calls.find((call) => call.method === 'updateOne');

  assert.deepEqual(Object.keys(update.update.$set).sort(), ['status', 'updatedAt']);
  assert.equal(update.update.$set.status, MENU_STATUS.REJECTED);

  // Moderation releases the production atomic reservation as well.
  assert.deepEqual(fakeSlots.state.documents[0].itemIds, []);
});

test('non-pending items cannot be moderated again', async () => {
  const target = fakeCollection.seedItem({
    _id: new ObjectId(ITEM_ID),
    status: MENU_STATUS.APPROVED,
  });

  for (const status of [
    MENU_STATUS.APPROVED,
    MENU_STATUS.REJECTED,
    MENU_STATUS.INACTIVE,
  ]) {
    target.status = status;

    const response = await sendJson(
      'PATCH',
      `/api/admin/menu/${ITEM_ID}/status`,
      'admin-token',
      { status: MENU_STATUS.APPROVED },
    );
    const body = await expectStatus(response, 409, 'MENU_ITEM_NOT_PENDING');

    assert.equal(body.message, 'Only pending menu items can be moderated.');
  }

  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'updateOne').length, 0);
});

test('moderation bodies cannot change unrelated or subscription fields', async () => {
  const callsBefore = fakeCollection.state.calls.length;
  const badBodies = [
    { status: MENU_STATUS.APPROVED, subscriptionPlan: 'premium' },
    { status: MENU_STATUS.APPROVED, subscriptionStatus: 'active' },
    { status: MENU_STATUS.APPROVED, subscriptionExpiresAt: '2099-01-01' },
    { status: MENU_STATUS.APPROVED, vendorId: 'someone-else' },
    { status: MENU_STATUS.APPROVED, price: 1 },
    { status: MENU_STATUS.APPROVED, isAvailable: false },
    { status: MENU_STATUS.PENDING },
    { status: MENU_STATUS.INACTIVE },
    { decision: MENU_STATUS.APPROVED },
  ];

  for (const body of badBodies) {
    const hasReservedField = Object.keys(body).some(
      (key) => key !== 'status' && key !== 'decision',
    );
    await expectStatus(
      await sendJson('PATCH', `/api/admin/menu/${ITEM_ID}/status`, 'admin-token', body),
      400,
      hasReservedField ? 'FORBIDDEN_FIELD' : 'VALIDATION_ERROR',
    );
  }

  assert.equal(fakeCollection.state.calls.length, callsBefore);
});

test('invalid ObjectIds are rejected and nonexistent items return 404', async () => {
  await expectStatus(
    await sendJson('PATCH', '/api/admin/menu/not-an-id/status', 'admin-token', {
      status: MENU_STATUS.APPROVED,
    }),
    400,
    'INVALID_MENU_ID',
  );
  await expectStatus(
    await bearer('/api/admin/menu/not-an-id', 'admin-token', { method: 'DELETE' }),
    400,
    'INVALID_MENU_ID',
  );
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'updateOne').length, 0);
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'deleteOne').length, 0);

  await expectStatus(
    await sendJson('PATCH', `/api/admin/menu/${MISSING_ITEM_ID}/status`, 'admin-token', {
      status: MENU_STATUS.APPROVED,
    }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );
  await expectStatus(
    await bearer(`/api/admin/menu/${MISSING_ITEM_ID}`, 'admin-token', { method: 'DELETE' }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );
});

test('an admin can delete any menu item without affecting unrelated records', async () => {
  const target = fakeCollection.seedItem({ _id: new ObjectId(ITEM_ID) });
  const unrelated = fakeCollection.seedItem({
    _id: new ObjectId(),
    itemName: 'Keep Me',
  });

  const response = await bearer(
    `/api/admin/menu/${ITEM_ID}`,
    'admin-token',
    { method: 'DELETE' },
  );

  assert.equal(response.status, 204);
  assert.deepEqual(
    fakeCollection.state.items.map((item) => String(item._id)),
    [String(unrelated._id)],
  );

  const deleteCall = fakeCollection.state.calls.find((call) => call.method === 'deleteOne');

  assert.equal(String(deleteCall.filter._id), String(target._id));
  assert.equal(Object.hasOwn(deleteCall.filter, 'vendorId'), false);
});

test('public browsing still excludes pending, rejected and unavailable items', async () => {
  fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.PENDING,
    isAvailable: true,
  });
  fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.REJECTED,
    isAvailable: true,
  });
  fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.APPROVED,
    isAvailable: false,
  });
  const visible = fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.APPROVED,
    isAvailable: true,
  });

  const response = await request('/api/menu');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items.map((item) => item.id), [String(visible._id)]);
  assert.deepEqual(
    fakeCollection.state.calls.find((call) => call.method === 'find').filter,
    { status: MENU_STATUS.APPROVED, isAvailable: true },
  );
});

test('existing vendor menu routes remain protected', async () => {
  await expectStatus(await request('/api/menu/mine'), 401, 'UNAUTHORIZED');
  await expectStatus(await bearer('/api/menu/mine', 'customer-token'), 403, 'FORBIDDEN');
  await expectStatus(await bearer('/api/menu/mine', 'admin-token'), 403, 'FORBIDDEN');

  const response = await bearer('/api/menu/mine', 'vendor-token');

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
});

test('concurrent admin availability restores reserve only three free-plan slots', async () => {
  const menu = createFakeCollection();
  const slots = createFakeMenuSlots();
  const service = createAdminMenuService({
    collection: () => menu,
    usersCollection: {
      async findOne() {
        return users.get(VENDOR_ID);
      },
    },
    slotsCollection: () => slots,
    now: () => FIXED_DATE,
  });

  const items = Array.from({ length: FREE_MENU_ITEM_LIMIT + 1 }, (_, index) =>
    menu.seedItem({
      _id: new ObjectId(`65c0000000000000000000${String(index + 20).padStart(2, '0')}`),
      itemName: `Admin Hidden Pizza ${index + 1}`,
      status: MENU_STATUS.APPROVED,
      isAvailable: false,
    }),
  );

  const results = await Promise.allSettled(
    items.map((item) => service.setPublishedAvailability(item._id.toString(), { isAvailable: true })),
  );

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, FREE_MENU_ITEM_LIMIT);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'MENU_ITEM_LIMIT_REACHED',
  );
  assert.equal(menu.state.items.filter((item) => item.isAvailable).length, FREE_MENU_ITEM_LIMIT);
});

test('a reconciliation racing an admin availability restore keeps the reserved slot', async () => {
  const menu = createFakeCollection();
  const item = menu.seedItem({
    _id: new ObjectId('65c000000000000000000028'),
    itemName: 'Race Admin Restore Pizza',
    status: MENU_STATUS.APPROVED,
    isAvailable: false,
  });
  const itemId = item._id.toString();
  const slots = createFakeMenuSlots();
  const slotService = createMenuSlotService({ collection: slots });
  let reserveObserved = false;
  const observingSlots = {
    ...slots,
    async findOneAndUpdate(filter, update, options) {
      const result = await slots.findOneAndUpdate(filter, update, options);

      if (result) {
        reserveObserved = true;
      }

      return result;
    },
  };
  const interleavedMenu = {
    ...menu,
    async updateOne(filter, update, options) {
      if (reserveObserved && Object.hasOwn(update?.$set ?? {}, 'isAvailable')) {
        // Runs after the slot is reserved but before the document is active.
        await slotService.reconcile(item.vendorId, []);
      }

      return menu.updateOne(filter, update, options);
    },
  };
  const service = createAdminMenuService({
    collection: () => interleavedMenu,
    usersCollection: {
      async findOne() {
        return users.get(item.vendorId);
      },
    },
    slotsCollection: () => observingSlots,
    now: () => FIXED_DATE,
  });

  await service.setPublishedAvailability(itemId, { isAvailable: true });

  assert.equal(menu.state.items[0].isAvailable, true);
  assert.deepEqual(slots.state.documents[0].itemIds, [itemId]);
  assert.deepEqual(slots.state.documents[0].pendingItemIds, []);
});

test('a failed admin slot release is reconciled after rejection', async () => {
  const menu = createFakeCollection();
  const item = menu.seedItem({
    itemName: 'Stale Admin Reservation Pizza',
    status: MENU_STATUS.PENDING,
    isAvailable: true,
  });
  const itemId = item._id.toString();
  const vendorId = item.vendorId;
  const slots = createFakeMenuSlots([{ _id: vendorId, itemIds: [itemId] }]);
  let failNextRelease = true;
  const failingSlots = {
    ...slots,
    async updateOne(filter, update, options) {
      if (failNextRelease) {
        failNextRelease = false;
        throw new Error('slot database temporarily unavailable');
      }

      return slots.updateOne(filter, update, options);
    },
  };
  const service = createAdminMenuService({
    collection: () => menu,
    usersCollection: {
      async findOne() {
        return users.get(vendorId);
      },
    },
    slotsCollection: () => failingSlots,
    now: () => FIXED_DATE,
  });

  const updated = await service.moderate(itemId, { status: MENU_STATUS.REJECTED });

  assert.equal(updated.status, MENU_STATUS.REJECTED);
  assert.deepEqual(slots.state.documents[0].itemIds, []);
});
