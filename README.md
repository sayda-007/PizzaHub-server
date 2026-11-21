# PizzaHub — Backend Server

PizzaHub is a role-based pizza ordering and delivery platform. This repository contains the **backend only**: a Node.js/Express REST API that will serve a separate Next.js client (to be created later in a different repository).

> **Status: Better Auth, JWT verification, role-based authorization, the `/api/users/me` profile API, the Admin seed script, vendor menu management with ImgBB uploads, Free/Premium menu item limits, and public menu browsing are implemented.** The Express foundation, MongoDB Atlas connection, shared utilities, centralized error handling, 404 handling, rate limiting and collection/index setup are also in place. Orders, dashboard and payment APIs are deliberately not implemented yet; the middleware is ready for those routes.

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
- `GET /api/users/me` for the current user's safe profile
- `PATCH /api/users/me` for `name`, `image`, and vendor-only `businessName`
- Idempotent, server-only Admin seed that uses Better Auth's password hashing
- Vendor-only menu create, list, update, availability toggle and delete APIs
- Public menu browsing with validated search, filters, sorting and pagination
- Ownership checks inside every MongoDB menu query
- Server-side Free/Premium menu item limits with pending items reserving slots
- ImgBB image uploads through Multer memory storage and built-in `fetch`

**Planned (later milestones)**

- Customer and vendor order workflows
- Admin dashboard, moderation, and user management
- Stripe premium subscription checkout and verified webhooks
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
| Image uploads | Multer memory storage + ImgBB API v1 with built-in `fetch` |
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
| `multer` | Parses multipart image uploads into memory for ImgBB |

Ten runtime packages are installed at this point. Node 24's built-in `--env-file-if-exists` and `--watch` flags remove the need for `dotenv` and `nodemon`, and we use Node's built-in test runner instead of adding Jest. ImgBB uses built-in `fetch`, `FormData` and `Blob`, so no HTTP client package was added.

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
    ├── services/
    │   └── imgbb.js                   # Multer limits + ImgBB upload client
    ├── scripts/
    │   └── seed-admin.js              # manual Admin seed via Better Auth
    ├── tests/
    │   ├── auth.test.js               # JWT, authentication and role tests
    │   ├── error.test.js              # focused error-handler tests
    │   ├── user.test.js               # profile endpoint tests with fakes
    │   ├── seed-admin.test.js         # seed tests with mocks + in-memory auth
    │   ├── imgbb.test.js              # upload validation with injected fetch
    │   └── menu.test.js               # vendor menu API with fake collections
    └── modules/
        ├── health/
        │   └── health.routes.js       # GET /api/health
        ├── user/
        │   ├── user.routes.js         # /api/users/me routing
        │   ├── user.controller.js     # Express handlers and safe JSON
        │   ├── user.service.js        # explicit $set updates + reload
        │   └── user.validator.js      # Zod profile validation
        └── menu/
            ├── menu.routes.js         # vendor-only routing + scoped Multer
            ├── menu.controller.js     # request/response handling
            ├── menu.service.js        # ownership-aware MongoDB queries
            └── menu.validator.js      # Zod body, public query and pagination validation
```

Planned folders: `modules/{browse,order,admin,payment}/` and `routes/`. They will be added in the milestone that uses them so the repository contains no empty placeholders.

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

# Tests (no database or network required)
npm test

# Create the Admin account described by ADMIN_* variables
npm run seed:admin
```

The server listens on `PORT` (default `5000`). The seed command is a separate manual step; it is never started by `npm start` or `npm run dev`.

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

`src/database/collections.js` centralizes the names in `COLLECTIONS` and exposes `getMenuItemsCollection()`, `getOrdersCollection()` and `getTransactionsCollection()`. Each accessor calls `getDb()`, so all three share the single connection pool. `users` is the collection Better Auth uses for its `user` model (`user.modelName: "users"`); no competing user collection or custom user model exists. Better Auth also owns `session`, `account`, `verification` and `jwks`. Tests use in-memory or injected fake stores and insert no Atlas records; the only code that creates an Admin is the explicit `npm run seed:admin` command.

