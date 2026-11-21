import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryAdapter } from 'better-auth/adapters/memory';

import {
  createAuth,
  isAdminCreationAllowed,
  isTrustedServerOnlyAuthCall,
  resolveRegistrationRole,
  USER_ROLES,
} from '../auth/config/better-auth.js';
import {
  findUserByEmail,
  formatSeedError,
  isDuplicateUserError,
  runSeedCli,
  seedAdmin,
  validateAdminConfig,
} from '../scripts/seed-admin.js';
import { ApiError } from '../utils/api-error.js';

// Fake values only. This suite never reads .env and never contacts MongoDB Atlas.
const ENV = Object.freeze({
  BETTER_AUTH_SECRET: 'K9mZ2qL7pR4tY8wC1nV6bX3sF0hJ5dA7gE2rT9yU4iO6pS1a',
  BETTER_AUTH_URL: 'http://localhost:5000',
  CLIENT_URL: 'http://localhost:3000',
  ADMIN_NAME: 'PizzaHub Root',
  ADMIN_EMAIL: 'admin@pizzahub.test',
  ADMIN_PASSWORD: 'StrongPass1',
});

function createMemoryDb() {
  return {
    users: [],
    account: [],
    session: [],
    verification: [],
    jwks: [],
  };
}

function createDependencies(overrides = {}) {
  const calls = {
    connect: 0,
    disconnect: 0,
    signUpArgs: [],
    authFactoryArgs: [],
    logs: [],
  };

  const dependencies = {
    connectToDatabase: async () => {
      calls.connect += 1;
    },
    disconnectFromDatabase: async () => {
      calls.disconnect += 1;
    },
    findUserByEmail: async () => null,
    createAuth: (authEnv, options) => {
      calls.authFactoryArgs.push({ env: authEnv, options });

      return {
        api: {
          signUpEmail: async (args) => {
            calls.signUpArgs.push(args);

            return { user: { id: 'new-admin-id' } };
          },
        },
      };
    },
    logger: { log: (message) => calls.logs.push(message) },
    ...overrides,
  };

  return { calls, dependencies };
}

test('validateAdminConfig accepts a strong config and normalizes email', () => {
  const config = validateAdminConfig(ENV);

  assert.equal(config.name, 'PizzaHub Root');
  assert.equal(config.email, 'admin@pizzahub.test');
  assert.equal(config.password, ENV.ADMIN_PASSWORD);
  assert.equal(Object.isFrozen(config), true);
});

test('validateAdminConfig rejects weak and placeholder values without echoing them', () => {
  const invalidPasswords = ['short', 'alllowercase', 'ALLUPPERCASE', 'replace-with-a-strong-password'];

  for (const password of invalidPasswords) {
    assert.throws(
      () => validateAdminConfig({ ...ENV, ADMIN_PASSWORD: password }),
      (error) => {
        assert.match(error.message, /^Invalid admin seed configuration:/);
        assert.ok(!error.message.includes(password));
        return true;
      },
    );
  }

  assert.throws(
    () => validateAdminConfig({ ...ENV, ADMIN_EMAIL: 'admin@example.com' }),
    /ADMIN_EMAIL must be a real address/,
  );

  assert.throws(
    () => validateAdminConfig({ ...ENV, ADMIN_NAME: '' }),
    /ADMIN_NAME is required/,
  );
});

test('invalid admin config is rejected before any database connection', async () => {
  const { calls, dependencies } = createDependencies();

  await assert.rejects(() =>
    seedAdmin({ ...ENV, ADMIN_PASSWORD: 'short' }, dependencies),
  );

  assert.equal(calls.connect, 0);
  assert.equal(calls.disconnect, 0);
  assert.equal(calls.signUpArgs.length, 0);
});

test('findUserByEmail lowercases the address and uses a narrow projection', async () => {
  let captured = null;

  const collection = {
    findOne: async (filter, options) => {
      captured = { filter, options };

      return { id: 'admin-id', role: USER_ROLES.ADMIN };
    },
  };

  const result = await findUserByEmail('ADMIN@PIZZAHUB.TEST', collection);

  assert.deepEqual(captured.filter, { email: 'admin@pizzahub.test' });
  assert.deepEqual(captured.options.projection, { _id: 1, id: 1, email: 1, role: 1 });
  assert.equal(result.role, USER_ROLES.ADMIN);
});

