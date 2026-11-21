import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { connectToDatabase, disconnectFromDatabase } from './database/mongo.js';

let env;

try {
  env = loadEnv();
} catch (error) {
  console.error(`[config] ${error.message}`);
  process.exit(1);
}

// Do not open the HTTP port until MongoDB is ready. This avoids accepting
// requests during a window where the app could not serve them correctly.
try {
  await connectToDatabase(env);
  console.log('[database] Connected to MongoDB.');
} catch (error) {
  console.error(`[database] ${error.message}`);
  process.exit(1);
}

const app = createApp(env);

const server = app.listen(env.PORT, () => {
  console.log(`[server] PizzaHub API listening on http://localhost:${env.PORT}`);
  console.log(`[server] Environment: ${env.NODE_ENV}`);
  console.log(`[server] Health check: http://localhost:${env.PORT}/api/health`);
});

let shuttingDown = false;

/** Close the HTTP listener first, then the database pool. */
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[server] ${signal} received. Shutting down gracefully...`);

  let httpError = null;

  await new Promise((resolve) => {
    server.close((error) => {
      httpError = error;
      resolve();
    });
  });

  if (httpError) {
    console.error(`[server] Error while closing HTTP server: ${httpError.message}`);
  } else {
    console.log('[server] HTTP server closed.');
  }

  try {
    await disconnectFromDatabase();
    console.log('[database] MongoDB connection closed.');
    process.exit(httpError ? 1 : 0);
  } catch (error) {
    console.error(`[database] ${error.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