`src/database/indexes.js` creates indexes with explicit, fixed names, so running it repeatedly is safe. It runs after the connection ping and before `app.listen()`. A failure produces a sanitized message, closes the pool and exits with status `1`.

### `menuItems`

| Index | Purpose |
| --- | --- |
| `{ vendorId: 1, createdAt: -1 }` | Vendor's own items, newest first; the prefix also serves `vendorId`-only lookups. |
| `{ status: 1, createdAt: -1 }` | Public browse equality on `status: 'approved'`, newest first. The separate `isAvailable: true` equality is applied by MongoDB. |
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

`isAvailable` is a vendor-controlled boolean. Its old compound indexes were from a different design and are still removed: initialization verifies their exact key definitions and drops only those three; `_id` and every unrelated index are left untouched. Vendor listing uses the existing `{ vendorId: 1, createdAt: -1 }` index, and public browsing reuses the status/category/location indexes above.

Public search uses an escaped regular expression against `itemName` and `description`, so no text index is created. Price sorting is performed by MongoDB with the existing status prefix as the starting filter; no dedicated price index is added speculatively. The `_id` index is provided automatically by MongoDB.

## Middleware pipeline

`createApp(env)` in `src/app.js` registers middleware in this order:

1. **Helmet** — security headers.
2. **CORS** — environment-driven origin whitelist. It runs early so CORS headers are also present on error responses.
3. **Rate limiter** — rejects abusive clients before their bodies are parsed.
4. **Better Auth handler** — `app.all('/api/auth/*splat', toNodeHandler(auth))`. It must come before `express.json()` because it reads the raw request stream. The `*splat` name is required by Express 5's path-to-regexp v8.
5. **express.json** — parses JSON bodies up to 1 MB for the API's own routes.
6. **Feature routers** — currently `/api/health`, `/api/users` and `/api/menu`; later modules mount under `/api`.
7. **404 middleware** — turns unmatched routes into an `ApiError(404)`.
8. **Error handler** — always last, so it catches errors from every earlier layer.

Better Auth writes its own JSON responses; the centralized error handler still owns all non-auth routes.

`authenticate` is mounted explicitly on `/api/users/me` and every vendor management route under `/api/menu`. `GET /api/menu` is the only public menu route; its exact path does not capture `/mine`, which keeps its own auth and vendor guards. `requireRole('vendor')` runs after authentication on all management routes. Multer is mounted only on `POST /api/menu`, and only after those two guards, so unauthenticated clients cannot make the server parse their files. Nothing is mounted globally, Better Auth's catch-all still runs first, and no public test-only auth route was added to the production API.

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
| `GET` | `/api/users/me` | Bearer JWT | Returns the current user's safe profile |
| `PATCH` | `/api/users/me` | Bearer JWT | Updates `name`, `image`, and vendor-only `businessName` |
| `GET` | `/api/menu` | Public | Browses approved available items with search, filters, sorting and pagination |
| `POST` | `/api/menu` | Bearer JWT + Vendor | Creates a pending item with uploaded images |
| `GET` | `/api/menu/mine` | Bearer JWT + Vendor | Lists only the vendor's own items with pagination |
| `PATCH` | `/api/menu/:id` | Bearer JWT + Vendor | Updates an owned item |
| `PATCH` | `/api/menu/:id/availability` | Bearer JWT + Vendor | Toggles `isAvailable` on an owned item |
| `DELETE` | `/api/menu/:id` | Bearer JWT + Vendor | Deletes an owned item |

