import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createServer } from 'node:net';

import { toNodeHandler } from 'better-auth/node';
import { memoryAdapter } from 'better-auth/adapters/memory';
import express from 'express';
import { createRemoteJWKSet, decodeJwt } from 'jose';

import {
  BLOCKED_SESSION_PLUGIN_ID,
  createAuth,
  rejectBlockedSessionCreation,
} from '../auth/config/better-auth.js';
import { createJwtVerifier } from '../auth/jwt.js';
import { createAuthenticate, SESSION_ID_CLAIM } from '../middlewares/authenticate.js';
import { requireRole } from '../middlewares/authorize.js';
import { createErrorHandler } from '../middlewares/error.js';
import { createApiLimiter } from '../middlewares/rate-limit.js';

// Fake credentials and in-memory records only. This suite never reads .env,
// contacts MongoDB Atlas, or uses a real vendor/customer/admin account.
const SECRET = 'K9mZ2qL7pR4tY8wC1nV6bX3sF0hJ5dA7gE2rT9yU4iO6pS1a';

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

function freshDatabase() {
  return { users: [], account: [], session: [], verification: [], jwks: [] };
}

function clearMutableRecords(db) {
  for (const key of ['users', 'account', 'session', 'verification']) {
    db[key].splice(0, db[key].length);
  }
}

function setCookies(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

let env;
let db;
let server;
let baseUrl;
const originalConsoleError = console.error;

before(async () => {
  console.error = () => {};
  const port = await freePort();

  env = Object.freeze({
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    CLIENT_URL: `http://127.0.0.1:${port + 1}`,
  });
  db = freshDatabase();
  baseUrl = env.BETTER_AUTH_URL;

  const auth = createAuth(env, { database: memoryAdapter(db) });
  const authenticate = createAuthenticate(env, {
    verifyToken: createJwtVerifier(env, { createRemoteJWKSet }),
    findUser: async (userId) =>
      db.users.find((user) => String(user.id) === String(userId)) ?? null,
    findSession: async (sessionId) =>
      db.session.find((session) => String(session.id) === String(sessionId)) ?? null,
  });

  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.get('/api/customer-only', authenticate, requireRole('customer'), (_req, res) => {
    res.json({ allowed: true });
  });
  app.get('/api/vendor-only', authenticate, requireRole('vendor'), (_req, res) => {
    res.json({ allowed: true });
  });
  app.get('/api/admin-only', authenticate, requireRole('admin'), (_req, res) => {
    res.json({ allowed: true });
  });
  app.use(createErrorHandler({ NODE_ENV: 'production' }));

  server = app.listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
});

beforeEach(() => {
  clearMutableRecords(db);
});

after(async () => {
  console.error = originalConsoleError;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
      origin: env.CLIENT_URL,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  return { status: response.status, json, cookie: setCookies(response) };
}

async function registerAndSignIn(role, email) {
  const registered = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: `${role} Test`, email, password: 'StrongPass1', role },
  });
  assert.equal(registered.status, 200);

  const signedIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password: 'StrongPass1' },
  });
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.cookie);

  const tokenResult = await call('/api/auth/token', { cookie: signedIn.cookie });
  assert.equal(tokenResult.status, 200);
  assert.ok(tokenResult.json?.token);

  return {
    cookie: signedIn.cookie,
    token: tokenResult.json.token,
    userId: signedIn.json?.user?.id ?? db.users.at(-1)?.userId,
    sessionId: db.session.at(-1)?.id,
  };
}

async function authorized(path, token) {
  return call(path, { headers: { authorization: `Bearer ${token}` } });
}

test('customer sign-up, sign-in, session, token and protected access work end to end', async () => {
  const session = await registerAndSignIn('customer', 'customer-flow@pizzahub.test');
  const claims = decodeJwt(session.token);

  assert.equal(claims.sub, session.userId);
  assert.equal(claims[SESSION_ID_CLAIM], session.sessionId);

  const currentSession = await call('/api/auth/get-session', { cookie: session.cookie });
  assert.equal(currentSession.status, 200);
  assert.equal(currentSession.json?.user?.role, 'customer');

  const customerArea = await authorized('/api/customer-only', session.token);
  assert.equal(customerArea.status, 200);

  const vendorArea = await authorized('/api/vendor-only', session.token);
  assert.equal(vendorArea.status, 403);
});

