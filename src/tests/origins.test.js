import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAllowedOrigins } from '../utils/origins.js';

test('CORS origins ignore configured URL paths and trailing slashes', () => {
  assert.deepEqual(
    buildAllowedOrigins({
      CLIENT_URL: 'https://client.example.test/app/',
      BETTER_AUTH_URL: 'https://api.example.test/',
    }),
    ['https://client.example.test', 'https://api.example.test'],
  );
});

test('CORS origins de-duplicate identical client and auth origins', () => {
  assert.deepEqual(
    buildAllowedOrigins({
      CLIENT_URL: 'https://pizzahub.example.test',
      BETTER_AUTH_URL: 'https://pizzahub.example.test/',
    }),
    ['https://pizzahub.example.test'],
  );
});