Better Auth owns every `/api/auth/*` route; the table lists the ones used in this project. `/api/users/*` and `/api/menu/*` use the JWT middleware instead of auth cookies. All other business endpoints belong to later milestones.

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
| `IMGBB_API_KEY` | Vendor menu uploads | Optional at startup; required when a menu image is uploaded; placeholders are rejected |
| `ADMIN_NAME` | Admin seed script | Required only when running `npm run seed:admin`; placeholders are rejected |
| `ADMIN_EMAIL` | Admin seed script | Real address required; `example.com`/`example.test` placeholders are rejected |
| `ADMIN_PASSWORD` | Admin seed script | 6–128 characters with at least one uppercase and one lowercase letter |

`PORT` and `NODE_ENV` have defaults. `MONGODB_URI`, `MONGODB_DB_NAME`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `CLIENT_URL` are required. `BETTER_AUTH_SECRET` must be at least 32 characters and must not look like an example placeholder; the error message never includes the value. Empty or example-file placeholder Google values are ignored (Google sign-in is disabled) and a safe warning is printed; a real value for only one of the two is a startup error. The three `ADMIN_*` variables stay optional at server startup; the seed script validates them when it runs and never prints them. `IMGBB_API_KEY` is also optional at startup so the server can run without uploads, but a menu image upload returns a safe error until a real key is configured.

## Authentication architecture

`src/auth/config/better-auth.js` exports a `createAuth(env)` factory rather than a singleton. `server.js` connects MongoDB first; `createApp(env)` then builds the auth instance so the adapter can receive the already-open `Db` and `MongoClient`. No second client or connection pool is created.

Configuration highlights:

- `emailAndPassword.enabled = true` — email/password sign-up and sign-in. Passwords must be 6–128 characters and include at least one uppercase and one lowercase letter. This check applies only to `/sign-up/email`; Google OAuth is unaffected.
- `user.modelName = "users"` — Better Auth's `user` model is stored in the required `users` collection. There is no separate user collection or hand-written auth system.
- Additional user fields: `role` (public schema accepts `customer`/`vendor`, default `customer`; `admin` exists only for records created by the trusted seed script), `isBlocked` (boolean, default `false`), `businessName` (string), `subscriptionPlan` (`free`/`premium`, default `free`), `subscriptionStatus` (`active`/`inactive`/`past_due`/`canceled`, default `inactive`) and `subscriptionExpiresAt` (date).
- `createAuth(env)` disables Admin creation by default. The only way to enable the special path is `createAuth(env, { allowAdminCreation: true })`, used by the seed script. Even then, Admin is accepted only from a direct `auth.api` call with no `headers` and no `request`; an HTTP-style sign-up is still rejected.
- `role` is an accepted sign-up input, but the schema only knows `customer` and `vendor`. The global `before` hook rejects `admin` and any unexpected role value on HTTP sign-up requests. A missing role is still defaulted by the create hook. `isBlocked`, `subscriptionPlan`, `subscriptionStatus` and `subscriptionExpiresAt` remain `input: false` and are rejected if sent during registration.
- Profile updates reject `role` and every other server-owned field. The `user.update.before` database hook deletes those fields as a second layer. **Public registration can never create an Admin, and users cannot change their own role, block status or subscription.**
- The `create` database hook preserves a validated `customer`/`vendor` choice (including OAuth paths), defaults a missing/invalid role to `customer`, and always resets block/subscription fields to safe values. It preserves `admin` only when the explicit seed-only option and the direct-call shape are both present. `businessName` is trimmed and capped at 120 characters.

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
7. Attaches a sanitized `req.user` containing only `id`, `name`, `email`, `image`, `role`, `businessName`, `subscriptionPlan`, `subscriptionStatus` and `subscriptionExpiresAt`. Password hashes, reset tokens and other private fields are never attached.

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

## Profile API

The four files in `src/modules/user/` keep the profile feature small and testable:

| File | Responsibility |
| --- | --- |
| `user.routes.js` | Mounts `/me` with `authenticate` per route |
| `user.controller.js` | Reads `req.user`, calls the service, returns `{ user }` |
| `user.service.js` | Builds an explicit `$set`, writes, reloads, sanitizes |
| `user.validator.js` | Strict Zod validation of the request body |

