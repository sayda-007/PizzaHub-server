import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { ObjectId } from 'mongodb';

import { createAuthenticate } from '../middlewares/authenticate.js';
import { findActiveTestSession } from './auth-session-helper.js';
import { createErrorHandler } from '../middlewares/error.js';
import { MENU_STATUS } from '../modules/menu/menu.validator.js';
import {
  createCustomerOrderRoutes,
  createVendorOrderRoutes,
} from '../modules/order/order.routes.js';
import {
  buildActiveOrderKey,
  createOrderService,
} from '../modules/order/order.service.js';
import { ORDER_STATUS } from '../modules/order/order.validator.js';

// Fake ids and values only. This suite never reads .env or contacts Atlas.
const AUTH_URL = 'https://auth.example.test';
const CUSTOMER_ID = '65b000000000000000000001';
const VENDOR_ID = '65b000000000000000000002';
const OTHER_VENDOR_ID = '65b000000000000000000003';
const ADMIN_ID = '65b000000000000000000004';
const OTHER_CUSTOMER_ID = '65b000000000000000000005';
const MENU_ITEM_ID = '65c000000000000000000001';
const OTHER_MENU_ITEM_ID = '65c000000000000000000002';
const ORDER_ID = '65d000000000000000000001';
const OTHER_ORDER_ID = '65d000000000000000000002';
const MISSING_ID = '65d000000000000000000099';
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const DELIVERY_DATE = '2026-12-01';
const LATER_DELIVERY_DATE = '2026-12-02';
const IMAGE_URL = 'https://i.ibb.co/test/pizza.png';

const TOKEN_SUBJECTS = Object.freeze({
  'customer-token': CUSTOMER_ID,
  'other-customer-token': OTHER_CUSTOMER_ID,
  'vendor-token': VENDOR_ID,
  'other-vendor-token': OTHER_VENDOR_ID,
  'admin-token': ADMIN_ID,
});

// Every token deliberately carries the wrong role claim. authenticate() must
// ignore it and reload the role from the fake MongoDB user map.
const TOKEN_CLAIM_ROLES = Object.freeze({
  'customer-token': 'admin',
  'other-customer-token': 'vendor',
  'vendor-token': 'customer',
  'other-vendor-token': 'admin',
  'admin-token': 'customer',
});

