import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ObjectId } from 'mongodb';

import {
  buildJwksUrl,
  createJwtVerifier,
  JwksUnavailableError,
} from '../auth/jwt.js';
import {
  buildUserIdFilter,
  createAuthenticate,
  findUserById,
} from '../middlewares/authenticate.js';
import { requireRole } from '../middlewares/authorize.js';
import { createErrorHandler } from '../middlewares/error.js';

const AUTH_URL = 'https://auth.example.test';
const KEY_ID = 'test-key-1';
const USER_ID = '65b000000000000000000001';
const BLOCKED_USER_ID = '65b000000000000000000002';
const VENDOR_USER_ID = '65b000000000000000000003';
const MISSING_USER_ID = '65b000000000000000000099';

const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
const { privateKey: otherPrivateKey } = await generateKeyPair('EdDSA', { extractable: true });
const publicJwk = {
  ...(await exportJWK(publicKey)),
  alg: 'EdDSA',
  kid: KEY_ID,
  use: 'sig',
};
const localJwks = createLocalJWKSet({ keys: [publicJwk] });

const verifier = createJwtVerifier(
  { BETTER_AUTH_URL: AUTH_URL },
  {
    createRemoteJWKSet: (url) => {
      assert.equal(url.href, `${AUTH_URL}/api/auth/jwks`);
      return localJwks;
    },
  },
);

async function signToken(options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const {
    subject = USER_ID,
    omitSubject = false,
    role = 'customer',
    issuer = AUTH_URL,
    audience = AUTH_URL,
    expiresAt = now + 300,
    signingKey = privateKey,
    kid = KEY_ID,
  } = options;

  const token = new SignJWT({
    role,
    subscriptionPlan: 'premium',
    subscriptionStatus: 'active',
    isBlocked: false,
    passwordHash: 'must-not-be-trusted',
  }).setProtectedHeader({ alg: 'EdDSA', kid });

  if (!omitSubject) {
    token.setSubject(subject);
  }

  return token
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(signingKey);
}

const VALID_USER = Object.freeze({
  _id: new ObjectId(USER_ID),
  name: 'Alice Customer',
  email: 'alice@example.test',
  image: null,
  role: 'customer',
  businessName: null,
  isBlocked: false,
  subscriptionPlan: 'free',
  subscriptionStatus: 'inactive',
  subscriptionExpiresAt: null,
  passwordHash: 'secret-hash',
  resetToken: 'secret-reset-token',
  privateNote: 'internal only',
});

const users = new Map([
  [USER_ID, { ...VALID_USER }],
  [
    BLOCKED_USER_ID,
    {
      ...VALID_USER,
      _id: new ObjectId(BLOCKED_USER_ID),
      email: 'blocked@example.test',
      isBlocked: true,
    },
  ],
  [
    VENDOR_USER_ID,
    {
      ...VALID_USER,
      _id: new ObjectId(VENDOR_USER_ID),
      email: 'vendor@example.test',
      role: 'vendor',
      businessName: 'Vendor Pizzeria',
    },
  ],
]);

let failDatabase = false;
let server;
let baseUrl;

const originalConsoleError = console.error;

before(async () => {
  console.error = () => {};

  const app = express();
  const authenticate = createAuthenticate(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      verifyToken: verifier,
      findUser: async (userId) => {
        if (failDatabase) {
          throw new Error('database connection details must not leak');
        }

        return users.get(userId) ?? null;
      },
    },
  );

  app.get('/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/customer', authenticate, requireRole('customer'), (_req, res) => {
    res.json({ allowed: true });
  });

  app.get('/vendor', authenticate, requireRole('vendor'), (_req, res) => {
    res.json({ allowed: true });
  });

  app.get('/admin', authenticate, requireRole('admin'), (_req, res) => {
    res.json({ allowed: true });
  });

  app.get('/customer-or-vendor', authenticate, requireRole('customer', 'vendor'), (_req, res) => {
    res.json({ allowed: true });
  });

  const authenticateWithJwksOutage = createAuthenticate(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      verifyToken: async () => {
        throw new JwksUnavailableError();
      },
      findUser: async () => VALID_USER,
    },
  );

  app.get('/jwks-down', authenticateWithJwksOutage, (_req, res) => {
    res.json({ allowed: true });
  });

  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  failDatabase = false;
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