test('an existing Admin is an idempotent no-op and does not call Better Auth', async () => {
  const { calls, dependencies } = createDependencies({
    findUserByEmail: async () => ({ id: 'existing-admin', role: USER_ROLES.ADMIN }),
    createAuth: () => {
      throw new Error('Better Auth must not be called for an existing Admin');
    },
  });

  const result = await seedAdmin(ENV, dependencies);

  assert.deepEqual(result, { status: 'already-exists', id: 'existing-admin' });
  assert.equal(calls.connect, 1);
  assert.equal(calls.disconnect, 1);
  assert.equal(calls.signUpArgs.length, 0);
  assert.match(calls.logs[0], /No changes were made/);
});

test('an existing non-Admin email produces a safe 409 conflict', async () => {
  const { calls, dependencies } = createDependencies({
    findUserByEmail: async () => ({ id: 'customer-id', role: USER_ROLES.CUSTOMER }),
    createAuth: () => {
      throw new Error('Better Auth must not be called for a non-Admin email');
    },
  });

  await assert.rejects(
    () => seedAdmin(ENV, dependencies),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'ADMIN_EMAIL_IN_USE');
      assert.ok(!error.message.includes(ENV.ADMIN_PASSWORD));
      return true;
    },
  );

  assert.equal(calls.disconnect, 1);
  assert.equal(calls.signUpArgs.length, 0);
});

test('a new Admin is created through a direct server-only sign-up call', async () => {
  const { calls, dependencies } = createDependencies();

  const result = await seedAdmin(ENV, dependencies);

  assert.deepEqual(result, { status: 'created', id: 'new-admin-id' });
  assert.equal(calls.connect, 1);
  assert.equal(calls.disconnect, 1);
  assert.equal(calls.signUpArgs.length, 1);
  assert.equal(calls.authFactoryArgs.length, 1);
  assert.equal(calls.authFactoryArgs[0].options.allowAdminCreation, true);

  const call = calls.signUpArgs[0];

  assert.equal(Object.hasOwn(call, 'headers'), false);
  assert.equal(Object.hasOwn(call, 'request'), false);
  assert.equal(call.body.name, ENV.ADMIN_NAME);
  assert.equal(call.body.email, ENV.ADMIN_EMAIL.toLowerCase());
  assert.equal(call.body.password, ENV.ADMIN_PASSWORD);
  assert.equal(call.body.role, USER_ROLES.ADMIN);
  assert.match(calls.logs[0], /Admin account created/);
});

test('the real Better Auth path stores an Admin and hashes the password', async () => {
  const db = createMemoryDb();
  const auth = createAuth(ENV, {
    database: memoryAdapter(db),
    allowAdminCreation: true,
  });
  const { calls, dependencies } = createDependencies({
    createAuth: (authEnv, options) => {
      calls.authFactoryArgs.push({ env: authEnv, options });
      assert.equal(options.allowAdminCreation, true);

      return auth;
    },
    findUserByEmail: async (email) =>
      db.users.find((user) => user.email === email.toLowerCase()) ?? null,
  });

  const result = await seedAdmin(ENV, dependencies);

  assert.deepEqual(result, { status: 'created', id: db.users[0]?.id });
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].role, USER_ROLES.ADMIN);
  assert.equal(db.users[0].email, ENV.ADMIN_EMAIL.toLowerCase());

  const storedPassword = db.account[0]?.password;

  assert.ok(typeof storedPassword === 'string');
  assert.notEqual(storedPassword, ENV.ADMIN_PASSWORD);
  assert.ok(storedPassword.length > ENV.ADMIN_PASSWORD.length);
  assert.equal(calls.disconnect, 1);
});

