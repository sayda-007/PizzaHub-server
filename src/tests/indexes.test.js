import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toSafeIndexError } from '../database/indexes.js';

test('duplicate index migration failures name the index and require manual resolution', () => {
  const error = Object.assign(new Error('E11000 duplicate key error with collection details'), {
    name: 'MongoServerError',
    code: 11000,
  });

  const message = toSafeIndexError(error, 'activeOrderKey_1');

  assert.match(message, /activeOrderKey_1/);
  assert.match(message, /existing documents conflict/);
  assert.match(message, /No data was changed/);
  assert.match(message, /Resolve the conflicting documents manually/);
  assert.match(message, /MongoServerError/);
  assert.match(message, /code 11000/);
  assert.doesNotMatch(message, /E11000 duplicate key error with collection details/);
});

test('duplicate errors nested in writeErrors are also recognized', () => {
  const error = { name: 'MongoBulkWriteError', writeErrors: [{ code: 11000 }] };
  const message = toSafeIndexError(error, 'customerId_1_createdAt_-1');

  assert.match(message, /customerId_1_createdAt_-1/);
  assert.match(message, /No data was changed/);
});

test('a duplicate error without an index name uses correct plural wording', () => {
  const message = toSafeIndexError({ code: 11000 });

  assert.match(message, /unique indexes/);
  assert.doesNotMatch(message, /indexs/);
});

test('ordinary index failures stay generic and do not expose driver text', () => {
  const error = Object.assign(new Error('connection string with secret'), {
    name: 'MongoServerError',
    code: 7,
  });

  const message = toSafeIndexError(error, 'createdAt_-1');

  assert.match(message, /createdAt_-1/);
  assert.doesNotMatch(message, /connection string with secret/);
  assert.match(message, /MongoServerError/);
  assert.match(message, /code 7/);
});
