import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { ObjectId } from 'mongodb';

import { createAuthenticate } from '../middlewares/authenticate.js';
import { createErrorHandler } from '../middlewares/error.js';
import { createUserRoutes } from '../modules/user/user.routes.js';
import { createUserService } from '../modules/user/user.service.js';

const AUTH_URL = 'https://auth.example.test';
const CUSTOMER_ID = '65b000000000000000000001';
const VENDOR_ID = '65b000000000000000000002';
const BLOCKED_ID = '65b000000000000000000003';
const MISSING_ID = '65b000000000000000000099';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

const TOKEN_SUBJECTS = Object.freeze({
  'customer-token': CUSTOMER_ID,
  'vendor-token': VENDOR_ID,
  'blocked-token': BLOCKED_ID,
  'missing-token': MISSING_ID,
});

function makeUsers() {
  return new Map([
    [
      CUSTOMER_ID,
      {
        _id: new ObjectId(CUSTOMER_ID),
        name: 'Alice Customer',
        email: 'alice@example.test',
        image: null,
        role: 'customer',
        businessName: null,
        isBlocked: false,
        subscriptionPlan: 'free',
        subscriptionExpiresAt: null,
        passwordHash: 'must-not-leak',
        resetToken: 'must-not-leak',
        privateNote: 'must-not-leak',
      },
    ],
    [
      VENDOR_ID,
      {
        _id: new ObjectId(VENDOR_ID),
        name: 'Vendor Owner',
        email: 'vendor@example.test',
        image: null,
        role: 'vendor',
        businessName: 'Vendor Pizzeria',
        isBlocked: false,
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: FIXED_DATE,
        passwordHash: 'must-not-leak',
        resetToken: 'must-not-leak',
        privateNote: 'must-not-leak',
      },
    ],
    [
      BLOCKED_ID,
      {
        _id: new ObjectId(BLOCKED_ID),
        name: 'Blocked User',
        email: 'blocked@example.test',
        image: null,
        role: 'customer',
        businessName: null,
        isBlocked: true,
        subscriptionPlan: 'free',
        subscriptionExpiresAt: null,
        passwordHash: 'must-not-leak',
      },
    ],
  ]);
}

let users = makeUsers();
let updateCalls = [];
let failUpdate = false;
let server;
let baseUrl;

const fakeCollection = {
  async updateOne(filter, update) {
    updateCalls.push({ filter, update });

    if (failUpdate) {
      throw new Error('database connection details must not leak');
    }

    const candidate = filter?._id?.$in?.[1] ?? filter?._id;
    const id = candidate?.toString?.() ?? String(candidate);
    const record = users.get(id);

    if (!record) {
      return { matchedCount: 0 };
    }

    Object.assign(record, update.$set);

    return { matchedCount: 1 };
  },
};

const originalConsoleError = console.error;

