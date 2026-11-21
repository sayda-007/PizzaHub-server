# PizzaHub — Backend Server

PizzaHub is a role-based pizza ordering and delivery platform. This repository contains the **backend only**: a Node.js/Express REST API that will serve a separate Next.js client (to be created later in a different repository).

> **Status: Milestone 3 of 15.** The Express foundation, MongoDB Atlas connection, shared utilities, centralized error handling, 404 handling and rate limiting are implemented. Authentication, business APIs, and payments are deliberately not implemented yet.

---

## Project description

Customers will browse approved pizza menus and place orders. Vendors will manage restaurants, menus, orders, and premium subscriptions. Administrators will manage users, moderate menu items, and read transaction records. The three roles are `customer`, `vendor`, and `admin`.

## Backend features

**Implemented now**

- Express 5 application with ECMAScript Modules
- Security headers via Helmet
- Environment-driven CORS with credentials
- Startup validation of environment variables with Zod
- MongoDB Atlas connection with the official driver, selected by `MONGODB_DB_NAME`
- Startup blocked until MongoDB responds to a ping
- Sanitized database errors that never print the connection string or credentials
- Health-check endpoint
- Reusable `ApiError` class carrying a safe message, HTTP status and error code
- Centralized JSON error responses (4xx details, generic 5xx message in production)
- 404 middleware for unknown routes
- API rate limiting with JSON `429` responses
- Graceful shutdown of both the HTTP server and MongoDB connection

**Planned (later milestones)**

- Collection helpers and indexes
- Better Auth (email/password + Google) hosted inside Express, MongoDB adapter, JWT plugin
- JWKS-based JWT verification and role-based authorization
- Vendor menu CRUD, availability, and subscription limits
- Public menu browsing with search, filters, sorting, and pagination
- Customer and vendor order workflows
- Admin dashboard, moderation, and user management
- Stripe premium subscription checkout and verified webhooks
- ImgBB image uploads and server-side validation
- Integration tests and deployment documentation

## Technology stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22.9+ (developed on Node 24) |
| Language | JavaScript, ESM (`"type": "module"`) |
| Web framework | Express 5 |
| Database | MongoDB Atlas via the official `mongodb` Node.js driver |
| Auth | Better Auth (from Milestone 4) |
| JWT verification | `jose` (from Milestone 5) |
| Payments | Stripe Checkout + webhooks (from Milestone 13) |
| Validation | Zod |

## Important npm packages

| Package | Purpose |
| --- | --- |
| `express` | HTTP server and routing |
| `helmet` | Security-related HTTP headers |
| `cors` | Cross-origin rules for the future client |
| `zod` | Runtime validation of requests and environment variables |
| `mongodb` | Official MongoDB driver: `MongoClient`, database selection, ping and close |
| `express-rate-limit` | Shared API request limiter with standard rate-limit headers |

Six runtime packages are installed at this point. Node 24's built-in `--env-file-if-exists` and `--watch` flags remove the need for `dotenv` and `nodemon`, and we use Node's built-in test runner instead of adding Jest.

## Project structure

```
server/
├── .env.example                       # documented placeholder variables
├── .gitignore
├── package.json
├── README.md
└── src/
    ├── server.js                      # process entry point + graceful shutdown
    ├── app.js                         # Express app factory
    ├── config/
    │   └── env.js                     # Zod-validated environment variables
    ├── database/
    │   └── mongo.js                   # MongoClient lifecycle, getDb(), close
    ├── middlewares/
    │   ├── error.js                   # centralized JSON error responses
    │   ├── not-found.js               # 404 for unknown routes
    │   └── rate-limit.js              # shared API limiter
    ├── utils/
    │   └── api-error.js               # ApiError class + status helpers
    └── modules/
        └── health/
            └── health.routes.js       # GET /api/health
```

Planned folders: `auth/`, `modules/{user,menu,browse,order,admin,payment}/`, `routes/`, `services/`, `validators/`, `scripts/`, `tests/`. They will be added in the milestone that uses them so the repository contains no empty placeholders.

## Installation and local setup

Requirements: Node.js 22.9 or newer, npm, and a MongoDB Atlas cluster (or a reachable MongoDB server).

```powershell
cd "C:\Users\SAYDA\Desktop\Programmig Hero\Assignments\Assignment 9 (M55)\PizzaHub\server"
npm install
Copy-Item .env.example .env
```

Edit `.env` with your local values, especially `MONGODB_URI` and `MONGODB_DB_NAME`. Do **not** commit it; `.gitignore` already excludes it.

To connect to Atlas from your machine, add your current public IP to the cluster's Network Access (IP allowlist), and URL-encode special characters in the password inside the connection string.

## Running the server

```powershell
# Production-style start
npm start

# Development (auto-restart on file changes)
npm run dev

# Syntax checks
npm run check
```

The server listens on `PORT` (default `5000`).

## Database connection

`src/database/mongo.js` owns a single `MongoClient` for the whole process:

1. `connectToDatabase(env)` creates the client from `MONGODB_URI` and selects the database named by `MONGODB_DB_NAME`.
2. It verifies connectivity with `{ ping: 1 }` before resolving.
3. `src/server.js` awaits that call **before** `app.listen()`, so no request is accepted while the database is unavailable.
4. `getDb()` gives future modules access to the same connection pool.
5. `disconnectFromDatabase()` closes the pool during shutdown.