`GET /api/users/me` requires `Authorization: Bearer <jwt>`. A session cookie is deliberately not accepted. The token is verified, the user is reloaded from MongoDB, and the response contains only `id`, `name`, `email`, `image`, `role`, `businessName`, `subscriptionPlan`, `subscriptionStatus` and `subscriptionExpiresAt`. Password hashes, reset tokens, `isBlocked` and other private fields are excluded by the same `sanitizeUser()` helper used by the authentication middleware.

`PATCH /api/users/me` accepts only:

- `name` — trimmed text, 1–120 characters
- `image` — an `http`/`https` URL or `null` to clear it
- `businessName` — vendor-only, or `null` to clear it

The body is parsed with Zod `.strict()`, so an empty body returns `400 EMPTY_UPDATE`, an unknown field returns `400 VALIDATION_ERROR`, and reserved fields such as `role`, `email`, `isBlocked`, `subscriptionPlan`, `subscriptionStatus` or `password` return `400 FORBIDDEN_FIELD`. A non-vendor sending `businessName` gets `403 FORBIDDEN_FIELD`.

The service builds `$set` from its own allow-list; `req.body` is never spread into MongoDB. It adds a server-generated `updatedAt`, writes with `updateOne`, then reloads the user and returns the sanitized profile. A blocked user gets `403`, a deleted user gets `401`, and infrastructure failures become generic `500` responses through the centralized handler.

## Vendor menu management

The four files in `src/modules/menu/` keep this feature separate from users and auth. `src/services/imgbb.js` owns upload parsing and ImgBB communication.

### Menu item structure

| Field | Owner | Notes |
| --- | --- | --- |
| `vendorId` | Server | Copied from `req.user.id`; never read from the request body |
| `itemName` | Vendor | Trimmed text, 2–120 characters |
| `category` | Vendor | One of the fixed categories below |
| `description` | Vendor | Trimmed text, up to 1000 characters |
| `price` | Vendor | Positive number, at most two decimal places, maximum `10000` |
| `location` | Vendor | Trimmed text, up to 120 characters |
| `images` | ImgBB | Direct URLs returned by a successful upload |
| `status` | Server | Always `pending` on create; only Admin moderation may change it later |
| `createdAt` | Server | Set once with `new Date()` |
| `isAvailable` | Vendor | `true` on create; toggleable by the owning vendor |
| `updatedAt` | Server | Refreshed on every write; not in the original assignment shape but needed for auditability |

Required categories:

- Classic Pizzas
- Vegetarian Pizzas
- Meat Lovers
- Specialty / Gourmet Pizzas
- Sides & Appetizers
- Beverages & Desserts

### Approval and availability

A new item is submitted with `status: 'pending'` and `isAvailable: true`. Pending approval and vendor availability are different ideas:

- `status` is Admin-owned. Vendors cannot set or patch it. Admin moderation is a later milestone.
- `isAvailable` is vendor-owned. `PATCH /api/menu/:id/availability` flips the current boolean value.

### Subscription item limits

Free vendors may reserve **3** menu-item slots. Premium vendors have no limit. Premium access is read from the current MongoDB user record and requires **all** of:

- `subscriptionPlan: 'premium'`
- `subscriptionStatus: 'active'`
- `subscriptionExpiresAt` later than the current server time

A slot is used only by an item that is available and has a slot-consuming status (`pending` or `approved`). Pending items reserve a slot, so vendors cannot create unlimited unapproved items. Unavailable, `rejected` and `inactive` items do not use a slot.

The limit is checked before `POST /api/menu` uploads images and again in the menu service. `PATCH /api/menu/:id/availability` also checks the limit when an unavailable item is being made available again. A blocked request returns `409 MENU_ITEM_LIMIT_REACHED`; no upload is spent and no menu document is written. General `PATCH /api/menu/:id` cannot change availability, status or subscription fields, so it cannot bypass the limit.