test('vendor role persists through sign-in, session and middleware authorization', async () => {
  const session = await registerAndSignIn('vendor', 'vendor-flow@pizzahub.test');

  assert.equal(db.users[0]?.role, 'vendor');

  const currentSession = await call('/api/auth/get-session', { cookie: session.cookie });
  assert.equal(currentSession.json?.user?.role, 'vendor');

  const claims = decodeJwt(session.token);
  assert.equal(claims.role, 'vendor');
  assert.equal(claims[SESSION_ID_CLAIM], session.sessionId);

  const vendorArea = await authorized('/api/vendor-only', session.token);
  assert.equal(vendorArea.status, 200);

  const customerArea = await authorized('/api/customer-only', session.token);
  assert.equal(customerArea.status, 403);
});

test('public registration cannot assign Admin, but MongoDB Admin role is enforced', async () => {
  const registered = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: {
      name: 'Fake Admin',
      email: 'fake-admin-flow@pizzahub.test',
      password: 'StrongPass1',
      role: 'admin',
    },
  });

  assert.equal(registered.status, 400);
  assert.equal(db.users.length, 0);

  const customer = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: {
      name: 'Real Admin',
      email: 'admin-flow@pizzahub.test',
      password: 'StrongPass1',
      role: 'customer',
    },
  });
  assert.equal(customer.status, 200);

  // Simulate the trusted seed script's server-owned role write in memory.
  db.users[0].role = 'admin';
  const signedIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'admin-flow@pizzahub.test', password: 'StrongPass1' },
  });
  const tokenResult = await call('/api/auth/token', { cookie: signedIn.cookie });
  const adminArea = await authorized('/api/admin-only', tokenResult.json.token);

  assert.equal(adminArea.status, 200);
});

test('invalid credentials are rejected without creating a session', async () => {
  await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: 'Wrong Pass', email: 'wrong-pass@pizzahub.test', password: 'StrongPass1' },
  });

  const sessionsBeforeSignIn = db.session.length;
  const signedIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'wrong-pass@pizzahub.test', password: 'WrongPass1' },
  });

  assert.equal(signedIn.status, 401);
  assert.equal(signedIn.cookie, '');
  assert.equal(db.session.length, sessionsBeforeSignIn);
});

test('sign-out invalidates the session and makes an existing JWT unusable', async () => {
  const session = await registerAndSignIn('customer', 'logout-flow@pizzahub.test');

  const beforeLogout = await authorized('/api/customer-only', session.token);
  assert.equal(beforeLogout.status, 200);

  const signedOut = await call('/api/auth/sign-out', {
    method: 'POST',
    cookie: session.cookie,
  });
  assert.equal(signedOut.status, 200);

  const sessionAfterLogout = await call('/api/auth/get-session', { cookie: session.cookie });
  assert.equal(sessionAfterLogout.json?.session ?? null, null);

  const tokenAfterLogout = await call('/api/auth/token', { cookie: session.cookie });
  assert.equal(tokenAfterLogout.status, 401);

  const apiAfterLogout = await authorized('/api/customer-only', session.token);
  assert.equal(apiAfterLogout.status, 401);
});

test('a blocked user cannot sign in, refresh a session or mint a JWT', async () => {
  const session = await registerAndSignIn('vendor', 'blocked-flow@pizzahub.test');
  db.users[0].isBlocked = true;

  const signIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'blocked-flow@pizzahub.test', password: 'StrongPass1' },
  });
  const currentSession = await call('/api/auth/get-session', { cookie: session.cookie });
  const token = await call('/api/auth/token', { cookie: session.cookie });
  const businessApi = await authorized('/api/vendor-only', session.token);

  assert.equal(signIn.status, 403);
  assert.equal(signIn.cookie, '');
  assert.equal(currentSession.status, 403);
  assert.equal(token.status, 403);
  assert.equal(businessApi.status, 403);
});

test('blocked users cannot create a session from a non-email auth path', async () => {
  const blockedContext = {
    context: {
      internalAdapter: {
        findUserById: async () => ({ id: 'blocked-session-user', isBlocked: true }),
      },
    },
  };

  await assert.rejects(
    () => rejectBlockedSessionCreation({ userId: 'blocked-session-user' }, blockedContext),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.body.message, 'This account is blocked.');
      return true;
    },
  );

  const allowedContext = {
    context: {
      internalAdapter: {
        findUserById: async () => ({ id: 'allowed-session-user', isBlocked: false }),
      },
    },
  };

  await rejectBlockedSessionCreation({ userId: 'allowed-session-user' }, allowedContext);

  // The guard is registered at the database boundary, not only in route hooks.
  // OAuth callbacks have no request-hook context, so the plugin's initialized
  // adapter fallback must reject the session creation on its own.
  const probeAuth = createAuth(env, { database: memoryAdapter(db) });
  const guardPlugin = probeAuth.options.plugins?.find(
    (plugin) => plugin.id === BLOCKED_SESSION_PLUGIN_ID,
  );
  assert.ok(guardPlugin, 'blocked-session guard plugin is installed');

  const fallbackAdapter = {
    findUserById: async () => ({ id: 'oauth-blocked-user', isBlocked: true }),
  };
  const beforeCreate = guardPlugin.init({ internalAdapter: fallbackAdapter }).options
    .databaseHooks.session.create.before;

  await assert.rejects(
    () => beforeCreate({ userId: 'oauth-blocked-user' }, undefined),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.body.message, 'This account is blocked.');
      return true;
    },
  );
});

