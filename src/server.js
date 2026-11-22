import app, { env } from './app.js';
import { disconnectFromDatabase } from './database/mongo.js';

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