test('createAuth defaults to Admin creation disabled for direct calls', async () => {
  const db = createMemoryDb();
  const auth = createAuth(ENV, { database: memoryAdapter(db) });

  await assert.rejects(
    () =>
      auth.api.signUpEmail({
        body: {
          name: 'Root',
          email: 'admin-default@pizzahub.test',
          password: ENV.ADMIN_PASSWORD,
          role: USER_ROLES.ADMIN,
        },
      }),
    (error) => {
      assert.equal(error?.status, 'BAD_REQUEST');
      assert.match(error.message, /Role must be one of/);
      return true;
    },
  );

  assert.equal(db.users.length, 0);
});

test('the explicit seed-only option permits a direct Admin creation', async () => {
  const db = createMemoryDb();
  const auth = createAuth(ENV, {
    database: memoryAdapter(db),
    allowAdminCreation: true,
  });

  const result = await auth.api.signUpEmail({
    body: {
      name: 'Root',
      email: 'admin-enabled@pizzahub.test',
      password: ENV.ADMIN_PASSWORD,
      role: USER_ROLES.ADMIN,
    },
  });

  assert.equal(result.user.role, USER_ROLES.ADMIN);
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].role, USER_ROLES.ADMIN);
});

test('HTTP-style registration cannot assign Admin even with the option enabled', async () => {
  const db = createMemoryDb();
  const auth = createAuth(ENV, {
    database: memoryAdapter(db),
    allowAdminCreation: true,
  });

  await assert.rejects(
    () =>
      auth.api.signUpEmail({
        body: {
          name: 'Root',
          email: 'admin-http@pizzahub.test',
          password: ENV.ADMIN_PASSWORD,
          role: USER_ROLES.ADMIN,
        },
        headers: new Headers(),
      }),
    /Role must be one of/,
  );

  assert.equal(db.users.length, 0);
});

test('customer and vendor registration remain supported', async () => {
  const db = createMemoryDb();
  const auth = createAuth(ENV, { database: memoryAdapter(db) });

  for (const role of [USER_ROLES.CUSTOMER, USER_ROLES.VENDOR]) {
    const result = await auth.api.signUpEmail({
      body: {
        name: `${role} user`,
        email: `${role}@pizzahub.test`,
        password: ENV.ADMIN_PASSWORD,
        role,
      },
      headers: new Headers(),
    });

    assert.equal(result.user.role, role);
  }

  assert.equal(db.users.length, 2);
});

test('a duplicate-email race becomes a no-op when the winner is an Admin', async () => {
  let lookupCount = 0;
  const { calls, dependencies } = createDependencies({
    findUserByEmail: async () => {
      lookupCount += 1;

      return lookupCount === 1
        ? null
        : { id: 'winning-admin', role: USER_ROLES.ADMIN };
    },
    createAuth: () => ({
      api: {
        signUpEmail: async () => {
          throw {
            status: 'UNPROCESSABLE_ENTITY',
            code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
            message: 'duplicate email',
          };
        },
      },
    }),
  });

  const result = await seedAdmin(ENV, dependencies);

  assert.deepEqual(result, { status: 'already-exists', id: 'winning-admin' });
  assert.equal(calls.disconnect, 1);
});

