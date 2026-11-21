# PizzaHub — Backend Server

PizzaHub is a role-based pizza ordering and delivery platform. This repository contains the **backend only**: a Node.js/Express REST API that will serve a separate Next.js client (to be created later in a different repository).

> **Status: Better Auth, JWT verification, and role-based authorization middleware are implemented.** The Express foundation, MongoDB Atlas connection, shared utilities, centralized error handling, 404 handling, rate limiting and collection/index setup are also in place. Protected business APIs and payments are deliberately not implemented yet; the middleware is ready for those routes.

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
- Centralized collection names and accessors for the three business collections
- Idempotent index initialization before the HTTP listener starts
- Health-check endpoint
- Reusable `ApiError` class carrying a safe message, HTTP status and error code
- Centralized JSON error responses (4xx details, generic 5xx message in production)
- 404 middleware for unknown routes
- API rate limiting with JSON `429` responses
- Graceful shutdown of both the HTTP server and MongoDB connection
- Better Auth with email/password, optional Google OAuth, JWT/JWKS plugin and one shared MongoDB pool
- Customer/vendor role selection at registration; role, block status and subscription changes owned exclusively by the server afterwards
- JWKS-based JWT verification with `jose` (one cached remote JWKS resolver)
- Bearer-token authentication middleware backed by the current MongoDB user record
- Reusable `requireRole(...roles)` authorization middleware

**Planned (later milestones)**

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
| Auth | Better Auth 1.7 with the official MongoDB adapter and JWT plugin |
| JWT verification | `jose` (`createRemoteJWKSet` + `jwtVerify`) |
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
| `better-auth` | Authentication hosted inside Express; JWT plugin from `better-auth/plugins` |
| `@better-auth/mongo-adapter` | Official adapter that reuses the existing `Db` and `MongoClient` |
| `jose` | Remote JWKS resolution and JWT signature/claim verification |

Nine runtime packages are installed at this point. Node 24's built-in `--env-file-if-exists` and `--watch` flags remove the need for `dotenv` and `nodemon`, and we use Node's built-in test runner instead of adding Jest.

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
    ├── auth/
    │   ├── config/
    │   │   └── better-auth.js         # Better Auth instance factory + user schema
    │   └── jwt.js                     # cached JWKS resolver + JWT claim verification
    ├── config/
    │   └── env.js                     # Zod-validated environment variables
    ├── database/
    │   ├── mongo.js                   # MongoClient lifecycle, getDb(), getMongoClient(), close
    │   ├── collections.js             # collection names + business accessors
    │   └── indexes.js                 # idempotent index initialization
    ├── middlewares/
    │   ├── authenticate.js            # Bearer token -> verified user from MongoDB
    │   ├── authorize.js               # requireRole(...) authorization factory
    │   ├── error.js                   # centralized JSON error responses
    │   ├── not-found.js               # 404 for unknown routes
    │   └── rate-limit.js              # shared API limiter
    ├── utils/
    │   └── api-error.js               # ApiError class + status helpers
    ├── tests/
    │   ├── auth.test.js               # JWT, authentication and role tests
    │   └── error.test.js              # focused error-handler tests
    └── modules/
        └── health/
            └── health.routes.js       # GET /api/health