before(async () => {
  console.error = () => {};

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

  const userService = createUserService({
    collection: () => fakeCollection,
    findUserById: async (userId) => users.get(userId) ?? null,
    now: () => FIXED_DATE,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/users', createUserRoutes({}, { authenticate, userService }));
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  users = makeUsers();
  updateCalls = [];
  failUpdate = false;
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

function bearer(path, token, body) {
  const options = {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  return request(path, options);
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

test('GET /api/users/me returns only safe profile fields', async () => {
  const response = await bearer('/api/users/me', 'customer-token');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    user: {
      id: CUSTOMER_ID,
      name: 'Alice Customer',
      email: 'alice@example.test',
      image: null,
      role: 'customer',
      businessName: null,
      subscriptionPlan: 'free',
      subscriptionExpiresAt: null,
    },
  });

  const serialized = JSON.stringify(body);

  for (const privateField of ['passwordHash', 'resetToken', 'privateNote', 'isBlocked']) {
    assert.ok(!serialized.includes(privateField));
  }
});

test('a session cookie is never accepted in place of a Bearer token', async () => {
  const response = await request('/api/users/me', {
    headers: { Cookie: 'better-auth.session_token=forged-session' },
  });
  const body = await expectStatus(response, 401, 'UNAUTHORIZED');

  assert.equal(body.message, 'A Bearer token is required.');
  assert.equal(updateCalls.length, 0);
});

test('an unknown Bearer token is rejected with 401', async () => {
  await expectStatus(await bearer('/api/users/me', 'unknown-token'), 401, 'UNAUTHORIZED');
});

test('PATCH /api/users/me updates name and image with an explicit $set', async () => {
  const response = await bearer('/api/users/me', 'customer-token', {
    name: '  Alice Updated  ',
    image: 'https://images.example.test/alice.png',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.user.name, 'Alice Updated');
  assert.equal(body.user.image, 'https://images.example.test/alice.png');
  assert.equal(body.user.role, 'customer');

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(Object.keys(updateCalls[0].update.$set).sort(), [
    'image',
    'name',
    'updatedAt',
  ]);
  assert.deepEqual(updateCalls[0].update.$set.updatedAt, FIXED_DATE);
  assert.ok(!('$unset' in updateCalls[0].update));
});

test('PATCH /api/users/me allows a vendor to set or clear businessName', async () => {
  const setResponse = await bearer('/api/users/me', 'vendor-token', {
    businessName: '  Best Pizza  ',
  });
  const setBody = await setResponse.json();

  assert.equal(setResponse.status, 200);
  assert.equal(setBody.user.businessName, 'Best Pizza');
  assert.deepEqual(Object.keys(updateCalls[0].update.$set).sort(), [
    'businessName',
    'updatedAt',
  ]);

  updateCalls = [];
  const clearResponse = await bearer('/api/users/me', 'vendor-token', {
    businessName: null,
  });
  const clearBody = await clearResponse.json();

  assert.equal(clearResponse.status, 200);
  assert.equal(clearBody.user.businessName, null);
  assert.equal(updateCalls[0].update.$set.businessName, null);
});

test('a customer cannot update businessName and no write occurs', async () => {
  const response = await bearer('/api/users/me', 'customer-token', {
    businessName: 'Fake Shop',
  });
  const body = await expectStatus(response, 403, 'FORBIDDEN_FIELD');

  assert.equal(body.message, 'Only vendors can update businessName.');
  assert.equal(updateCalls.length, 0);
});

test('PATCH /api/users/me rejects empty, unknown, reserved and invalid fields', async () => {
  const cases = [
    [{}, 400, 'EMPTY_UPDATE'],
    [{ nickname: 'x' }, 400, 'VALIDATION_ERROR'],
    [{ role: 'admin' }, 400, 'FORBIDDEN_FIELD'],
    [{ isBlocked: false }, 400, 'FORBIDDEN_FIELD'],
    [{ subscriptionPlan: 'premium' }, 400, 'FORBIDDEN_FIELD'],
    [{ email: 'new@example.test' }, 400, 'FORBIDDEN_FIELD'],
    [{ password: 'NewPassword1' }, 400, 'FORBIDDEN_FIELD'],
    [{ image: 'javascript:alert(1)' }, 400, 'VALIDATION_ERROR'],
    [{ name: '   ' }, 400, 'VALIDATION_ERROR'],
  ];

  for (const [payload, status, code] of cases) {
    await expectStatus(
      await bearer('/api/users/me', 'customer-token', payload),
      status,
      code,
    );
  }

  assert.equal(updateCalls.length, 0);
});

test('a blocked user gets 403 and a deleted user gets 401', async () => {
  await expectStatus(await bearer('/api/users/me', 'blocked-token'), 403, 'FORBIDDEN');
  await expectStatus(await bearer('/api/users/me', 'missing-token'), 401, 'UNAUTHORIZED');
  assert.equal(updateCalls.length, 0);
});

test('a database failure during update becomes a generic 500', async () => {
  failUpdate = true;

  const body = await expectStatus(
    await bearer('/api/users/me', 'customer-token', { name: 'New Name' }),
    500,
    'INTERNAL_SERVER_ERROR',
  );

  assert.equal(body.message, 'An unexpected error occurred.');
  assert.ok(!JSON.stringify(body).includes('database connection details'));
});

test('createUserRoutes builds its own service without an injected userService', async () => {
  // Construction with no dependency injection at all must not throw.
  const bareRouter = createUserRoutes({ BETTER_AUTH_URL: AUTH_URL });
  assert.equal(typeof bareRouter, 'function');

  // Exercise the default service-construction branch with only service
  // dependencies injected. No `userService` is supplied here.
  const factoryUser = {
    ...makeUsers().get(CUSTOMER_ID),
    name: 'Factory Customer',
  };
  const factoryUsers = new Map([[CUSTOMER_ID, factoryUser]]);
  const factoryUpdates = [];
  const factoryCollection = {
    async updateOne(_filter, update) {
      factoryUpdates.push(update);
      Object.assign(factoryUser, update.$set);

      return { matchedCount: 1 };
    },
  };
  const factoryAuthenticate = (req, _res, next) => {
    req.user = { id: CUSTOMER_ID, role: 'customer' };
    next();
  };

  const router = createUserRoutes(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      authenticate: factoryAuthenticate,
      serviceDependencies: {
        collection: () => factoryCollection,
        findUserById: async (userId) => factoryUsers.get(userId) ?? null,
        now: () => FIXED_DATE,
      },
    },
  );

  const app = express();
  app.use(express.json());
  app.use('/api/users', router);
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  const factoryServer = app.listen(0);
  await new Promise((resolve) => factoryServer.once('listening', resolve));
  const factoryBaseUrl = `http://127.0.0.1:${factoryServer.address().port}`;

  try {
    const response = await fetch(`${factoryBaseUrl}/api/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Factory Updated' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.user.name, 'Factory Updated');
    assert.equal(factoryUpdates.length, 1);
    assert.deepEqual(Object.keys(factoryUpdates[0].$set).sort(), [
      'name',
      'updatedAt',
    ]);
  } finally {
    await new Promise((resolve) => factoryServer.close(resolve));
  }
});