function bearerGet(path, token) {
  return request(path, { headers: { Authorization: `Bearer ${token}` } });
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

test('buildJwksUrl uses BETTER_AUTH_URL and tolerates a trailing slash', () => {
  assert.equal(
    buildJwksUrl(`${AUTH_URL}/`).href,
    `${AUTH_URL}/api/auth/jwks`,
  );
  assert.equal(
    buildJwksUrl('https://api.example.test/base/').href,
    'https://api.example.test/base/api/auth/jwks',
  );
  assert.throws(() => buildJwksUrl(''), /BETTER_AUTH_URL is required/);
});

test('the remote JWKS resolver is created once and reused', async () => {
  let resolverCalls = 0;
  const reusableVerifier = createJwtVerifier(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      createRemoteJWKSet: () => {
        resolverCalls += 1;
        return localJwks;
      },
    },
  );
  const token = await signToken();

  await reusableVerifier(token);
  await reusableVerifier(token);

  assert.equal(resolverCalls, 1);
});

test('a valid token returns its verified claims', async () => {
  const claims = await verifier(await signToken());

  assert.equal(claims.sub, USER_ID);
  assert.equal(claims.iss, AUTH_URL);
  assert.equal(claims.aud, AUTH_URL);
});

test('an invalid signature is rejected with a generic error', async () => {
  const token = await signToken({ signingKey: otherPrivateKey });

  await assert.rejects(() => verifier(token), (error) => {
    assert.equal(error.message, 'JWT verification failed.');
    assert.doesNotMatch(error.message, /signature|key|kid/i);
    return true;
  });
});

test('an expired token is rejected with a generic error', async () => {
  const token = await signToken({ expiresAt: Math.floor(Date.now() / 1000) - 10 });

  await assert.rejects(() => verifier(token), /JWT verification failed\./);
});

test('a wrong issuer is rejected with a generic error', async () => {
  const token = await signToken({ issuer: 'https://evil.example.test' });

  await assert.rejects(() => verifier(token), /JWT verification failed\./);
});

test('a wrong audience is rejected with a generic error', async () => {
  const token = await signToken({ audience: 'https://other-service.example.test' });

  await assert.rejects(() => verifier(token), /JWT verification failed\./);
});

test('missing or empty subjects are rejected with a generic error', async () => {
  const missing = await signToken({ omitSubject: true });
  const empty = await signToken({ subject: '' });

  await assert.rejects(() => verifier(missing), /JWT verification failed\./);
  await assert.rejects(() => verifier(empty), /JWT verification failed\./);
});

test('a JWKS fetch failure is treated as infrastructure, not a bad token', async () => {
  const failingVerifier = createJwtVerifier(
    { BETTER_AUTH_URL: AUTH_URL },
    {
      createRemoteJWKSet: () => localJwks,
      jwtVerify: async () => {
        throw new TypeError('fetch failed');
      },
    },
  );

  const token = await signToken();

  await assert.rejects(() => failingVerifier(token), (error) => {
    assert.ok(error instanceof JwksUnavailableError);
    assert.doesNotMatch(error.message, /fetch/i);
    return true;
  });
});

test('user lookup accepts ObjectId and string ids without assuming one format', async () => {
  const filters = [];
  const collection = {
    findOne: async (filter) => {
      filters.push(filter);
      return null;
    },
  };

  assert.deepEqual(buildUserIdFilter(''), null);

  await findUserById(USER_ID, collection);
  assert.ok(filters[0]._id.$in[0] instanceof ObjectId);
  assert.equal(filters[0]._id.$in[0].toHexString(), USER_ID);
  assert.equal(filters[0]._id.$in[1], USER_ID);

  await findUserById('legacy-string-id', collection);
  assert.deepEqual(filters[1], { _id: 'legacy-string-id' });
});

test('a missing Authorization header returns 401', async () => {
  const body = await expectStatus(await request('/me'), 401, 'UNAUTHORIZED');

  assert.equal(body.message, 'A Bearer token is required.');
});

test('a malformed Bearer header returns 401', async () => {
  const token = await signToken();

  for (const header of ['Basic abc', 'Bearer', 'Bearer token extra']) {
    const response = await request('/me', { headers: { Authorization: header } });
    const body = await expectStatus(response, 401, 'UNAUTHORIZED');

    assert.equal(body.message, 'A Bearer token is required.');
  }

  assert.ok(token);
});

