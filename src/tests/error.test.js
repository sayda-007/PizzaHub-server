import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createErrorHandler } from '../middlewares/error.js';
import { ApiError } from '../utils/api-error.js';

const SECRET = 'FAKE_SECRET_DO_NOT_LEAK';
const production = { NODE_ENV: 'production' };
const development = { NODE_ENV: 'development' };

function run(
  handler,
  error,
  env = production,
  req = { method: 'GET', path: '/test' },
  resOverrides = {},
) {
  const res = {
    headersSent: resOverrides.headersSent ?? false,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  let forwarded = null;
  handler(error, req, res, (err) => {
    forwarded = err;
  });

  return { status: res.statusCode, body: res.body, forwarded };
}

const realConsoleError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realConsoleError;
});

test('ApiError responses keep their status, message and code', () => {
  const badRequest = run(createErrorHandler(production), ApiError.badRequest('Bad input', 'BAD_INPUT'));
  assert.equal(badRequest.status, 400);
  assert.deepEqual(badRequest.body, { success: false, message: 'Bad input', code: 'BAD_INPUT' });

  const notFound = run(createErrorHandler(production), ApiError.notFound());
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, 'NOT_FOUND');

  const limited = run(
    createErrorHandler(production),
    ApiError.tooManyRequests('Too many requests. Please try again later.', 'RATE_LIMITED'),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
});

test('malformed JSON returns fixed 400 INVALID_JSON without parser details', () => {
  const error = {
    type: 'entity.parse.failed',
    statusCode: 400,
    expose: true,
    message: `Unexpected token containing ${SECRET}`,
  };

  const result = run(createErrorHandler(production), error);

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Invalid JSON payload.',
    code: 'INVALID_JSON',
  });
  assert.ok(!JSON.stringify(result.body).includes(SECRET));
});

test('oversized JSON returns fixed 413 PAYLOAD_TOO_LARGE', () => {
  const error = {
    type: 'entity.too.large',
    statusCode: 413,
    expose: true,
    message: `Request body ${SECRET} is too large`,
  };

  const result = run(createErrorHandler(production), error);

  assert.equal(result.status, 413);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Request payload is too large.',
    code: 'PAYLOAD_TOO_LARGE',
  });
  assert.ok(!JSON.stringify(result.body).includes(SECRET));
});

test('Zod-style validation errors keep 400, VALIDATION_ERROR and details', () => {
  const error = {
    name: 'ZodError',
    issues: [{ path: ['price'], message: 'Expected number, received string' }],
  };

  const result = run(createErrorHandler(production), error);

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'VALIDATION_ERROR');
  assert.equal(result.body.message, 'Validation failed.');
  assert.deepEqual(result.body.details, [
    { field: 'price', message: 'Expected number, received string' },
  ]);
});

test('arbitrary error with expose: true is still generic 500 in production', () => {
  const error = new Error(SECRET);
  error.expose = true;
  error.statusCode = 400;
  error.code = 'LEAKED_CODE';

  const result = run(createErrorHandler(production), error);
  const serialized = JSON.stringify(result.body);

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    success: false,
    message: 'An unexpected error occurred.',
    code: 'INTERNAL_SERVER_ERROR',
  });
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes('LEAKED_CODE'));
  assert.ok(!serialized.includes('at '));
});

test('arbitrary error without expose is generic 500 in production', () => {
  const result = run(createErrorHandler(production), new Error(SECRET));

  assert.equal(result.status, 500);
  assert.ok(!JSON.stringify(result.body).includes(SECRET));
});

test('development still shows unexpected messages for debugging', () => {
  const result = run(createErrorHandler(development), new Error(SECRET));

  assert.equal(result.body.message, SECRET);
  assert.equal(result.body.code, 'INTERNAL_SERVER_ERROR');
  assert.ok(!JSON.stringify(result.body).includes('at '));
});

test('errors are forwarded when headers were already sent', () => {
  const error = new Error(SECRET);
  const result = run(
    createErrorHandler(production),
    error,
    production,
    { method: 'GET', path: '/test' },
    { headersSent: true },
  );

  assert.equal(result.forwarded, error);
  assert.equal(result.body, null);
});
