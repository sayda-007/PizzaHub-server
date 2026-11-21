import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { ObjectId } from 'mongodb';

import { createAuthenticate } from '../middlewares/authenticate.js';
import { createErrorHandler } from '../middlewares/error.js';
import { createMenuRoutes } from '../modules/menu/menu.routes.js';
import {
  FREE_MENU_ITEM_LIMIT,
  createMenuService,
} from '../modules/menu/menu.service.js';
import { MENU_STATUS } from '../modules/menu/menu.validator.js';
import {
  MAX_IMAGE_FILE_SIZE_BYTES,
  validateUploadedFiles,
} from '../services/imgbb.js';

// Fake ids and values only. This suite never reads .env or contacts Atlas.
const AUTH_URL = 'https://auth.example.test';
const CUSTOMER_ID = '65b000000000000000000001';
const VENDOR_ID = '65b000000000000000000002';
const OTHER_VENDOR_ID = '65b000000000000000000003';
const PREMIUM_VENDOR_ID = '65b000000000000000000004';
const EXPIRED_VENDOR_ID = '65b000000000000000000005';
const INACTIVE_STATUS_VENDOR_ID = '65b000000000000000000006';
const ITEM_ID = '65c000000000000000000001';
const OTHER_ITEM_ID = '65c000000000000000000002';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const FUTURE_DATE = new Date('2099-01-01T00:00:00.000Z');
const IMAGE_URL = 'https://i.ibb.co/test/pizza.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TOKEN_SUBJECTS = Object.freeze({
  'customer-token': CUSTOMER_ID,
  'vendor-token': VENDOR_ID,
  'premium-token': PREMIUM_VENDOR_ID,
  'expired-premium-token': EXPIRED_VENDOR_ID,
  'inactive-status-token': INACTIVE_STATUS_VENDOR_ID,
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
    PREMIUM_VENDOR_ID,
    {
      _id: new ObjectId(PREMIUM_VENDOR_ID),
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'premium',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: FUTURE_DATE,
    },
  ],
  [
    EXPIRED_VENDOR_ID,
    {
      _id: new ObjectId(EXPIRED_VENDOR_ID),
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'premium',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: FIXED_DATE,
    },
  ],
  [
    INACTIVE_STATUS_VENDOR_ID,
    {
      _id: new ObjectId(INACTIVE_STATUS_VENDOR_ID),
      role: 'vendor',
      isBlocked: false,
      subscriptionPlan: 'premium',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: FUTURE_DATE,
    },
  ],
]);

function valuesEqual(left, right) {
  if (left instanceof ObjectId || right instanceof ObjectId) {
    return String(left) === String(right);
  }

  return left === right;
}

/** Small fake-filter evaluator for the operators used by menu queries. */
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

  const result = { ...item };

  for (const [field, include] of Object.entries(projection)) {
    if (include === 0) {
      delete result[field];
    }
  }

  return result;
}

function createFakeCollection() {
  const state = { items: [], calls: [], nextId: 1, failUpdate: false };

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
      status: 'approved',
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

    async insertOne(document) {
      record('insertOne', { document });
      const _id = new ObjectId(`65c0000000000000000000${String(state.nextId).padStart(2, '0')}`);
      state.nextId += 1;
      const saved = { ...document, _id };
      state.items.push(saved);

      return { acknowledged: true, insertedId: _id };
    },

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

      if (state.failUpdate) {
        throw new Error('database connection details must not leak');
      }

      const item = state.items.find((candidate) => matches(filter, candidate));

      if (!item) {
        return { matchedCount: 0 };
      }

      Object.assign(item, update.$set);

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

function seedSlotItems(collection, count, overrides = {}) {
  return Array.from({ length: count }, () => {
    const _id = new ObjectId();

    collection.seedItem({
      _id,
      status: MENU_STATUS.APPROVED,
      isAvailable: true,
      ...overrides,
    });

    return _id;
  });
}

function seedPublicItem(overrides = {}) {
  return fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.APPROVED,
    isAvailable: true,
    ...overrides,
  });
}

let fakeCollection;
let uploadCalls = [];
let failUpload = false;
let server;
let baseUrl;
const originalConsoleError = console.error;