test('duplicate-user errors are recognized from Better Auth and MongoDB shapes', () => {
  assert.equal(isDuplicateUserError({ status: 'CONFLICT' }), true);
  assert.equal(isDuplicateUserError({ statusCode: 409 }), true);
  assert.equal(isDuplicateUserError({ code: 11000 }), true);
  assert.equal(
    isDuplicateUserError({ body: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' } }),
    true,
  );
  assert.equal(isDuplicateUserError(new Error('network timeout')), false);
});

test('the CLI entry point loads env, passes it to seedAdmin and awaits the result', async () => {
  const fakeEnv = Object.freeze({ ...ENV, MARKER: 'from-loader' });
  const seedDependencies = Object.freeze({ marker: 'fake-seed-dependencies' });
  const expectedResult = Object.freeze({ status: 'created', id: 'cli-admin' });
  const loadCalls = [];
  const seedCalls = [];
  let releaseSeed;
  const gate = new Promise((resolve) => {
    releaseSeed = resolve;
  });

  const resultPromise = runSeedCli({
    loadEnv: () => {
      loadCalls.push('called');

      return fakeEnv;
    },
    seedAdmin: async (env, dependencies) => {
      seedCalls.push({ env, dependencies });
      await gate;

      return expectedResult;
    },
    seedDependencies,
  });

  assert.deepEqual(loadCalls, ['called']);
  assert.equal(seedCalls.length, 1);
  assert.equal(seedCalls[0].env, fakeEnv);
  assert.equal(seedCalls[0].dependencies, seedDependencies);

  let settled = false;
  resultPromise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'the runner must wait for the seed promise');

  releaseSeed();

  const result = await resultPromise;

  assert.equal(result, expectedResult);
  assert.equal(settled, true);
});

test('the CLI entry point converts raw seed failures into safe errors', async () => {
  const rawFailure = `mongodb+srv://user:${ENV.ADMIN_PASSWORD}@cluster.example.test`;
  const loadCalls = [];

  await assert.rejects(
    () =>
      runSeedCli({
        loadEnv: () => {
          loadCalls.push('called');

          return ENV;
        },
        seedAdmin: async () => {
          throw new Error(rawFailure);
        },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Admin seed failed. Check the server configuration and try again.',
      );
      assert.ok(!error.message.includes(rawFailure));
      assert.ok(!error.message.includes(ENV.ADMIN_PASSWORD));
      return true;
    },
  );

  assert.deepEqual(loadCalls, ['called']);
});

test('the CLI entry point safely wraps environment-loader failures', async () => {
  const rawFailure = `BETTER_AUTH_SECRET=${ENV.ADMIN_PASSWORD}`;

  await assert.rejects(
    () =>
      runSeedCli({
        loadEnv: () => {
          throw new Error(rawFailure);
        },
        seedAdmin: async () => {
          throw new Error('seedAdmin must not be called when loading fails');
        },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Admin seed failed. Check the server configuration and try again.',
      );
      assert.ok(!error.message.includes(rawFailure));
      assert.ok(!error.message.includes(ENV.ADMIN_PASSWORD));
      return true;
    },
  );
});

test('formatSeedError hides raw infrastructure errors but keeps safe ApiError text', () => {
  assert.equal(
    formatSeedError(new Error(`connection string ${ENV.ADMIN_PASSWORD}`)),
    'Admin seed failed. Check the server configuration and try again.',
  );

  assert.equal(
    formatSeedError(ApiError.conflict('Safe conflict message.', 'CONFLICT')),
    'Safe conflict message.',
  );
});

test('Admin assignment needs both the explicit option and a trusted direct call', () => {
  assert.equal(isAdminCreationAllowed({}), false);
  assert.equal(isAdminCreationAllowed({ allowAdminCreation: false }), false);
  assert.equal(isAdminCreationAllowed({ allowAdminCreation: true }), true);

  assert.equal(isTrustedServerOnlyAuthCall(undefined), false);
  assert.equal(isTrustedServerOnlyAuthCall({}), true);
  assert.equal(isTrustedServerOnlyAuthCall({ headers: new Headers() }), false);
  assert.equal(isTrustedServerOnlyAuthCall({ request: {} }), false);

  const seedOnly = { allowAdminCreation: true };

  assert.equal(resolveRegistrationRole(USER_ROLES.ADMIN, {}, {}), USER_ROLES.CUSTOMER);
  assert.equal(
    resolveRegistrationRole(USER_ROLES.ADMIN, {}, seedOnly),
    USER_ROLES.ADMIN,
  );
  assert.equal(
    resolveRegistrationRole(USER_ROLES.ADMIN, { headers: new Headers() }, seedOnly),
    USER_ROLES.CUSTOMER,
  );
  assert.equal(
    resolveRegistrationRole(USER_ROLES.ADMIN, { request: {} }, seedOnly),
    USER_ROLES.CUSTOMER,
  );
  assert.equal(
    resolveRegistrationRole(USER_ROLES.CUSTOMER, {}, {}),
    USER_ROLES.CUSTOMER,
  );
  assert.equal(
    resolveRegistrationRole(USER_ROLES.VENDOR, { headers: new Headers() }, {}),
    USER_ROLES.VENDOR,
  );
  assert.equal(
    resolveRegistrationRole('unknown-role', {}, seedOnly),
    USER_ROLES.CUSTOMER,
  );
});