const users = new Map([
  [CUSTOMER_ID, { _id: new ObjectId(CUSTOMER_ID), role: 'customer', isBlocked: false }],
  [OTHER_CUSTOMER_ID, { _id: new ObjectId(OTHER_CUSTOMER_ID), role: 'customer', isBlocked: false }],
  [VENDOR_ID, { _id: new ObjectId(VENDOR_ID), role: 'vendor', isBlocked: false }],
  [OTHER_VENDOR_ID, { _id: new ObjectId(OTHER_VENDOR_ID), role: 'vendor', isBlocked: false }],
  [ADMIN_ID, { _id: new ObjectId(ADMIN_ID), role: 'admin', isBlocked: false }],
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

  if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$exists')) {
    return expected.$exists ? actual !== undefined : actual === undefined;
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

function applyProjection(item, projection) {
  if (!projection) {
    return item;
  }

  const fields = Object.entries(projection);
  const isInclusion = fields.some(([, value]) => value === 1);

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

function snapshotFor(menuItem) {
  return {
    itemId: String(menuItem._id),
    itemName: menuItem.itemName,
    category: menuItem.category,
    description: menuItem.description,
    price: menuItem.price,
    location: menuItem.location,
    images: [...menuItem.images],
    menuStatus: menuItem.status,
    menuIsAvailable: menuItem.isAvailable !== false,
  };
}

function createFakeCollection(kind) {
  const state = { items: [], calls: [] };

  function record(method, details) {
    state.calls.push({ method, ...details });
  }

  function seedMenuItem(overrides = {}) {
    const item = {
      _id: new ObjectId(MENU_ITEM_ID),
      vendorId: VENDOR_ID,
      itemName: 'Margherita',
      category: 'Classic Pizzas',
      description: 'Tomato, mozzarella and basil.',
      price: 12.5,
      location: 'Downtown',
      images: [IMAGE_URL],
      status: MENU_STATUS.APPROVED,
      isAvailable: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      passwordHash: 'must-not-leak',
      ...overrides,
    };

    state.items.push(item);

    return item;
  }

  function seedOrder(overrides = {}) {
    const merged = {
      _id: new ObjectId(ORDER_ID),
      customerId: CUSTOMER_ID,
      vendorId: VENDOR_ID,
      itemId: MENU_ITEM_ID,
      status: ORDER_STATUS.PENDING,
      price: 12.5,
      deliveryDate: DELIVERY_DATE,
      deliveryAddress: '123 Main Street',
      additionalMessage: 'Leave at the door.',
      itemSnapshot: snapshotFor(seedMenuItemBase()),
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...overrides,
    };

    if (Object.hasOwn(overrides, 'activeOrderKey')) {
      if (overrides.activeOrderKey === undefined) {
        delete merged.activeOrderKey;
      }
    } else if (
      merged.status === ORDER_STATUS.PENDING ||
      merged.status === ORDER_STATUS.ACCEPTED
    ) {
      merged.activeOrderKey = buildActiveOrderKey(
        merged.customerId,
        merged.itemId,
        merged.deliveryDate,
      );
    } else {
      delete merged.activeOrderKey;
    }

    state.items.push(merged);

    return merged;
  }

  function seedMenuItemBase() {
    return {
      _id: new ObjectId(MENU_ITEM_ID),
      itemName: 'Margherita',
      category: 'Classic Pizzas',
      description: 'Tomato, mozzarella and basil.',
      price: 12.5,
      location: 'Downtown',
      images: [IMAGE_URL],
      status: MENU_STATUS.APPROVED,
      isAvailable: true,
    };
  }

  const collection = {
    state,
    seedMenuItem,
    seedOrder,

    async findOne(filter, options) {
      record('findOne', { filter, options });

      const found = state.items.find((item) => matches(filter, item)) ?? null;

      return found ? applyProjection(found, options?.projection) : null;
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

              if (a instanceof Date && b instanceof Date) {
                if (a.getTime() !== b.getTime()) {
                  return a.getTime() < b.getTime() ? -direction : direction;
                }
              } else if (typeof a === 'number' && typeof b === 'number') {
                if (a !== b) {
                  return a < b ? -direction : direction;
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

    async insertOne(document) {
      record('insertOne', { document });

      if (
        kind === 'orders' &&
        document.activeOrderKey &&
        state.items.some((item) => item.activeOrderKey === document.activeOrderKey)
      ) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }

      const stored = { ...document, _id: document._id ?? new ObjectId() };
      state.items.push(stored);

      return { insertedId: stored._id };
    },

    async updateOne(filter, update) {
      record('updateOne', { filter, update });

      const item = state.items.find((candidate) => matches(filter, candidate));

      if (!item) {
        return { matchedCount: 0 };
      }

      if (update.$set) {
        Object.assign(item, update.$set);
      }

      if (update.$unset) {
        for (const field of Object.keys(update.$unset)) {
          delete item[field];
        }
      }

      return { matchedCount: 1 };
    },
  };

  return collection;
}

let fakeOrders;
let fakeMenu;
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

function callEndpoint(endpoint, token) {
  const options = { method: endpoint.method, headers: {} };

  if (token) {
    options.headers.Authorization = `Bearer ${token}`;
  }

  if (endpoint.body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(endpoint.body);
  }

  return request(endpoint.path, options);
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

function validOrderBody(overrides = {}) {
  return {
    itemId: MENU_ITEM_ID,
    deliveryDate: DELIVERY_DATE,
    deliveryAddress: '123 Main Street',
    additionalMessage: 'Leave at the door.',
    ...overrides,
  };
}

before(async () => {
  console.error = () => {};
  fakeOrders = createFakeCollection('orders');
  fakeMenu = createFakeCollection('menu');

  const authenticate = createAuthenticate(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      verifyToken: async (token) => {
        const subject = TOKEN_SUBJECTS[token];

        if (!subject) {
          throw new Error('invalid test token');
        }

        return { sub: subject, sid: subject, role: TOKEN_CLAIM_ROLES[token] };
      },
      findUser: async (userId) => users.get(userId) ?? null,
      findSession: findActiveTestSession,
    },
  );

  const orderService = createOrderService({
    ordersCollection: () => fakeOrders,
    menuItemsCollection: () => fakeMenu,
    now: () => FIXED_NOW,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/orders', createCustomerOrderRoutes({}, { authenticate, orderService }));
  app.use('/api/vendor/orders', createVendorOrderRoutes({}, { authenticate, orderService }));
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  const freshOrders = createFakeCollection('orders');
  const freshMenu = createFakeCollection('menu');

  fakeOrders.state.items = freshOrders.state.items;
  fakeOrders.state.calls = freshOrders.state.calls;
  fakeMenu.state.items = freshMenu.state.items;
  fakeMenu.state.calls = freshMenu.state.calls;

  fakeMenu.seedMenuItem();
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('customer order endpoints require authentication and a customer database role', async () => {
  const endpoints = [
    { method: 'POST', path: '/api/orders', body: validOrderBody() },
    { method: 'GET', path: '/api/orders/mine' },
    { method: 'GET', path: `/api/orders/${ORDER_ID}` },
    { method: 'PATCH', path: `/api/orders/${ORDER_ID}/cancel` },
  ];

  for (const endpoint of endpoints) {
    await expectStatus(await callEndpoint(endpoint, null), 401, 'UNAUTHORIZED');

    for (const token of ['vendor-token', 'other-vendor-token', 'admin-token']) {
      await expectStatus(await callEndpoint(endpoint, token), 403, 'FORBIDDEN');
    }
  }

  assert.equal(fakeOrders.state.calls.length, 0);
  assert.equal(fakeMenu.state.calls.length, 0);
});

test('vendor order endpoints require authentication and a vendor database role', async () => {
  const endpoints = [
    { method: 'GET', path: '/api/vendor/orders' },
    {
      method: 'PATCH',
      path: `/api/vendor/orders/${ORDER_ID}/status`,
      body: { status: ORDER_STATUS.ACCEPTED },
    },
  ];

  for (const endpoint of endpoints) {
    await expectStatus(await callEndpoint(endpoint, null), 401, 'UNAUTHORIZED');

    for (const token of ['customer-token', 'other-customer-token', 'admin-token']) {
      await expectStatus(await callEndpoint(endpoint, token), 403, 'FORBIDDEN');
    }

    for (const token of ['vendor-token', 'other-vendor-token']) {
      const response = await callEndpoint(endpoint, token);
      assert.notEqual(response.status, 403);
      assert.notEqual(response.status, 401);
    }
  }
});

test('a customer can place an order with server-owned values and an immutable snapshot', async () => {
  const response = await sendJson('POST', '/api/orders', 'customer-token', validOrderBody());
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.order.customerId, CUSTOMER_ID);
  assert.equal(body.order.vendorId, VENDOR_ID);
  assert.equal(body.order.itemId, MENU_ITEM_ID);
  assert.equal(body.order.status, ORDER_STATUS.PENDING);
  assert.equal(body.order.price, 12.5);
  assert.equal(body.order.deliveryDate, DELIVERY_DATE);
  assert.equal(body.order.deliveryAddress, '123 Main Street');
  assert.equal(body.order.additionalMessage, 'Leave at the door.');
  assert.deepEqual(body.order.createdAt, FIXED_NOW.toISOString());
  assert.deepEqual(body.order.updatedAt, FIXED_NOW.toISOString());
  assert.equal(body.order.itemSnapshot.itemName, 'Margherita');
  assert.equal(body.order.itemSnapshot.price, 12.5);
  assert.equal(body.order.itemSnapshot.menuStatus, MENU_STATUS.APPROVED);
  assert.deepEqual(body.order.itemSnapshot.images, [IMAGE_URL]);
  assert.equal(Object.hasOwn(body.order.itemSnapshot, 'passwordHash'), false);
  assert.equal(Object.hasOwn(body.order, 'activeOrderKey'), false);

  const stored = fakeOrders.state.items[0];

  assert.equal(stored.status, ORDER_STATUS.PENDING);
  assert.equal(stored.activeOrderKey, buildActiveOrderKey(CUSTOMER_ID, MENU_ITEM_ID, DELIVERY_DATE));
  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'insertOne').length, 1);
});

test('hexadecimal item ids are normalized so case variants cannot bypass duplicates', async () => {
  const uppercaseId = MENU_ITEM_ID.toUpperCase();
  const created = await sendJson(
    'POST',
    '/api/orders',
    'customer-token',
    validOrderBody({ itemId: uppercaseId }),
  );

  assert.equal(created.status, 201);
  const body = await created.json();

  assert.equal(body.order.itemId, MENU_ITEM_ID);
  assert.equal(
    fakeOrders.state.items[0].activeOrderKey,
    buildActiveOrderKey(CUSTOMER_ID, MENU_ITEM_ID, DELIVERY_DATE),
  );

  await expectStatus(
    await sendJson('POST', '/api/orders', 'customer-token', validOrderBody()),
    409,
    'ORDER_ALREADY_ACTIVE',
  );
});

test('order creation rejects every server-owned or client-forged field', async () => {
  const reservedValues = {
    customerId: OTHER_CUSTOMER_ID,
    vendorId: OTHER_VENDOR_ID,
    price: 1,
    status: ORDER_STATUS.ACCEPTED,
    itemSnapshot: {},
    activeOrderKey: 'forged',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    id: 'forged',
    _id: 'forged',
    role: 'admin',
    subscriptionPlan: 'premium',
    subscriptionStatus: 'active',
    subscriptionExpiresAt: '2099-01-01T00:00:00.000Z',
  };

  for (const [field, value] of Object.entries(reservedValues)) {
    const body = { ...validOrderBody(), [field]: value };
    const error = await expectStatus(
      await sendJson('POST', '/api/orders', 'customer-token', body),
      400,
      'FORBIDDEN_FIELD',
    );

    assert.match(error.message, new RegExp(field));
  }

  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('order creation rejects unknown fields and malformed item ids', async () => {
  const badBodies = [
    { ...validOrderBody(), surprise: true },
    { ...validOrderBody(), itemId: 'not-an-id' },
    { ...validOrderBody(), itemId: '65c00000000000000000000zz' },
  ];

  for (const body of badBodies) {
    await expectStatus(
      await sendJson('POST', '/api/orders', 'customer-token', body),
      400,
      'VALIDATION_ERROR',
    );
  }

  const withoutItem = validOrderBody();
  delete withoutItem.itemId;
  await expectStatus(
    await sendJson('POST', '/api/orders', 'customer-token', withoutItem),
    400,
    'VALIDATION_ERROR',
  );
  assert.equal(fakeOrders.state.calls.length, 0);
});

test('missing, unapproved and unavailable menu items cannot be ordered', async () => {
  await expectStatus(
    await sendJson('POST', '/api/orders', 'customer-token', {
      ...validOrderBody(),
      itemId: MISSING_ID,
    }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );

  const menuItem = fakeMenu.state.items[0];

  for (const change of [
    { status: MENU_STATUS.PENDING, isAvailable: true },
    { status: MENU_STATUS.REJECTED, isAvailable: true },
    { status: MENU_STATUS.INACTIVE, isAvailable: true },
    { status: MENU_STATUS.APPROVED, isAvailable: false },
  ]) {
    Object.assign(menuItem, change);

    await expectStatus(
      await sendJson('POST', '/api/orders', 'customer-token', validOrderBody()),
      409,
      'MENU_ITEM_NOT_ORDERABLE',
    );
  }

  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('a customer cannot order a menu item owned by that same user id', async () => {
  fakeMenu.state.items[0].vendorId = CUSTOMER_ID;

  const error = await expectStatus(
    await sendJson('POST', '/api/orders', 'customer-token', validOrderBody()),
    403,
    'FORBIDDEN',
  );

  assert.match(error.message, /own menu item/);
  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('invalid delivery details are rejected before any write', async () => {
  const badBodies = [
    { deliveryDate: '01-12-2026' },
    { deliveryDate: '2026-02-30' },
    { deliveryDate: '2026-13-01' },
    { deliveryDate: 20261201 },
    { deliveryAddress: '' },
    { deliveryAddress: '   ' },
    { deliveryAddress: 'x'.repeat(301) },
    { additionalMessage: 'x'.repeat(501) },
    { additionalMessage: 'first line\nsecond line' },
  ];

  for (const change of badBodies) {
    await expectStatus(
      await sendJson('POST', '/api/orders', 'customer-token', validOrderBody(change)),
      400,
      'VALIDATION_ERROR',
    );
  }

  const withoutAddress = validOrderBody();
  delete withoutAddress.deliveryAddress;
  await expectStatus(
    await sendJson('POST', '/api/orders', 'customer-token', withoutAddress),
    400,
    'VALIDATION_ERROR',
  );
  assert.equal(fakeOrders.state.calls.length, 0);
});

test('duplicate pending or accepted orders are rejected for the same item and date', async () => {
  for (const status of [ORDER_STATUS.PENDING, ORDER_STATUS.ACCEPTED]) {
    const before = fakeOrders.state.items.length;
    fakeOrders.seedOrder({ _id: new ObjectId(), status });

    await expectStatus(
      await sendJson('POST', '/api/orders', 'customer-token', validOrderBody()),
      409,
      'ORDER_ALREADY_ACTIVE',
    );

    assert.equal(fakeOrders.state.items.length, before + 1);
  }

  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('a duplicate-key race is translated into a clean 409 response', async () => {
  const racingOrders = {
    async findOne() {
      return null;
    },
    async insertOne() {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    },
  };
  const service = createOrderService({
    ordersCollection: racingOrders,
    menuItemsCollection: () => fakeMenu,
    now: () => FIXED_NOW,
  });

  await assert.rejects(
    () => service.create(CUSTOMER_ID, validOrderBody()),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'ORDER_ALREADY_ACTIVE');
      return true;
    },
  );
});

test('rejection releases the duplicate key and allows a fresh order', async () => {
  fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  const decision = await sendJson(
    'PATCH',
    `/api/vendor/orders/${ORDER_ID}/status`,
    'vendor-token',
    { status: ORDER_STATUS.REJECTED },
  );

  assert.equal(decision.status, 200);
  assert.deepEqual((await decision.json()).order.status, ORDER_STATUS.REJECTED);

  const retry = await sendJson('POST', '/api/orders', 'customer-token', validOrderBody());

  assert.equal(retry.status, 201);
  assert.equal(fakeOrders.state.items.filter((item) => item.status === ORDER_STATUS.PENDING).length, 1);
  assert.equal(Object.hasOwn(fakeOrders.state.items[0], 'activeOrderKey'), false);
});

test('cancellation releases the duplicate key and allows a fresh order', async () => {
  fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  const cancelled = await bearer(`/api/orders/${ORDER_ID}/cancel`, 'customer-token', {
    method: 'PATCH',
  });

  assert.equal(cancelled.status, 200);

  const retry = await sendJson('POST', '/api/orders', 'customer-token', validOrderBody());

  assert.equal(retry.status, 201);
  assert.equal(fakeOrders.state.items.filter((item) => item.status === ORDER_STATUS.PENDING).length, 1);
});

test('later menu edits do not change an existing order snapshot', async () => {
  const created = await sendJson('POST', '/api/orders', 'customer-token', validOrderBody());
  assert.equal(created.status, 201);
  const createdOrder = (await created.json()).order;

  Object.assign(fakeMenu.state.items[0], {
    itemName: 'Edited Pizza',
    price: 99,
    images: ['https://i.ibb.co/test/edited.png'],
  });

  const response = await bearer(`/api/orders/${createdOrder.id}`, 'customer-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.order.itemSnapshot.itemName, 'Margherita');
  assert.equal(body.order.itemSnapshot.price, 12.5);
  assert.deepEqual(body.order.itemSnapshot.images, [IMAGE_URL]);
  assert.equal(body.order.price, 12.5);
});

test('customer order listing is owned, paginated and uses MongoDB skip/limit', async () => {
  fakeOrders.seedOrder({
    _id: new ObjectId(ORDER_ID),
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  });
  fakeOrders.seedOrder({
    _id: new ObjectId(OTHER_ORDER_ID),
    itemId: OTHER_MENU_ITEM_ID,
    deliveryDate: LATER_DELIVERY_DATE,
    createdAt: new Date(Date.UTC(2026, 0, 2)),
  });
  fakeOrders.seedOrder({
    _id: new ObjectId(),
    customerId: OTHER_CUSTOMER_ID,
    createdAt: new Date(Date.UTC(2026, 0, 3)),
  });

  const response = await bearer('/api/orders/mine?page=2&limit=1', 'customer-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, ORDER_ID);
  assert.equal(Object.hasOwn(body.items[0], 'activeOrderKey'), false);
  assert.deepEqual(body.pagination, { page: 2, limit: 1, totalItems: 2, totalPages: 2 });
  assert.deepEqual(fakeOrders.state.calls.find((call) => call.method === 'find').filter, {
    customerId: CUSTOMER_ID,
  });
  assert.equal(fakeOrders.state.calls.find((call) => call.method === 'skip').count, 1);
  assert.equal(fakeOrders.state.calls.find((call) => call.method === 'limit').count, 1);
});

test('customer order listing handles empty results and invalid queries', async () => {
  fakeOrders.seedOrder({ _id: new ObjectId(), customerId: OTHER_CUSTOMER_ID });

  const empty = await bearer('/api/orders/mine', 'customer-token');
  const body = await empty.json();

  assert.equal(empty.status, 200);
  assert.deepEqual(body.items, []);
  assert.deepEqual(body.pagination, { page: 1, limit: 12, totalItems: 0, totalPages: 0 });

  const callsBefore = fakeOrders.state.calls.length;
  const badPaths = [
    '/api/orders/mine?page=0',
    '/api/orders/mine?limit=500',
    '/api/orders/mine?status=pending',
    '/api/orders/mine?where[$ne]=null',
    '/api/orders/mine?unknown=1',
  ];

  for (const path of badPaths) {
    await expectStatus(await bearer(path, 'customer-token'), 400, 'VALIDATION_ERROR');
  }

  assert.equal(fakeOrders.state.calls.length, callsBefore);
});

test('a customer can read only their own order details', async () => {
  fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  const own = await bearer(`/api/orders/${ORDER_ID}`, 'customer-token');
  assert.equal(own.status, 200);
  assert.equal((await own.json()).order.id, ORDER_ID);

  fakeOrders.seedOrder({ _id: new ObjectId(OTHER_ORDER_ID), customerId: OTHER_CUSTOMER_ID });

  const other = await bearer(`/api/orders/${OTHER_ORDER_ID}`, 'customer-token');
  const error = await expectStatus(other, 404, 'ORDER_NOT_FOUND');
  assert.equal(error.message, 'Order not found.');

  await expectStatus(
    await bearer('/api/orders/not-an-id', 'customer-token'),
    400,
    'INVALID_ORDER_ID',
  );
});

test('a customer can cancel only their own pending order', async () => {
  const target = fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  const response = await bearer(`/api/orders/${ORDER_ID}/cancel`, 'customer-token', {
    method: 'PATCH',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.order.status, ORDER_STATUS.CANCELLED);
  assert.deepEqual(body.order.updatedAt, FIXED_NOW.toISOString());
  assert.equal(Object.hasOwn(body.order, 'activeOrderKey'), false);
  assert.equal(target.status, ORDER_STATUS.CANCELLED);
  assert.equal(Object.hasOwn(target, 'activeOrderKey'), false);

  const update = fakeOrders.state.calls.find((call) => call.method === 'updateOne');

  assert.equal(String(update.filter._id), ORDER_ID);
  assert.equal(update.filter.customerId, CUSTOMER_ID);
  assert.equal(update.filter.status, ORDER_STATUS.PENDING);
  assert.deepEqual(update.update.$set, {
    status: ORDER_STATUS.CANCELLED,
    updatedAt: FIXED_NOW,
  });
  assert.deepEqual(update.update.$unset, { activeOrderKey: '' });
});

test('accepted, rejected and cancelled orders cannot be cancelled again', async () => {
  const target = fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  for (const status of [
    ORDER_STATUS.ACCEPTED,
    ORDER_STATUS.REJECTED,
    ORDER_STATUS.CANCELLED,
  ]) {
    target.status = status;
    const error = await expectStatus(
      await bearer(`/api/orders/${ORDER_ID}/cancel`, 'customer-token', { method: 'PATCH' }),
      409,
      'ORDER_NOT_CANCELLABLE',
    );
    assert.equal(error.message, 'Only pending orders can be cancelled.');
  }

  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'updateOne').length, 0);
});

test('cancellation validation protects ownership, ids and vendor-controlled status', async () => {
  fakeOrders.seedOrder({ _id: new ObjectId(OTHER_ORDER_ID), customerId: OTHER_CUSTOMER_ID });

  await expectStatus(
    await bearer(`/api/orders/${OTHER_ORDER_ID}/cancel`, 'customer-token', { method: 'PATCH' }),
    404,
    'ORDER_NOT_FOUND',
  );
  await expectStatus(
    await bearer('/api/orders/not-an-id/cancel', 'customer-token', { method: 'PATCH' }),
    400,
    'INVALID_ORDER_ID',
  );

  const callsBefore = fakeOrders.state.calls.length;
  await expectStatus(
    await sendJson('PATCH', `/api/orders/${ORDER_ID}/cancel`, 'customer-token', {
      status: ORDER_STATUS.ACCEPTED,
    }),
    400,
    'VALIDATION_ERROR',
  );
  assert.equal(fakeOrders.state.calls.length, callsBefore);
});

test('vendor order listing is scoped to the vendor with optional status filtering', async () => {
  fakeOrders.seedOrder({
    _id: new ObjectId(ORDER_ID),
    status: ORDER_STATUS.PENDING,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  });
  fakeOrders.seedOrder({
    _id: new ObjectId(OTHER_ORDER_ID),
    status: ORDER_STATUS.ACCEPTED,
    itemId: OTHER_MENU_ITEM_ID,
    createdAt: new Date(Date.UTC(2026, 0, 2)),
  });
  fakeOrders.seedOrder({
    _id: new ObjectId(),
    vendorId: OTHER_VENDOR_ID,
    createdAt: new Date(Date.UTC(2026, 0, 3)),
  });

  const all = await bearer('/api/vendor/orders', 'vendor-token');
  const allBody = await all.json();

  assert.equal(all.status, 200);
  assert.deepEqual(allBody.items.map((item) => item.id), [OTHER_ORDER_ID, ORDER_ID]);
  assert.deepEqual(
    fakeOrders.state.calls.find((call) => call.method === 'find').filter,
    { vendorId: VENDOR_ID },
  );

  const filtered = await bearer('/api/vendor/orders?status=pending&page=2&limit=1', 'vendor-token');
  const filteredBody = await filtered.json();

  assert.equal(filtered.status, 200);
  assert.deepEqual(filteredBody.items, []);
  assert.deepEqual(filteredBody.pagination, {
    page: 2,
    limit: 1,
    totalItems: 1,
    totalPages: 1,
  });
  assert.deepEqual(
    fakeOrders.state.calls.filter((call) => call.method === 'find').at(-1).filter,
    { vendorId: VENDOR_ID, status: ORDER_STATUS.PENDING },
  );
  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'skip').at(-1).count, 1);
});

test('vendor order listing rejects invalid queries', async () => {
  const callsBefore = fakeOrders.state.calls.length;
  const badPaths = [
    '/api/vendor/orders?status=unknown',
    '/api/vendor/orders?page=0',
    '/api/vendor/orders?limit=500',
    '/api/vendor/orders?customerId=someone-else',
    '/api/vendor/orders?where[$ne]=null',
  ];

  for (const path of badPaths) {
    await expectStatus(await bearer(path, 'vendor-token'), 400, 'VALIDATION_ERROR');
  }

  assert.equal(fakeOrders.state.calls.length, callsBefore);
});

test('a vendor can accept a pending order and it remains active', async () => {
  const target = fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });
  const key = target.activeOrderKey;

  const response = await sendJson(
    'PATCH',
    `/api/vendor/orders/${ORDER_ID}/status`,
    'vendor-token',
    { status: ORDER_STATUS.ACCEPTED },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.order.status, ORDER_STATUS.ACCEPTED);
  assert.deepEqual(body.order.updatedAt, FIXED_NOW.toISOString());
  assert.equal(Object.hasOwn(body.order, 'activeOrderKey'), false);
  assert.equal(target.activeOrderKey, key);

  const update = fakeOrders.state.calls.find((call) => call.method === 'updateOne');

  assert.equal(String(update.filter._id), ORDER_ID);
  assert.equal(update.filter.vendorId, VENDOR_ID);
  assert.equal(update.filter.status, ORDER_STATUS.PENDING);
  assert.deepEqual(update.update.$set, {
    status: ORDER_STATUS.ACCEPTED,
    updatedAt: FIXED_NOW,
  });
  assert.equal(Object.hasOwn(update.update, '$unset'), false);
});

test('a vendor can reject a pending order and release its duplicate key', async () => {
  const target = fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  const response = await sendJson(
    'PATCH',
    `/api/vendor/orders/${ORDER_ID}/status`,
    'vendor-token',
    { status: ORDER_STATUS.REJECTED },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.status, ORDER_STATUS.REJECTED);
  assert.equal(target.status, ORDER_STATUS.REJECTED);
  assert.equal(Object.hasOwn(target, 'activeOrderKey'), false);

  const update = fakeOrders.state.calls.find((call) => call.method === 'updateOne');

  assert.equal(update.update.$set.status, ORDER_STATUS.REJECTED);
  assert.deepEqual(update.update.$unset, { activeOrderKey: '' });
});

test('non-pending orders cannot be processed twice', async () => {
  const target = fakeOrders.seedOrder({ _id: new ObjectId(ORDER_ID) });

  for (const status of [
    ORDER_STATUS.ACCEPTED,
    ORDER_STATUS.REJECTED,
    ORDER_STATUS.CANCELLED,
  ]) {
    target.status = status;

    const error = await expectStatus(
      await sendJson(
        'PATCH',
        `/api/vendor/orders/${ORDER_ID}/status`,
        'vendor-token',
        { status: ORDER_STATUS.ACCEPTED },
      ),
      409,
      'ORDER_NOT_PENDING',
    );
    assert.equal(error.message, 'Only pending orders can be updated.');
  }

  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'updateOne').length, 0);
});

test('a vendor cannot process another vendor order or use a malformed id', async () => {
  fakeOrders.seedOrder({ _id: new ObjectId(OTHER_ORDER_ID), vendorId: OTHER_VENDOR_ID });

  const other = await sendJson(
    'PATCH',
    `/api/vendor/orders/${OTHER_ORDER_ID}/status`,
    'vendor-token',
    { status: ORDER_STATUS.ACCEPTED },
  );
  const error = await expectStatus(other, 404, 'ORDER_NOT_FOUND');
  assert.equal(error.message, 'Order not found.');

  await expectStatus(
    await sendJson(
      'PATCH',
      '/api/vendor/orders/not-an-id/status',
      'vendor-token',
      { status: ORDER_STATUS.REJECTED },
    ),
    400,
    'INVALID_ORDER_ID',
  );
  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'updateOne').length, 0);
});

test('vendor status bodies reject invalid, reserved and unknown fields', async () => {
  const badBodies = [
    { status: ORDER_STATUS.PENDING },
    { status: ORDER_STATUS.CANCELLED },
    { status: 'approved' },
    { decision: ORDER_STATUS.ACCEPTED },
    { status: ORDER_STATUS.ACCEPTED, customerId: OTHER_CUSTOMER_ID },
    { status: ORDER_STATUS.ACCEPTED, vendorId: OTHER_VENDOR_ID },
    { status: ORDER_STATUS.ACCEPTED, price: 1 },
    { status: ORDER_STATUS.ACCEPTED, statusNote: 'x' },
    { status: ORDER_STATUS.ACCEPTED, subscriptionPlan: 'premium' },
  ];

  for (const body of badBodies) {
    const reserved = Object.keys(body).some(
      (key) =>
        key !== 'status' &&
        key !== 'decision' &&
        key !== 'statusNote',
    );
    await expectStatus(
      await sendJson(
        'PATCH',
        `/api/vendor/orders/${ORDER_ID}/status`,
        'vendor-token',
        body,
      ),
      400,
      reserved ? 'FORBIDDEN_FIELD' : 'VALIDATION_ERROR',
    );
  }

  assert.equal(fakeOrders.state.calls.filter((call) => call.method === 'updateOne').length, 0);
});