function validFields(overrides = {}) {
  return {
    itemName: '  Test Pizza  ',
    category: 'Classic Pizzas',
    description: 'A delicious test pizza.',
    price: '12.50',
    location: 'South Campus',
    ...overrides,
  };
}

function addMultipartFields(form, fields) {
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
}

function imageBlob(name = 'pizza.png', type = 'image/png', size = 32) {
  const buffer = Buffer.concat([
    PNG_SIGNATURE,
    Buffer.alloc(Math.max(0, size - PNG_SIGNATURE.length)),
  ]);

  return new Blob([buffer], { type });
}

function createForm(fields = validFields(), files = [imageBlob()]) {
  const form = new FormData();
  addMultipartFields(form, fields);

  for (const file of files) {
    form.append('images', file, file.name ?? 'pizza.png');
  }

  return form;
}

function createItem(token, fields = validFields()) {
  return bearer('/api/menu', token, {
    method: 'POST',
    body: createForm(fields),
  });
}

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

function bearer(path, token, options = {}) {
  return request(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

function jsonRequest(method, path, token, body) {
  return bearer(path, token, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  const authenticate = createAuthenticate(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      verifyToken: async (token) => {
        const subject = TOKEN_SUBJECTS[token];

        if (!subject) {
          throw new Error('invalid test token');
        }

        // Deliberately claim Premium in the JWT. authenticate() must ignore
        // these and use the fake MongoDB user map above instead.
        return {
          sub: subject,
          role: 'vendor',
          subscriptionPlan: 'premium',
          subscriptionStatus: 'active',
          subscriptionExpiresAt: FUTURE_DATE.toISOString(),
        };
      },
      findUser: async (userId) => users.get(userId) ?? null,
    },
  );

  const imageUploader = {
    async uploadImages(files) {
      uploadCalls.push(files);

      if (failUpload) {
        throw new Error('imgbb key imgbb-secret-should-not-leak');
      }

      return files.map((_file, index) => `${IMAGE_URL}?image=${index + 1}`);
    },
  };

  const menuService = createMenuService({
    collection: () => fakeCollection,
    now: () => FIXED_DATE,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/menu', createMenuRoutes({}, { authenticate, menuService, imageUploader }));
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  const fresh = createFakeCollection();
  fakeCollection.state.items = fresh.state.items;
  fakeCollection.state.calls = fresh.state.calls;
  fakeCollection.state.nextId = fresh.state.nextId;
  fakeCollection.state.failUpdate = false;

  uploadCalls = [];
  failUpload = false;
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/menu is public and returns only approved available items', async () => {
  const visible = seedPublicItem({ itemName: 'Visible Pizza' });
  seedPublicItem({ itemName: 'Pending Pizza', status: MENU_STATUS.PENDING });
  seedPublicItem({ itemName: 'Rejected Pizza', status: MENU_STATUS.REJECTED });
  seedPublicItem({ itemName: 'Inactive Pizza', status: MENU_STATUS.INACTIVE });
  seedPublicItem({ itemName: 'Unavailable Pizza', isAvailable: false });

  const response = await request('/api/menu');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, String(visible._id));
  assert.equal(body.items[0].itemName, 'Visible Pizza');

  for (const field of ['vendorId', 'status', 'isAvailable']) {
    assert.equal(Object.hasOwn(body.items[0], field), false);
  }

  assert.deepEqual(body.pagination, {
    page: 1,
    limit: 12,
    totalItems: 1,
    totalPages: 1,
  });

  const findCall = fakeCollection.state.calls.find((call) => call.method === 'find');

  assert.deepEqual(findCall.filter, {
    status: MENU_STATUS.APPROVED,
    isAvailable: true,
  });
  assert.deepEqual(
    fakeCollection.state.calls.find((call) => call.method === 'project').projection,
    { vendorId: 0, status: 0, isAvailable: 0 },
  );
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'countDocuments').length, 1);
});