If the connection fails, the process logs a fixed, descriptive message and exits with status `1`. The driver's raw error text is **never** logged, because it can contain the host, username or full connection string. Only a safe error name and numeric code are appended for debugging.

`/api/health` intentionally remains a pure liveness check and does not query MongoDB. Since the server cannot start without a working database connection, a separate database field in that response would be redundant and would make a liveness probe fail for external reasons.

## Middleware pipeline

`createApp(env)` in `src/app.js` registers middleware in this order:

1. **Helmet** — security headers.
2. **CORS** — environment-driven origin whitelist. It runs early so CORS headers are also present on error responses.
3. **Rate limiter** — rejects abusive clients before their bodies are parsed.
4. **express.json** — parses JSON bodies up to 1 MB.
5. **Feature routers** — currently `/api/health`; later modules mount under `/api`.
6. **404 middleware** — turns unmatched routes into an `ApiError(404)`.
7. **Error handler** — always last, so it catches errors from every earlier layer.

## Error responses

All failures share one envelope:

```json
{ "success": false, "message": "...", "code": "..." }
```

- `ApiError` carries a deliberately safe message, an HTTP status and a machine-readable code. Helpers exist for 400, 401, 403, 404, 409 and 429.
- Zod validation failures become `400 VALIDATION_ERROR` with a `details` array of field/message pairs.
- Malformed JSON becomes `400 INVALID_JSON`.
- Unexpected errors become `500 INTERNAL_SERVER_ERROR` with a generic message in production. In development the message is included to help debugging. Stack traces are logged on the server only and are never sent to a client.

## Rate limiting

`src/middlewares/rate-limit.js` exports `createApiLimiter(env)`:

| Environment | Requests per 15-minute window |
| --- | --- |
| `development` | 500 |
| `test` | 10,000 |
| `production` | 100 |

IETF draft-7 `RateLimit` and `RateLimit-Policy` headers are emitted, along with `Retry-After` when throttled. `/api/health` is exempt so monitoring probes are never throttled. When the limit is exceeded, the limiter passes an `ApiError(429, …, 'RATE_LIMITED')` to the centralized handler, giving the same JSON shape as every other error. The limiter uses the default in-process memory store; a shared store would be needed if the API is later scaled across multiple instances.

No new environment variables were introduced in this milestone.

## API endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Returns server status and a timestamp |

All other endpoints are part of later milestones.

## Environment variables

| Variable | Used in | Notes |
| --- | --- | --- |
| `PORT` | Milestone 1 | Default `5000` |
| `NODE_ENV` | Milestone 1 | `development`, `production`, or `test` |
| `MONGODB_URI` | **Milestone 2 — required** | Atlas `mongodb+srv://` connection string; secret, never commit |
| `MONGODB_DB_NAME` | **Milestone 2 — required** | Database name selected on connect |
| `BETTER_AUTH_SECRET` | Milestone 4 | Secret, server-side only |
| `BETTER_AUTH_URL` | Milestone 4 | Public URL of this API |
| `CLIENT_URL` | Milestone 1 | Allowed browser origin |
| `GOOGLE_CLIENT_ID` | Milestone 4 | OAuth credential |
| `GOOGLE_CLIENT_SECRET` | Milestone 4 | OAuth credential, server-side only |
| `STRIPE_SECRET_KEY` | Milestone 13 | Test-mode key during development |
| `STRIPE_WEBHOOK_SECRET` | Milestone 13 | Verifies webhook signatures |
| `STRIPE_PRICE_ID` | Milestone 13 | Premium plan price |
| `IMGBB_API_KEY` | Milestone 7 | Image upload key |
| `ADMIN_NAME` | Milestone 6 | Seed script only |
| `ADMIN_EMAIL` | Milestone 6 | Seed script only |
| `ADMIN_PASSWORD` | Milestone 6 | Seed script only |

`PORT` and `NODE_ENV` have defaults. `MONGODB_URI` and `MONGODB_DB_NAME` are now required. All remaining variables are parsed but optional until their milestone is implemented.

## Authentication and authorization

Better Auth will be the only authentication system and will be hosted inside this Express server. The future Next.js client will call it over HTTP. Public registration will never be able to assign the `admin` role, and users will never be able to change their own role or subscription through profile updates. Details will be documented when implemented in Milestones 4–6.

## JWT verification

The JWT plugin will expose token and JWKS endpoints. Protected routes will verify the signature, issuer, audience, and expiry with `jose`, then reload the user from MongoDB so role, block status, and subscription changes take effect immediately. Unauthenticated requests will return `401`; forbidden requests will return `403`.

## Advanced search and sorting

The public menu endpoint will support name search, category and location filters, advanced text search, price sorting in both directions, and pagination. Implementation notes will be added in Milestone 9.

## Stripe webhooks

Stripe will be used only for vendor premium subscriptions, never for pizza orders. The webhook route will use the raw request body, verify signatures, be idempotent, and be the only place that activates Premium — the success redirect will never be trusted. Details will be added in Milestone 13.

## Deployment

Deployment instructions will be added after the backend is complete. The intended shape is a Node process behind a reverse proxy, with all secrets supplied through environment variables and no credentials in source control.

## Client repository

To be added later.

## License

UNLICENSED — assignment project.