test('an invalid signature returns 401 from the middleware', async () => {
  const token = await signToken({ signingKey: otherPrivateKey });
  const body = await expectStatus(await bearerGet('/me', token), 401, 'UNAUTHORIZED');

  assert.equal(body.message, 'Invalid or expired token.');
});

test('expired, wrong-issuer, wrong-audience and missing-subject tokens return 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const tokens = [
    await signToken({ expiresAt: now - 10 }),
    await signToken({ issuer: 'https://evil.example.test' }),
    await signToken({ audience: 'https://other-service.example.test' }),
    await signToken({ omitSubject: true }),
  ];

  for (const token of tokens) {
    await expectStatus(await bearerGet('/me', token), 401, 'UNAUTHORIZED');
  }
});

test('a user missing from MongoDB returns 401', async () => {
  const token = await signToken({ subject: MISSING_USER_ID });
  const body = await expectStatus(await bearerGet('/me', token), 401, 'UNAUTHORIZED');

  assert.equal(body.message, 'User no longer exists.');
});

test('a valid user receives a sanitized req.user', async () => {
  const token = await signToken({
    role: 'admin',
  });
  const response = await bearerGet('/me', token);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    user: {
      id: USER_ID,
      name: 'Alice Customer',
      email: 'alice@example.test',
      image: null,
      role: 'customer',
      businessName: null,
      subscriptionPlan: 'free',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: null,
    },
  });
});

test('a blocked user returns 403', async () => {
  const token = await signToken({ subject: BLOCKED_USER_ID });
  const body = await expectStatus(await bearerGet('/me', token), 403, 'FORBIDDEN');

  assert.equal(body.message, 'This account is blocked.');
});

test('the correct database role is allowed', async () => {
  const token = await signToken({ subject: VENDOR_USER_ID, role: 'customer' });
  const response = await bearerGet('/vendor', token);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { allowed: true });
});

test('an incorrect database role returns 403', async () => {
  const token = await signToken();
  const body = await expectStatus(await bearerGet('/admin', token), 403, 'FORBIDDEN');

  assert.equal(body.message, 'You do not have permission to perform this action.');
});

test('multi-role authorization accepts customer and vendor from MongoDB', async () => {
  const customerToken = await signToken();
  const vendorToken = await signToken({ subject: VENDOR_USER_ID, role: 'customer' });

  for (const token of [customerToken, vendorToken]) {
    const response = await bearerGet('/customer-or-vendor', token);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { allowed: true });
  }
});

test('authorization uses the current database role, not a JWT role claim', async () => {
  const token = await signToken({ role: 'admin', subscriptionPlan: 'premium' });

  await expectStatus(await bearerGet('/admin', token), 403, 'FORBIDDEN');

  const me = await bearerGet('/me', token);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, 'customer');
});

test('subscription JWT claims are ignored in favor of MongoDB values', async () => {
  const token = await signToken({ role: 'customer' });
  const response = await bearerGet('/me', token);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.user.subscriptionPlan, 'free');
  assert.equal(body.user.subscriptionStatus, 'inactive');
  assert.equal(body.user.subscriptionExpiresAt, null);
});

test('database errors reach the centralized handler and are not exposed', async () => {
  failDatabase = true;
  const token = await signToken();
  const body = await expectStatus(
    await bearerGet('/me', token),
    500,
    'INTERNAL_SERVER_ERROR',
  );

  assert.equal(body.message, 'An unexpected error occurred.');
  assert.doesNotMatch(JSON.stringify(body), /database connection details|secret/i);
});

test('a JWKS outage reaches the central handler as a generic 500', async () => {
  const token = await signToken();
  const body = await expectStatus(
    await bearerGet('/jwks-down', token),
    500,
    'INTERNAL_SERVER_ERROR',
  );

  assert.equal(body.message, 'An unexpected error occurred.');
  assert.doesNotMatch(JSON.stringify(body), /unavailable|fetch/i);
});

test('requireRole validates setup and accepts supported role combinations', () => {
  assert.throws(() => requireRole(), /at least one role/);
  assert.throws(() => requireRole('superuser'), /Unsupported role/);
  assert.throws(() => requireRole('customer', 'superuser'), /Unsupported role/);

  for (const middleware of [
    requireRole('customer'),
    requireRole('vendor'),
    requireRole('admin'),
    requireRole('customer', 'vendor'),
  ]) {
    assert.equal(typeof middleware, 'function');
    assert.equal(middleware.length, 3);
  }
});