test('public search matches item names and descriptions case-insensitively', async () => {
  const byName = seedPublicItem({ itemName: 'Pepperoni Feast', description: 'Classic' });
  const byDescription = seedPublicItem({
    itemName: 'Veggie Delight',
    description: 'Pepperoni surprise',
  });
  seedPublicItem({ itemName: 'Plain Cheese', description: 'Simple' });

  const response = await request(`/api/menu?search=${encodeURIComponent('pepperoni')}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.id).sort(),
    [String(byName._id), String(byDescription._id)].sort(),
  );

  const findCall = fakeCollection.state.calls.find((call) => call.method === 'find');

  assert.deepEqual(findCall.filter.$or, [
    { itemName: { $regex: 'pepperoni', $options: 'i' } },
    { description: { $regex: 'pepperoni', $options: 'i' } },
  ]);
});

test('search text is regex-escaped and cannot inject MongoDB operators', async () => {
  const literal = seedPublicItem({ itemName: 'Pizza (Special)', description: 'literal' });
  seedPublicItem({ itemName: 'Pizza Special', description: 'without parentheses' });
  seedPublicItem({ itemName: 'Anything', description: 'regex demo' });

  const literalResponse = await request(
    `/api/menu?search=${encodeURIComponent('Pizza (Special)')}`,
  );
  const literalBody = await literalResponse.json();

  assert.equal(literalResponse.status, 200);
  assert.deepEqual(literalBody.items.map((item) => item.id), [String(literal._id)]);

  const wildcardResponse = await request(`/api/menu?search=${encodeURIComponent('.*')}`);
  const wildcardBody = await wildcardResponse.json();

  assert.equal(wildcardResponse.status, 200);
  assert.deepEqual(wildcardBody.items, []);

  const findCalls = fakeCollection.state.calls.filter((call) => call.method === 'find');

  assert.deepEqual(findCalls[1].filter.$or[0].itemName, {
    $regex: '\\.\\*',
    $options: 'i',
  });
  assert.equal(Object.hasOwn(findCalls[1].filter, 'where'), false);
  assert.equal(Object.hasOwn(findCalls[1].filter, '$where'), false);
});

test('public category and location filters are validated and applied in MongoDB', async () => {
  const classic = seedPublicItem({
    itemName: 'Classic One',
    category: 'Classic Pizzas',
    location: 'Downtown',
  });
  const dessert = seedPublicItem({
    itemName: 'Sweet One',
    category: 'Beverages & Desserts',
    location: 'South Campus',
  });

  const categoryResponse = await request(
    `/api/menu?category=${encodeURIComponent('Classic Pizzas')}`,
  );
  const categoryBody = await categoryResponse.json();

  assert.equal(categoryResponse.status, 200);
  assert.deepEqual(categoryBody.items.map((item) => item.id), [String(classic._id)]);

  const locationResponse = await request(
    `/api/menu?location=${encodeURIComponent('South Campus')}`,
  );
  const locationBody = await locationResponse.json();

  assert.equal(locationResponse.status, 200);
  assert.deepEqual(locationBody.items.map((item) => item.id), [String(dessert._id)]);

  const findCalls = fakeCollection.state.calls.filter((call) => call.method === 'find');

  assert.equal(findCalls[0].filter.category, 'Classic Pizzas');
  assert.equal(findCalls[1].filter.location, 'South Campus');
  assert.equal(findCalls[0].filter.status, MENU_STATUS.APPROVED);
  assert.equal(findCalls[0].filter.isAvailable, true);
});

test('public sorting supports newest, price-asc and price-desc', async () => {
  seedPublicItem({
    itemName: 'Oldest Expensive',
    price: 20,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  seedPublicItem({
    itemName: 'Middle Cheapest',
    price: 5,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  seedPublicItem({
    itemName: 'Newest Middle',
    price: 12,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
  });

  async function namesFor(query = '') {
    const response = await request(`/api/menu${query}`);

    assert.equal(response.status, 200);

    return (await response.json()).items.map((item) => item.itemName);
  }

  assert.deepEqual(await namesFor(), ['Newest Middle', 'Middle Cheapest', 'Oldest Expensive']);
  assert.deepEqual(await namesFor('?sort=price-asc'), [
    'Middle Cheapest',
    'Newest Middle',
    'Oldest Expensive',
  ]);
  assert.deepEqual(await namesFor('?sort=price-desc'), [
    'Oldest Expensive',
    'Newest Middle',
    'Middle Cheapest',
  ]);

  const sorts = fakeCollection.state.calls
    .filter((call) => call.method === 'sort')
    .map((call) => call.spec);

  assert.deepEqual(sorts, [
    { createdAt: -1, _id: -1 },
    { price: 1, createdAt: -1, _id: -1 },
    { price: -1, createdAt: -1, _id: -1 },
  ]);
});

test('public pagination returns MongoDB-page results and correct totals', async () => {
  for (let day = 1; day <= 5; day += 1) {
    seedPublicItem({
      itemName: `Item ${day}`,
      price: day,
      createdAt: new Date(Date.UTC(2026, 0, day)),
    });
  }

  const response = await request('/api/menu?page=2&limit=2');
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

test('public pagination handles an empty result set', async () => {
  const response = await request('/api/menu');
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

test('invalid public query parameters are rejected before any database work', async () => {
  const callsBefore = fakeCollection.state.calls.length;
  const badPaths = [
    '/api/menu?sort=highest-price',
    '/api/menu?limit=500',
    '/api/menu?page=-1',
    `/api/menu?category=${encodeURIComponent('Not A Category')}`,
    '/api/menu?where[$ne]=null',
    '/api/menu?search[$ne]=null',
    '/api/menu?unknown=value',
  ];

  for (const path of badPaths) {
    await expectStatus(await request(path), 400, 'VALIDATION_ERROR');
  }

  assert.equal(fakeCollection.state.calls.length, callsBefore);
});

test('the public GET route does not weaken vendor-only menu management routes', async () => {
  seedPublicItem();

  await expectStatus(await request('/api/menu/mine'), 401, 'UNAUTHORIZED');

  const response = await bearer('/api/menu/mine', 'vendor-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.pagination.total, 1);
});

test('unauthenticated vendor menu requests are rejected before upload parsing', async () => {
  const createResponse = await request('/api/menu', {
    method: 'POST',
    body: createForm(),
  });
  await expectStatus(createResponse, 401, 'UNAUTHORIZED');

  await expectStatus(await request('/api/menu/mine'), 401, 'UNAUTHORIZED');
  await expectStatus(
    await request(`/api/menu/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemName: 'New' }),
    }),
    401,
    'UNAUTHORIZED',
  );
  await expectStatus(
    await request(`/api/menu/${ITEM_ID}`, { method: 'DELETE' }),
    401,
    'UNAUTHORIZED',
  );

  assert.equal(uploadCalls.length, 0);
  assert.equal(fakeCollection.state.calls.length, 0);
});