```

Planned folders: `modules/{user,menu,browse,order,admin,payment}/`, `routes/`, `services/`, `validators/`, `scripts/`. They will be added in the milestone that uses them so the repository contains no empty placeholders.

## Installation and local setup

Requirements: Node.js 22.9 or newer, npm, and a MongoDB Atlas cluster (or a reachable MongoDB server).

```powershell
cd "C:\Users\SAYDA\Desktop\Programmig Hero\Assignments\Assignment 9 (M55)\PizzaHub\server"
npm install
Copy-Item .env.example .env
```

Edit `.env` with your local values, especially `MONGODB_URI`, `MONGODB_DB_NAME` and `BETTER_AUTH_SECRET` (at least 32 random characters; example placeholders are rejected). Do **not** commit it; `.gitignore` already excludes it. Google credentials can stay unset for local development.

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
4. `getDb()` gives other modules the selected database; `getMongoClient()` gives them the **same** client. Better Auth receives both, so it never opens a second pool and can use transactions on Atlas replica sets.
5. `disconnectFromDatabase()` closes the pool during shutdown.

If the connection fails, the process logs a fixed, descriptive message and exits with status `1`. The driver's raw error text is **never** logged, because it can contain the host, username or full connection string. Only a safe error name and numeric code are appended for debugging.

`/api/health` intentionally remains a pure liveness check and does not query MongoDB. Since the server cannot start without a working database connection, a separate database field in that response would be redundant and would make a liveness probe fail for external reasons.

## Collections and indexes

`src/database/collections.js` centralizes the names in `COLLECTIONS` and exposes `getMenuItemsCollection()`, `getOrdersCollection()` and `getTransactionsCollection()`. Each accessor calls `getDb()`, so all three share the single connection pool. `users` is the collection Better Auth uses for its `user` model (`user.modelName: "users"`); no competing user collection or custom user model exists. Better Auth also owns `session`, `account`, `verification` and `jwks`. No test users or business records are inserted by this milestone.

`src/database/indexes.js` creates indexes with explicit, fixed names, so running it repeatedly is safe. It runs after the connection ping and before `app.listen()`. A failure produces a sanitized message, closes the pool and exits with status `1`.

### `menuItems`

| Index | Purpose |
| --- | --- |
| `{ vendorId: 1, createdAt: -1 }` | Vendor's own items, newest first; the prefix also serves `vendorId`-only lookups. |
| `{ status: 1, createdAt: -1 }` | Public browse uses `status: 'approved'` only; pending, rejected and inactive items are excluded by that single field. |
| `{ category: 1, status: 1, createdAt: -1 }` | Category filter combined with the public status filter. |
| `{ location: 1, status: 1, createdAt: -1 }` | Location filter combined with the public status filter. |
| `{ createdAt: -1 }` | Admin listing of all submissions, newest first. |

### `orders`

| Index | Purpose |
| --- | --- |
| `{ customerId: 1, createdAt: -1 }` | Customer's own orders, newest first. |
| `{ vendorId: 1, status: 1, createdAt: -1 }` | Vendor's incoming orders filtered by status. |
| `{ itemId: 1, customerId: 1, deliveryDate: 1 }` | Duplicate active-order check. Deliberately **not** unique, because rejected/cancelled orders may be recreated. |
| `{ deliveryDate: 1 }` | Delivery-date scheduling lookups. |

### `transactions`

| Index | Purpose |
| --- | --- |
| `{ stripeSessionId: 1 }` (unique, sparse) | Webhook idempotency. Safe because Stripe generates and owns this immutable value; `sparse` prevents incomplete records from colliding. |
| `{ stripeSubscriptionId: 1 }` | Find records for one subscription when handling cancellation/expiration. |
| `{ vendorId: 1, createdAt: -1 }` | Vendor's payment history, newest first. |
| `{ status: 1, createdAt: -1 }` | Admin filtering by payment status. |
| `{ createdAt: -1 }` | Admin listing of all transactions, newest first. |

There is no separate `isAvailable` field: the assignment's `status` values (`pending`, `approved`, `rejected`, `inactive`) control public visibility. If the three obsolete indexes containing `isAvailable` exist from an earlier run, initialization verifies their exact key definitions and drops only those three; `_id` and every unrelated index are left untouched.

No text index or price index is created yet: those serve search/sort endpoints that are not implemented until a later milestone. The `_id` index is provided automatically by MongoDB.

## Middleware pipeline

`createApp(env)` in `src/app.js` registers middleware in this order:

1. **Helmet** — security headers.
2. **CORS** — environment-driven origin whitelist. It runs early so CORS headers are also present on error responses.
3. **Rate limiter** — rejects abusive clients before their bodies are parsed.
4. **Better Auth handler** — `app.all('/api/auth/*splat', toNodeHandler(auth))`. It must come before `express.json()` because it reads the raw request stream. The `*splat` name is required by Express 5's path-to-regexp v8.
5. **express.json** — parses JSON bodies up to 1 MB for the API's own routes.
6. **Feature routers** — currently `/api/health`; later modules mount under `/api`.
7. **404 middleware** — turns unmatched routes into an `ApiError(404)`.
8. **Error handler** — always last, so it catches errors from every earlier layer.

Better Auth writes its own JSON responses; the centralized error handler still owns all non-auth routes.

`authenticate` and `requireRole(...)` are ready for future business routes but are not mounted globally. A protected route will opt in explicitly, for example `app.delete('/api/menu/:id', authenticate, requireRole('vendor'), handler)`. No public test-only auth route was added to the production API.

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

Rate limiting has no dedicated environment variable. Authentication variables are listed below.

## API endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Returns server status and a timestamp |
| `GET` | `/api/auth/ok` | Public | Better Auth liveness check |
| `GET` | `/api/auth/jwks` | Public | JWT plugin public keys used to verify tokens |
| `GET` | `/api/auth/token` | Session | Returns a JWT for the signed-in user (401 otherwise) |
| `POST` | `/api/auth/sign-up/email` | Public | Email/password registration; send `role: "customer"` or `"vendor"` |
| `POST` | `/api/auth/sign-in/email` | Public | Email/password sign-in |
| `GET` | `/api/auth/sign-in/social` | Public | Starts Google OAuth when configured |
| `POST` | `/api/auth/sign-out` | Session | Ends the session |

Better Auth owns every `/api/auth/*` route; the table lists the ones used in this project. All other business endpoints belong to later milestones.

## Environment variables

| Variable | Used in | Notes |
| --- | --- | --- |
| `PORT` | Milestone 1 | Default `5000` |
| `NODE_ENV` | Milestone 1 | `development`, `production`, or `test` |
| `MONGODB_URI` | **Milestone 2 — required** | Atlas `mongodb+srv://` connection string; secret, never commit |
| `MONGODB_DB_NAME` | **Milestone 2 — required** | Database name selected on connect |
| `BETTER_AUTH_SECRET` | **Milestone 5 — required** | At least 32 random characters; placeholders rejected; server-side only |
| `BETTER_AUTH_URL` | **Milestone 5 — required** | Public URL of this API; base for OAuth callbacks and JWT issuer/audience |
| `CLIENT_URL` | **Milestone 5 — required** | Trusted browser origin for the future Next.js client |
| `GOOGLE_CLIENT_ID` | Milestone 5 — optional | OAuth credential; both Google variables must be real or both unset |
| `GOOGLE_CLIENT_SECRET` | Milestone 5 — optional | OAuth credential, server-side only |
| `STRIPE_SECRET_KEY` | Milestone 13 | Test-mode key during development |
| `STRIPE_WEBHOOK_SECRET` | Milestone 13 | Verifies webhook signatures |
| `STRIPE_PRICE_ID` | Milestone 13 | Premium plan price |
| `IMGBB_API_KEY` | Milestone 7 | Image upload key |
| `ADMIN_NAME` | Milestone 6 | Seed script only |
| `ADMIN_EMAIL` | Milestone 6 | Seed script only |
| `ADMIN_PASSWORD` | Milestone 6 | Seed script only |

`PORT` and `NODE_ENV` have defaults. `MONGODB_URI`, `MONGODB_DB_NAME`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `CLIENT_URL` are required. `BETTER_AUTH_SECRET` must be at least 32 characters and must not look like an example placeholder; the error message never includes the value. Empty or example-file placeholder Google values are ignored (Google sign-in stays disabled) and a safe warning is printed; a real value for only one of the two is a startup error.

## Authentication architecture

`src/auth/config/better-auth.js` exports a `createAuth(env)` factory rather than a singleton. `server.js` connects MongoDB first; `createApp(env)` then builds the auth instance so the adapter can receive the already-open `Db` and `MongoClient`. No second client or connection pool is created.

Configuration highlights:

- `emailAndPassword.enabled = true` — email/password sign-up and sign-in. Passwords must be 6–128 characters and include at least one uppercase and one lowercase letter. This check applies only to `/sign-up/email`; Google OAuth is unaffected.
- `user.modelName = "users"` — Better Auth's `user` model is stored in the required `users` collection. There is no separate user collection or hand-written auth system.
- Additional user fields: `role` (public schema accepts `customer`/`vendor`, default `customer`; `admin` exists only for trusted server-created records), `isBlocked` (boolean, default `false`), `businessName` (string), `subscriptionPlan` (`free`/`premium`, default `free`) and `subscriptionExpiresAt` (date).
- `role` is an accepted sign-up input, but the schema only knows `customer` and `vendor`. The global `before` hook rejects `admin` and any unexpected role value during sign-up; a missing role is defaulted by the create hook. `isBlocked`, `subscriptionPlan` and `subscriptionExpiresAt` remain `input: false` and are rejected if sent during registration.
- Profile updates reject `role` and every other server-owned field. The `user.update.before` database hook deletes those fields as a second layer. **Public registration can never create an Admin, and users cannot change their own role, block status or subscription.**
- The `create` database hook preserves a validated `customer`/`vendor` choice (including OAuth paths), defaults a missing/invalid role to `customer`, and always resets block/subscription fields to safe values. `businessName` is trimmed and capped at 120 characters. Future admin creation must use a server-side seed script, not a public endpoint.

### Google OAuth setup

Google is opt-in. Leave both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` unset for local development; email/password works on its own. To enable it:

1. In Google Cloud Console → **APIs & Services → Credentials**, create an **OAuth client ID** of type **Web application**.
2. Add the callback URL `http://localhost:5000/api/auth/callback/google` for local development (and `https://<your-domain>/api/auth/callback/google` in production). This comes from `BETTER_AUTH_URL`.
3. Put the real client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Never commit them, and never paste the example placeholders.
4. Restart the server. `GET /api/auth/sign-in/social` with `provider=google` then starts the flow.
5. Set `CLIENT_URL` to the frontend origin so it is trusted for cross-origin auth requests.

## JWT verification and role-based authorization

### How verification works

`src/auth/jwt.js` uses `jose` to verify tokens produced by Better Auth's JWT plugin:

- `GET /api/auth/token` gives a signed-in user a JWT. `GET /api/auth/jwks` publishes the matching **public** keys.
- The JWKS URL is built from `BETTER_AUTH_URL`: `<BETTER_AUTH_URL>/api/auth/jwks`.
- `createRemoteJWKSet()` is called **once** when the verifier is created. The resolver caches keys and only fetches again when needed, so it is not rebuilt per request.
- `jwtVerify()` checks the signature, expiration, issuer and audience. Better Auth uses `BETTER_AUTH_URL` as both issuer and audience by default, so the verifier uses the same value.
- The configured Better Auth `jwt()` call does not override `keyPairConfig.alg`; the plugin default is **EdDSA with Ed25519**. Verification explicitly allows only `EdDSA`, preventing algorithm confusion.
- A token must have a non-empty `sub`. Better Auth sets it to the user id.
- Verification failures become one generic internal error. No token, key, claim or library error text is sent to the client or logged by this module.

There is no second JWT secret and no duplicate auth system: the same Better Auth keys and configuration are the source of truth.

### Authentication middleware

`createAuthenticate(env, dependencies)` in `src/middlewares/authenticate.js`:

1. Requires an `Authorization: Bearer <token>` header; missing or malformed headers return `401`.
2. Verifies the token through the shared JWT verifier.
3. Reads `sub` and loads that user from the `users` collection owned by Better Auth.
4. Accepts both ObjectId and string ids. The MongoDB adapter maps `id` to `_id` and normally stores an ObjectId, but string ids are supported too.
5. Returns `401` if the user no longer exists.
6. Returns `403` if `isBlocked === true` in MongoDB.
7. Attaches a sanitized `req.user` containing only `id`, `name`, `email`, `image`, `role`, `businessName`, `subscriptionPlan` and `subscriptionExpiresAt`. Password hashes, reset tokens and other private fields are never attached.

Role, subscription and blocked status are read from **MongoDB**, not from JWT claims. This means a role or ban change takes effect on the next request without waiting for the short-lived token to expire. Database failures and JWKS fetch failures are passed to the centralized error handler as generic `500` responses; they are never disguised as bad credentials or exposed to clients.

### Role authorization middleware

`requireRole(...roles)` in `src/middlewares/authorize.js` checks `req.user.role` after authentication. It supports `customer`, `vendor` and `admin`, and rejects unknown role names when the middleware is created.

```js
app.get('/api/admin/example', authenticate, requireRole('admin'), handler);
app.post('/api/menu', authenticate, requireRole('vendor'), handler);
```

Authentication and authorization stay separate: `authenticate` answers **who the user is**; `requireRole` answers **whether that user may do this**.

### `401` vs `403`

| Code | Meaning here |
| --- | --- |
| `401 UNAUTHORIZED` | The request has no usable Bearer token, the token is invalid/expired, or its user no longer exists. |
| `403 FORBIDDEN` | The token and user are valid, but the account is blocked or its database role is not allowed for the route. |

Both use the normal JSON error envelope. The messages are fixed and safe; internal verification and database details are never exposed.

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