test('blocked-session guard fails closed when no internal adapter is available', async () => {
  await assert.rejects(
    () => rejectBlockedSessionCreation({ userId: 'unknown-status-user' }, undefined, undefined),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.body.message, 'Unable to verify account status before creating a session.');
      return true;
    },
  );

  const guardPlugin = createAuth(env, { database: memoryAdapter(db) }).options.plugins?.find(
    (plugin) => plugin.id === BLOCKED_SESSION_PLUGIN_ID,
  );
  assert.ok(guardPlugin, 'blocked-session guard plugin is installed');

  const beforeCreate = guardPlugin.init({}).options.databaseHooks.session.create.before;

  await assert.rejects(
    () => beforeCreate({ userId: 'unknown-status-user' }, undefined),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.body.message, 'Unable to verify account status before creating a session.');
      return true;
    },
  );
});

test('auth maintenance and credential traffic use separate rate-limit buckets', async () => {
  const limiterApp = express();
  limiterApp.use(createApiLimiter({ NODE_ENV: 'production' }));
  limiterApp.get('/api/orders', (_req, res) => res.json({ ok: true }));
  limiterApp.get('/api/auth/token', (_req, res) => res.json({ ok: true }));
  limiterApp.post('/api/auth/sign-in/email', (_req, res) => res.json({ ok: true }));
  limiterApp.use(createErrorHandler({ NODE_ENV: 'production' }));

  const limiterServer = limiterApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => limiterServer.once('listening', resolve));
  const limiterUrl = `http://127.0.0.1:${limiterServer.address().port}`;

  try {
    let status = 200;

    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${limiterUrl}/api/orders`);
      status = response.status;
    }
    assert.equal(status, 200);

    const exhausted = await fetch(`${limiterUrl}/api/orders`);
    assert.equal(exhausted.status, 429);
    assert.equal((await exhausted.json()).code, 'RATE_LIMITED');

    const authUtility = await fetch(`${limiterUrl}/api/auth/token`);
    assert.equal(authUtility.status, 200);

    const signIn = () =>
      fetch(`${limiterUrl}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

    // Exhausting ordinary API traffic must not throttle a credential check.
    assert.equal((await signIn()).status, 200);

    let signInStatus = 200;

    // The first credential request above already consumed one of 100 slots.
    for (let index = 0; index < 99; index += 1) {
      const response = await signIn();
      signInStatus = response.status;
    }
    assert.equal(signInStatus, 200);

    const exhaustedSignIn = await signIn();
    assert.equal(exhaustedSignIn.status, 429);
    assert.equal((await exhaustedSignIn.json()).code, 'RATE_LIMITED');

    // The credential bucket is also independent from session maintenance.
    assert.equal((await fetch(`${limiterUrl}/api/auth/token`)).status, 200);
  } finally {
    await new Promise((resolve) => limiterServer.close(resolve));
  }
});

test('IPv6 addresses in the same subnet share one rate-limit bucket', async () => {
  const limiterApp = express();
  limiterApp.set('trust proxy', 1);
  limiterApp.use(createApiLimiter({ NODE_ENV: 'production' }));
  limiterApp.get('/api/orders', (_req, res) => res.json({ ok: true }));
  limiterApp.use(createErrorHandler({ NODE_ENV: 'production' }));

  const limiterServer = limiterApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => limiterServer.once('listening', resolve));
  const limiterUrl = `http://127.0.0.1:${limiterServer.address().port}`;
  const from = (address) =>
    fetch(`${limiterUrl}/api/orders`, { headers: { 'x-forwarded-for': address } });

  try {
    let status = 200;

    for (let index = 0; index < 100; index += 1) {
      status = (await from('2001:db8:1::1')).status;
    }
    assert.equal(status, 200);

    const exhausted = await from('2001:db8:1::1');
    assert.equal(exhausted.status, 429);

    // Same /56 subnet: a different host must not get a fresh bucket.
    const sameSubnet = await from('2001:db8:1::2');
    assert.equal(sameSubnet.status, 429);

    // A different /56 subnet remains independent.
    const otherSubnet = await from('2001:db8:2::1');
    assert.equal(otherSubnet.status, 200);
  } finally {
    await new Promise((resolve) => limiterServer.close(resolve));
  }
});