test('customers cannot access any vendor menu route', async () => {
  const createResponse = await bearer('/api/menu', 'customer-token', {
    method: 'POST',
    body: createForm(),
  });
  await expectStatus(createResponse, 403, 'FORBIDDEN');

  await expectStatus(await bearer('/api/menu/mine', 'customer-token'), 403, 'FORBIDDEN');
  await expectStatus(
    await jsonRequest('PATCH', `/api/menu/${ITEM_ID}`, 'customer-token', { itemName: 'New' }),
    403,
    'FORBIDDEN',
  );
  await expectStatus(
    await bearer(`/api/menu/${ITEM_ID}`, 'customer-token', { method: 'DELETE' }),
    403,
    'FORBIDDEN',
  );

  assert.equal(uploadCalls.length, 0);
  assert.equal(fakeCollection.state.calls.length, 0);
});

test('a vendor can create an item with pending status and server-owned fields', async () => {
  const response = await bearer('/api/menu', 'vendor-token', {
    method: 'POST',
    body: createForm(),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.item.vendorId, VENDOR_ID);
  assert.equal(body.item.itemName, 'Test Pizza');
  assert.equal(body.item.price, 12.5);
  assert.equal(body.item.status, 'pending');
  assert.equal(body.item.isAvailable, true);
  assert.deepEqual(body.item.createdAt, FIXED_DATE.toISOString());
  assert.deepEqual(body.item.images, [`${IMAGE_URL}?image=1`]);

  const insert = fakeCollection.state.calls.find((call) => call.method === 'insertOne');
  assert.equal(insert.document.vendorId, VENDOR_ID);
  assert.equal(insert.document.status, 'pending');
  assert.equal(insert.document.isAvailable, true);
  assert.equal(uploadCalls.length, 1);
});

test('a free vendor can create up to three active/reserved items', async () => {
  for (let index = 0; index < FREE_MENU_ITEM_LIMIT; index += 1) {
    const response = await createItem(
      'vendor-token',
      validFields({ itemName: `Pizza ${index + 1}` }),
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.item.status, MENU_STATUS.PENDING);
    assert.equal(body.item.isAvailable, true);
  }

  const inserts = fakeCollection.state.calls.filter((call) => call.method === 'insertOne');

  assert.equal(inserts.length, FREE_MENU_ITEM_LIMIT);

  for (const insert of inserts) {
    assert.equal(insert.document.vendorId, VENDOR_ID);
    assert.equal(insert.document.status, MENU_STATUS.PENDING);
    assert.equal(insert.document.isAvailable, true);
  }
});

test('a free vendor cannot create a fourth active/reserved item', async () => {
  fakeCollection.seedItem({ _id: new ObjectId(), status: MENU_STATUS.PENDING });
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT - 1, { status: MENU_STATUS.APPROVED });

  const body = await expectStatus(await createItem('vendor-token'), 409, 'MENU_ITEM_LIMIT_REACHED');

  assert.match(body.message, /Free plan allows 3 active menu items/);
  assert.equal(uploadCalls.length, 0);
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 0);

  const countCall = fakeCollection.state.calls.find((call) => call.method === 'countDocuments');

  assert.equal(countCall.filter.vendorId, VENDOR_ID);
  assert.deepEqual(countCall.filter.status, {
    $in: [MENU_STATUS.PENDING, MENU_STATUS.APPROVED],
  });
  assert.deepEqual(countCall.filter.isAvailable, { $ne: false });
});

