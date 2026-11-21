import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

let env;

try {
  env = loadEnv();
} catch (error) {
  console.error(`[config] ${error.message}`);
  process.exit(1);
}

const app = createApp(env);

const server = app.listen(env.PORT, () => {
  console.log(`[server] PizzaHub API listening on http://localhost:${env.PORT}`);
  console.log(`[server] Environment: ${env.NODE_ENV}`);
  console.log(`[server] Health check: http://localhost:${env.PORT}/api/health`);
});

/** Close the HTTP listener cleanly so the process can exit on a deploy signal. */
function shutdown(signal) {
  console.log(`[server] ${signal} received. Shutting down gracefully...`);

  server.close((error) => {
    if (error) {
      console.error(`[server] Error while closing: ${error.message}`);
      process.exit(1);
    }

    console.log('[server] HTTP server closed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
