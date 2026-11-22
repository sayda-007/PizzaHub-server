import { MongoClient } from 'mongodb';

/**
 * MongoDB connection lifecycle.
 *
 * The client and database are module-level state so every later module can ask
 * for the same pool through getDb() instead of opening a new connection.
 */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

let client = null;
let database = null;
let connectionPromise = null;

/**
 * Build a human-readable failure message WITHOUT echoing the driver's raw
 * error text. Driver messages can contain the connection string or the parts
 * of it (host, username), so only a fixed message plus a safe name/code is used.
 */
function toSafeDatabaseError(error) {
  let message = 'Could not connect to MongoDB. Check MONGODB_URI and MONGODB_DB_NAME.';

  if (error?.name === 'MongoParseError') {
    message = 'MONGODB_URI is not a valid MongoDB connection string.';
  } else if (error?.code === 18) {
    message = 'MongoDB authentication failed. Check the credentials in MONGODB_URI.';
  } else if (
    error?.name === 'MongoServerSelectionError' ||
    error?.name === 'MongoTimeoutError'
  ) {
    message =
      'MongoDB is unreachable. Check the Atlas cluster status, network access / IP allowlist, and the host in MONGODB_URI.';
  }

  const diagnostic = [];

  if (typeof error?.name === 'string' && /^[A-Za-z]+$/.test(error.name)) {
    diagnostic.push(error.name);
  }

  if (Number.isInteger(error?.code)) {
    diagnostic.push(`code ${error.code}`);
  }

  return diagnostic.length > 0 ? `${message} [${diagnostic.join(', ')}]` : message;
}

/**
 * Connect, select the configured database and verify the connection with a
 * ping. Resolves only when MongoDB is actually ready to serve requests.
 */
export async function connectToDatabase(env, dependencies = {}) {
  // One promise per warm instance. Concurrent cold-start callers share the
  // same MongoClient instead of racing to create separate pools.
  if (connectionPromise) {
    return connectionPromise;
  }

  const MongoClientImpl = dependencies.MongoClient ?? MongoClient;

  connectionPromise = (async () => {
    const mongoClient = new MongoClientImpl(env.MONGODB_URI, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });

    try {
      await mongoClient.connect();

      const db = mongoClient.db(env.MONGODB_DB_NAME);
      await db.command({ ping: 1 });

      client = mongoClient;
      database = db;

      return { client, db };
    } catch (error) {
      await mongoClient.close().catch(() => {});
      throw new Error(toSafeDatabaseError(error));
    }
  })();

  try {
    return await connectionPromise;
  } catch (error) {
    // A failed attempt must be retried on the next call, not cached forever.
    connectionPromise = null;
    throw error;
  }
}

/** Give other modules access to the already-connected database. */
export function getDb() {
  if (!database) {
    throw new Error('MongoDB is not connected. Call connectToDatabase() during startup.');
  }

  return database;
}

/**
 * Give other modules access to the SAME connected client. Adapters that need
 * transactions (for example Better Auth) receive this client instead of
 * creating their own MongoClient, so the process keeps exactly one pool.
 */
export function getMongoClient() {
  if (!client) {
    throw new Error('MongoDB is not connected. Call connectToDatabase() during startup.');
  }

  return client;
}

/** Close the pool. Safe to call even if the connection never opened. */
export async function disconnectFromDatabase() {
  // Wait for an in-flight connect as well, so a shutdown during startup cannot
  // leave an open pool behind.
  if (connectionPromise) {
    await connectionPromise.catch(() => {});
  }

  if (!client) {
    connectionPromise = null;
    return;
  }

  const currentClient = client;

  client = null;
  database = null;
  connectionPromise = null;

  try {
    await currentClient.close();
  } catch {
    throw new Error('Failed to close the MongoDB connection.');
  }
}
