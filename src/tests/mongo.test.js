import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectToDatabase,
  disconnectFromDatabase,
  getDb,
  getMongoClient,
} from '../database/mongo.js';

const ENV = Object.freeze({
  MONGODB_URI: 'mongodb://example.test:27017',
  MONGODB_DB_NAME: 'pizzahub-test',
});

function createFakeMongoClient(calls) {
  class FakeMongoClient {
    constructor(uri, options) {
      calls.push(['constructor', uri, options]);
      this.closed = false;
    }

    async connect() {
      calls.push(['connect']);
    }

    db(name) {
      calls.push(['db', name]);

      return {
        command: async (command) => {
          calls.push(['ping', command]);
          return { ok: 1 };
        },
      };
    }

    async close() {
      this.closed = true;
      calls.push(['close']);
    }
  }

  return FakeMongoClient;
}

test('concurrent connects share one cached MongoClient and connection promise', async () => {
  const calls = [];
  const MongoClient = createFakeMongoClient(calls);

  const [first, second] = await Promise.all([
    connectToDatabase(ENV, { MongoClient }),
    connectToDatabase(ENV, { MongoClient }),
  ]);

  assert.strictEqual(first.client, second.client);
  assert.strictEqual(first.db, second.db);
  assert.strictEqual(getMongoClient(), first.client);
  assert.strictEqual(getDb(), first.db);
  assert.equal(calls.filter((call) => call[0] === 'constructor').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'connect').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'ping').length, 1);

  await disconnectFromDatabase();

  assert.equal(first.client.closed, true);
  assert.throws(() => getMongoClient(), /MongoDB is not connected/);
});

test('a failed connect is not cached and can be retried', async () => {
  const failingCalls = [];
  let attempts = 0;

  class FailingMongoClient {
    constructor() {
      attempts += 1;
      failingCalls.push(['constructor']);
    }

    async connect() {
      throw new Error('connection refused');
    }

    async close() {
      failingCalls.push(['close']);
    }
  }

  await assert.rejects(() => connectToDatabase(ENV, { MongoClient: FailingMongoClient }), {
    message: /Could not connect to MongoDB/,
  });

  assert.equal(attempts, 1);

  const calls = [];
  const MongoClient = createFakeMongoClient(calls);
  const connected = await connectToDatabase(ENV, { MongoClient });

  assert.equal(attempts, 1);
  assert.strictEqual(getMongoClient(), connected.client);

  await disconnectFromDatabase();
});