test('an active unexpired premium vendor can create more than three items', async () => {
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT, { vendorId: PREMIUM_VENDOR_ID });

  for (let index = 0; index < 2; index += 1) {
    const response = await createItem(
      'premium-token',
      validFields({ itemName: `Premium Pizza ${index + 1}` }),
    );

    assert.equal(response.status, 201);
  }

  const inserts = fakeCollection.state.calls.filter((call) => call.method === 'insertOne');

  assert.equal(inserts.length, 2);
  assert.equal(uploadCalls.length, 2);

  for (const insert of inserts) {
    assert.equal(insert.document.vendorId, PREMIUM_VENDOR_ID);
  }

  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'countDocuments').length, 0);
});

test('an expired premium subscription is treated as free', async () => {
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT, { vendorId: EXPIRED_VENDOR_ID });

  await expectStatus(await createItem('expired-premium-token'), 409, 'MENU_ITEM_LIMIT_REACHED');

  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('a premium subscription without active status is treated as free', async () => {
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT, {
    vendorId: INACTIVE_STATUS_VENDOR_ID,
  });

  await expectStatus(await createItem('inactive-status-token'), 409, 'MENU_ITEM_LIMIT_REACHED');

  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('unavailable items do not consume a free vendor slot', async () => {
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT - 1);
  seedSlotItems(fakeCollection, 1, { isAvailable: false });

  const response = await createItem('vendor-token');

  assert.equal(response.status, 201);
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 1);
});

test('rejected items do not consume a free vendor slot', async () => {
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT - 1);
  fakeCollection.seedItem({
    _id: new ObjectId(),
    status: MENU_STATUS.REJECTED,
    isAvailable: true,
  });

  const response = await createItem('vendor-token');
  const countCall = fakeCollection.state.calls.find((call) => call.method === 'countDocuments');

  assert.equal(response.status, 201);
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 1);
  assert.deepEqual(countCall.filter.status, {
    $in: [MENU_STATUS.PENDING, MENU_STATUS.APPROVED],
  });
});

test('client-supplied vendorId, status and images fields are rejected', async () => {
  for (const field of [
    'vendorId',
    'status',
    'images',
    'createdAt',
    'isAvailable',
    'subscriptionPlan',
    'subscriptionStatus',
    'subscriptionExpiresAt',
  ]) {
    const response = await bearer('/api/menu', 'vendor-token', {
      method: 'POST',
      body: createForm(validFields({ [field]: 'malicious' })),
    });

    await expectStatus(response, 400, 'FORBIDDEN_FIELD');
  }

  assert.equal(uploadCalls.length, 0);
  assert.equal(fakeCollection.state.calls.length, 0);
});

