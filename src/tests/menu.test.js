import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { ObjectId } from 'mongodb';

import { createAuthenticate } from '../middlewares/authenticate.js';
import { createErrorHandler } from '../middlewares/error.js';
import { createMenuRoutes } from '../modules/menu/menu.routes.js';
import { createMenuService } from '../modules/menu/menu.service.js';
import {
  MAX_IMAGE_FILE_SIZE_BYTES,
  validateUploadedFiles,
} from '../services/imgbb.js';

// Fake ids and values only. This suite never reads .env or contacts Atlas.
const AUTH_URL = 'https://auth.example.test';
const CUSTOMER_ID = '65b000000000000000000001';
const VENDOR_ID = '65b000000000000000000002';
const OTHER_VENDOR_ID = '65b000000000000000000003';
const ITEM_ID = '65c000000000000000000001';
const OTHER_ITEM_ID = '65c000000000000000000002';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const IMAGE_URL = 'https://i.ibb.co/test/pizza.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TOKEN_SUBJECTS = Object.freeze({
  'customer-token': CUSTOMER_ID,
  'vendor-token': VENDOR_ID,
});

const users = new Map([
  [CUSTOMER_ID, { _id: new ObjectId(CUSTOMER_ID), role: 'customer', isBlocked: false }],
  [VENDOR_ID, { _id: new ObjectId(VENDOR_ID), role: 'vendor', isBlocked: false }],
]);

function matches(filter, item) {
  return Object.entries(filter ?? {}).every(([key, expected]) => {
    if (key === '_id') {
      return String(expected) === String(item._id);
    }

    return item[key] === expected;
  });
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
      let skipCount = 0;
      let limitCount = Infinity;

      const cursor = {
        sort(spec) {
          const entries = Object.entries(spec);
          selected = [...selected].sort((left, right) => {
            for (const [field, direction] of entries) {
              const a = left[field];
              const b = right[field];

              if (a instanceof Date && b instanceof Date) {
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
          return cursor;
        },
        limit(count) {
          limitCount = count;
          return cursor;
        },
        async toArray() {
          return selected.slice(skipCount, skipCount + limitCount);
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

        return { sub: subject };
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

test('client-supplied vendorId, status and images fields are rejected', async () => {
  for (const field of ['vendorId', 'status', 'images', 'createdAt', 'isAvailable']) {
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
  assert.equal(fakeCollection.state.calls.length, 0);
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

  for (const field of ['status', 'vendorId', 'createdAt', 'images', '_id']) {
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