These fields are server-owned and will be updated by the later Stripe webhook milestone. They cannot be set by registration, profile updates or menu requests, and JWT subscription claims are ignored.

### Request rules

Vendor management endpoints require `Authorization: Bearer <jwt>` and a MongoDB role of `vendor`. A session cookie is not accepted. `GET /api/menu` is public and needs no token.

- `POST /api/menu` expects `multipart/form-data`. Text fields are validated with strict Zod; the image files must be in the `images` field. Client-supplied image URL strings are rejected.
- `GET /api/menu` accepts `search`, `category`, `location`, `sort`, `page` and `limit` only. Defaults are `sort=newest`, `page=1` and `limit=12` (maximum `50`). See [Advanced search and sorting](#advanced-search-and-sorting).
- `GET /api/menu/mine` accepts `page` (default `1`, max `10000`) and `limit` (default `10`, max `50`) and returns `{ items, pagination }`.
- `PATCH /api/menu/:id` accepts only `itemName`, `category`, `description`, `price` and `location`. Availability has its own route.
- `PATCH /api/menu/:id/availability` takes no body.
- `DELETE /api/menu/:id` returns `204` on success.

`vendorId`, `status`, `createdAt`, `updatedAt`, `images`, `isAvailable`, `subscriptionPlan`, `subscriptionStatus`, `subscriptionExpiresAt`, `_id` and `id` are reserved and rejected with `400 FORBIDDEN_FIELD`. Ids must be canonical 24-character MongoDB ObjectIds (`400 INVALID_MENU_ID` otherwise).

### Ownership

Ownership is enforced in MongoDB, not only in Express. Every update, toggle, read and delete uses a filter shaped like `{ _id: ObjectId(id), vendorId: req.user.id }`. A missing item and another vendor's item both return `404 MENU_ITEM_NOT_FOUND`, so the API never reveals whether someone else's id exists. `vendorId` always comes from the authenticated user, and the service rebuilds `$set` from an allow-list instead of spreading `req.body`.

### ImgBB upload flow and limits

`createImageUploader()` configures Multer with `memoryStorage()` and is mounted only on `POST /api/menu`, after authentication and role checks. The upload service then sends each buffer with Node's built-in `fetch` to `POST https://api.imgbb.com/1/upload` using `FormData`. The API key is sent in the multipart body and is never logged or echoed. Only the `data.url` (or `display_url`) from the successful JSON response is saved.

Safe limits:

| Limit | Value | Reason |
| --- | --- | --- |
| Per-file size | 5 MB | Below ImgBB's 32 MB ceiling and safe for memory storage |
| Files per item | 3 | Keeps one request small and predictable |
| Text fields | 8 | The create form needs five |
| Field nesting depth | 1 | Blocks `field[$ne]=...`-style NoSQL injection attempts |
| MIME types | JPEG, PNG, WebP, GIF | SVG and other types are rejected |

Missing or placeholder credentials produce `500 IMAGE_UPLOAD_UNAVAILABLE`. Multer/ImgBB failures produce safe `400`/`413`/`502` responses with fixed messages. Raw fetch text, response bodies and the API key are never returned.

## Admin seed script

Run the seed manually after replacing the three `ADMIN_*` placeholders in `.env`:

```powershell
npm run seed:admin
```

The flow is intentionally narrow:

1. `loadEnv()` checks the normal required configuration, then `validateAdminConfig()` checks `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` **before** any database work. Passwords must be 6–128 characters with at least one uppercase and one lowercase letter. Example/placeholder values are rejected, and no entered value is ever printed.
2. `connectToDatabase(env)` opens the same MongoDB pool the API uses; `disconnectFromDatabase()` runs in a `finally` block.
3. `findUserByEmail()` looks up the lowercased address in Better Auth's `users` collection using a small projection.
4. An existing **Admin** is a no-op with a friendly log message. An existing email with another role produces a safe `409 ADMIN_EMAIL_IN_USE` error; the script never changes that account.
5. The seed creates its Better Auth instance with `createAuth(env, { allowAdminCreation: true })`. `createAuth(env)` without that option always rejects Admin creation. The new Admin is then created with `auth.api.signUpEmail({ body: { ..., role: 'admin' } })`. There are deliberately **no `headers` and no `request`** in that call: browser requests always have both, so the hook requires both the explicit option and this direct-call shape. The create hook preserves `admin`, Better Auth hashes the password into the `account` collection, and the same adapter writes through the shared pool.
6. If two seeds race and the duplicate-email error is returned, the script re-checks the email. A winning Admin record becomes the same no-op; a non-Admin becomes the safe `409`.

No Admin plugin was added. The plugin installed with Better Auth 1.7.27 defaults roles to `user`/`admin` and adds ban fields, which conflicts with this project's `customer`/`vendor` role schema and its own `isBlocked` field. The direct server-only `signUpEmail` call uses the documented Better Auth server API and the project's existing hooks, so no new package or second auth system is needed.

## Advanced search and sorting

`GET /api/menu` is public. Its MongoDB filter is always built by the server from two fixed visibility conditions plus validated options:

```js
{
  status: 'approved',
  isAvailable: true,
  // optional: $or search, category equality, location equality
}
```

Only approved and available items are returned; pending, rejected, inactive and unavailable items can never appear. There is no `status` or `isAvailable` query parameter. The database projection removes `vendorId`, `status` and `isAvailable` before documents reach Express, and `serializePublicMenu()` uses a separate allow-list, so private vendor or moderation fields are not exposed.

| Parameter | Validation | Behavior |
| --- | --- | --- |
| `search` | Optional trimmed string, 1–100 characters, no control characters | Case-insensitive literal phrase search over `itemName` and `description`. Every regex metacharacter is escaped before building `$regex`, so `.*`, `(`, `$` and similar input cannot become regex syntax or a ReDoS pattern. |
| `category` | Optional exact member of `MENU_CATEGORIES` | Equality filter. Invalid categories return `400 VALIDATION_ERROR`. |
| `location` | Optional trimmed string, 1–120 characters, no control characters | Exact equality filter. |
| `sort` | `newest` (default), `price-asc`, or `price-desc` | Any other value returns `400 VALIDATION_ERROR`. Every sort includes `_id` as a stable tiebreaker. |
| `page` | Integer, 1–10000, default `1` | Applied with MongoDB `skip()`. |
| `limit` | Integer, 1–50, default `12` | Applied with MongoDB `limit()`. Values above `50` are rejected. |

The query object is parsed with Zod `.strict()`. Unknown keys including MongoDB operator shapes such as `where[$ne]` or `search[$ne]` are rejected before MongoDB sees them. Client-supplied sort directions, filters and projections are never accepted.

Counting and page retrieval both run in MongoDB with the same filter; the whole collection is never loaded into application memory. Empty results return `200` with `items: []` and `totalPages: 0`.

```json
{
  "items": [
    {
      "id": "65c000000000000000000001",
      "itemName": "Margherita",
      "category": "Classic Pizzas",
      "description": "Tomato, mozzarella and basil.",
      "price": 12.5,
      "location": "Downtown",
      "images": ["https://i.ibb.co/example.png"],
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 12,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

`updatedAt` appears in an item only when the stored document has it. The public route is exact: `/api/menu/mine` still reaches its authenticated vendor-only handler instead of the public handler.

## Stripe webhooks

Stripe will be used only for vendor premium subscriptions, never for pizza orders. The webhook route will use the raw request body, verify signatures, be idempotent, and be the only place that activates Premium — the success redirect will never be trusted. Details will be added in Milestone 13.

## Deployment

Deployment instructions will be added after the backend is complete. The intended shape is a Node process behind a reverse proxy, with all secrets supplied through environment variables and no credentials in source control.

## Client repository

To be added later.

## License

UNLICENSED — assignment project.