test('invalid categories and unknown fields are rejected', async () => {
  const badCategory = await bearer('/api/menu', 'vendor-token', {
    method: 'POST',
    body: createForm(validFields({ category: 'Dessert Pizzas' })),
  });
  await expectStatus(badCategory, 400, 'VALIDATION_ERROR');

  const unknown = await bearer('/api/menu', 'vendor-token', {
    method: 'POST',
    body: createForm(validFields({ nickname: 'x' })),
  });
  await expectStatus(unknown, 400, 'VALIDATION_ERROR');

  assert.equal(fakeCollection.state.calls.length, 0);
});

test('invalid prices are rejected', async () => {
  for (const price of ['0', '-5', '12.345', 'abc', '1e3']) {
    const response = await bearer('/api/menu', 'vendor-token', {
      method: 'POST',
      body: createForm(validFields({ price })),
    });

    await expectStatus(response, 400, 'VALIDATION_ERROR');
  }

  assert.equal(fakeCollection.state.calls.length, 0);
});

test('missing images and more than three images are rejected', async () => {
  const missing = await bearer('/api/menu', 'vendor-token', {
    method: 'POST',
    body: createForm(validFields(), []),
  });
  await expectStatus(missing, 400, 'IMAGE_REQUIRED');

  const tooMany = await bearer('/api/menu', 'vendor-token', {
    method: 'POST',
    body: createForm(validFields(), [
      imageBlob('1.png'),
      imageBlob('2.png'),
      imageBlob('3.png'),
      imageBlob('4.png'),
    ]),
  });
  await expectStatus(tooMany, 400, 'TOO_MANY_FILES');

  assert.equal(fakeCollection.state.calls.length, 0);
});

test('invalid file types are rejected before upload', async () => {
  const response = await bearer('/api/menu', 'vendor-token', {
    method: 'POST',
    body: createForm(validFields(), [imageBlob('notes.txt', 'text/plain')]),
  });
  const body = await expectStatus(response, 400, 'INVALID_FILE_TYPE');

  assert.match(body.message, /Only JPEG, PNG, WebP and GIF images are accepted/);
  assert.equal(uploadCalls.length, 0);
  assert.equal(fakeCollection.state.calls.length, 0);
});

test('oversized image buffers are rejected before upload', () => {
  assert.throws(
    () =>
      validateUploadedFiles([
        {
          fieldname: 'images',
          mimetype: 'image/png',
          size: MAX_IMAGE_FILE_SIZE_BYTES + 1,
          buffer: Buffer.alloc(16),
        },
      ]),
    { code: 'FILE_TOO_LARGE' },
  );
});

test('ImgBB upload failures are safe and do not leak credentials', async () => {
  failUpload = true;

  const body = await expectStatus(
    await bearer('/api/menu', 'vendor-token', {
      method: 'POST',
      body: createForm(),
    }),
    500,
    'INTERNAL_SERVER_ERROR',
  );

  assert.equal(body.message, 'An unexpected error occurred.');
  assert.ok(!JSON.stringify(body).includes('imgbb-secret-should-not-leak'));
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('GET /api/menu/mine returns only the authenticated vendor items with pagination', async () => {
  fakeCollection.seedItem({ _id: new ObjectId(ITEM_ID), itemName: 'Vendor One' });
  fakeCollection.seedItem({
    _id: new ObjectId(OTHER_ITEM_ID),
    vendorId: OTHER_VENDOR_ID,
    itemName: 'Other Vendor',
  });
  fakeCollection.seedItem({
    _id: new ObjectId('65c000000000000000000005'),
    itemName: 'Vendor Two',
  });

  const response = await bearer('/api/menu/mine?page=1&limit=1', 'vendor-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].vendorId, VENDOR_ID);
  assert.equal(body.pagination.total, 2);
  assert.equal(body.pagination.page, 1);
  assert.equal(body.pagination.limit, 1);
  assert.equal(body.pagination.totalPages, 2);

  const findCall = fakeCollection.state.calls.find((call) => call.method === 'find');
  assert.deepEqual(findCall.filter, { vendorId: VENDOR_ID });
});

test('invalid pagination query values are rejected', async () => {
  await expectStatus(await bearer('/api/menu/mine?limit=500', 'vendor-token'), 400, 'VALIDATION_ERROR');
  await expectStatus(
    await bearer('/api/menu/mine?where[$ne]=null', 'vendor-token'),
    400,
    'VALIDATION_ERROR',
  );
  assert.equal(fakeCollection.state.calls.length, 0);
});

test('a vendor can update their own item with an explicit $set', async () => {
  fakeCollection.seedItem();

  const response = await jsonRequest('PATCH', `/api/menu/${ITEM_ID}`, 'vendor-token', {
    itemName: '  Updated Pizza  ',
    price: 13.75,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.item.itemName, 'Updated Pizza');
  assert.equal(body.item.price, 13.75);

  const update = fakeCollection.state.calls.find((call) => call.method === 'updateOne');
  assert.equal(update.filter.vendorId, VENDOR_ID);
  assert.equal(String(update.filter._id), ITEM_ID);
  assert.deepEqual(Object.keys(update.update.$set).sort(), ['itemName', 'price', 'updatedAt']);
  assert.deepEqual(update.update.$set.updatedAt, FIXED_DATE);
});

test('a vendor cannot update another vendor item', async () => {
  fakeCollection.seedItem({
    _id: new ObjectId(OTHER_ITEM_ID),
    vendorId: OTHER_VENDOR_ID,
  });

  const body = await expectStatus(
    await jsonRequest('PATCH', `/api/menu/${OTHER_ITEM_ID}`, 'vendor-token', {
      itemName: 'Stolen Pizza',
    }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );

  assert.equal(body.message, 'Menu item not found.');
  const update = fakeCollection.state.calls.find((call) => call.method === 'updateOne');
  assert.equal(update.filter.vendorId, VENDOR_ID);
  assert.equal(fakeCollection.state.items[0].itemName, 'Original Pizza');
});

test('status, vendorId and other reserved fields cannot be patched', async () => {
  fakeCollection.seedItem();

  for (const field of [
    'status',
    'vendorId',
    'createdAt',
    'images',
    '_id',
    'subscriptionPlan',
    'subscriptionStatus',
    'subscriptionExpiresAt',
  ]) {
    const response = await jsonRequest('PATCH', `/api/menu/${ITEM_ID}`, 'vendor-token', {
      [field]: 'malicious',
    });

    await expectStatus(response, 400, 'FORBIDDEN_FIELD');
  }

  assert.equal(fakeCollection.state.calls.length, 0);
});

test('PATCH /api/menu/:id cannot change isAvailable', async () => {
  fakeCollection.seedItem();

  const body = await expectStatus(
    await jsonRequest('PATCH', `/api/menu/${ITEM_ID}`, 'vendor-token', { isAvailable: false }),
    400,
    'FORBIDDEN_FIELD',
  );

  assert.match(body.message, /isAvailable/);
  assert.equal(fakeCollection.state.calls.length, 0);
  assert.equal(fakeCollection.state.items[0].isAvailable, true);
});

test('availability can be toggled only by the owning vendor', async () => {
  fakeCollection.seedItem();

  const first = await bearer(`/api/menu/${ITEM_ID}/availability`, 'vendor-token', {
    method: 'PATCH',
  });
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.item.isAvailable, false);

  const second = await bearer(`/api/menu/${ITEM_ID}/availability`, 'vendor-token', {
    method: 'PATCH',
  });
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.item.isAvailable, true);

  const filters = fakeCollection.state.calls
    .filter((call) => call.method === 'updateOne')
    .map((call) => call.filter);

  for (const filter of filters) {
    assert.equal(filter.vendorId, VENDOR_ID);
    assert.equal(String(filter._id), ITEM_ID);
  }
});

test('reactivating an item is blocked when the free limit is already reached', async () => {
  seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT);
  const targetId = new ObjectId(OTHER_ITEM_ID);
  fakeCollection.seedItem({ _id: targetId, isAvailable: false });

  const body = await expectStatus(
    await bearer(`/api/menu/${targetId}/availability`, 'vendor-token', { method: 'PATCH' }),
    409,
    'MENU_ITEM_LIMIT_REACHED',
  );

  assert.match(body.message, /Free plan allows 3 active menu items/);
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'updateOne').length, 0);
  assert.equal(
    fakeCollection.state.items.find((item) => String(item._id) === String(targetId)).isAvailable,
    false,
  );

  const countCall = fakeCollection.state.calls.find((call) => call.method === 'countDocuments');
  assert.equal(String(countCall.filter._id.$ne), String(targetId));
});

test('general PATCH cannot change availability or bypass the slot limit', async () => {
  const [ownedId] = seedSlotItems(fakeCollection, FREE_MENU_ITEM_LIMIT);

  await expectStatus(
    await jsonRequest('PATCH', `/api/menu/${ownedId}`, 'vendor-token', { isAvailable: false }),
    400,
    'FORBIDDEN_FIELD',
  );

  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'updateOne').length, 0);
  await expectStatus(await createItem('vendor-token'), 409, 'MENU_ITEM_LIMIT_REACHED');
  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'insertOne').length, 0);
});

test('a premium vendor cannot reactivate another vendor item', async () => {
  const targetId = new ObjectId(OTHER_ITEM_ID);
  fakeCollection.seedItem({ _id: targetId, vendorId: VENDOR_ID, isAvailable: false });

  await expectStatus(
    await bearer(`/api/menu/${targetId}/availability`, 'premium-token', { method: 'PATCH' }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );

  assert.equal(fakeCollection.state.calls.filter((call) => call.method === 'updateOne').length, 0);
  assert.equal(
    fakeCollection.state.items.find((item) => String(item._id) === String(targetId)).isAvailable,
    false,
  );
});

test('a vendor cannot toggle or delete another vendor item', async () => {
  fakeCollection.seedItem({
    _id: new ObjectId(OTHER_ITEM_ID),
    vendorId: OTHER_VENDOR_ID,
  });

  await expectStatus(
    await bearer(`/api/menu/${OTHER_ITEM_ID}/availability`, 'vendor-token', { method: 'PATCH' }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );
  await expectStatus(
    await bearer(`/api/menu/${OTHER_ITEM_ID}`, 'vendor-token', { method: 'DELETE' }),
    404,
    'MENU_ITEM_NOT_FOUND',
  );

  const deleteCall = fakeCollection.state.calls.find((call) => call.method === 'deleteOne');
  assert.equal(deleteCall.filter.vendorId, VENDOR_ID);
  assert.equal(fakeCollection.state.items.length, 1);
});

test('a vendor can delete their own item', async () => {
  fakeCollection.seedItem();

  const response = await bearer(`/api/menu/${ITEM_ID}`, 'vendor-token', { method: 'DELETE' });

  assert.equal(response.status, 204);
  assert.equal(fakeCollection.state.items.length, 0);

  const deleteCall = fakeCollection.state.calls.find((call) => call.method === 'deleteOne');
  assert.equal(deleteCall.filter.vendorId, VENDOR_ID);
  assert.equal(String(deleteCall.filter._id), ITEM_ID);
});

test('invalid MongoDB ids are rejected consistently', async () => {
  const paths = [`/api/menu/not-an-id`, `/api/menu/not-an-id/availability`];

  for (const path of paths) {
    await expectStatus(
      await jsonRequest('PATCH', path, 'vendor-token', { itemName: 'New' }),
      400,
      'INVALID_MENU_ID',
    );
  }

  await expectStatus(
    await bearer('/api/menu/not-an-id', 'vendor-token', { method: 'DELETE' }),
    400,
    'INVALID_MENU_ID',
  );

  assert.equal(fakeCollection.state.calls.length, 0);
});

test('database failures reach the centralized generic 500 handler', async () => {
  fakeCollection.seedItem();
  fakeCollection.state.failUpdate = true;

  const body = await expectStatus(
    await jsonRequest('PATCH', `/api/menu/${ITEM_ID}`, 'vendor-token', { itemName: 'New' }),
    500,
    'INTERNAL_SERVER_ERROR',
  );

  assert.equal(body.message, 'An unexpected error occurred.');
  assert.ok(!JSON.stringify(body).includes('database connection details'));
});

test('createMenuRoutes builds its services without injected dependencies', () => {
  const router = createMenuRoutes({ BETTER_AUTH_URL: AUTH_URL });
  assert.equal(typeof router, 'function');
});
