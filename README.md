# PizzaHub — Backend Server

PizzaHub is a role-based pizza ordering and delivery platform. This repository contains the **backend only**: a Node.js/Express REST API that will serve a separate Next.js client (to be created later in a different repository).

> **Status: Milestone 1 of 15.** Only the server foundation and health check exist so far. Database, authentication, business APIs, and payments are deliberately not implemented yet.

---

## Project description

Customers will browse approved pizza menus and place orders. Vendors will manage restaurants, menus, orders, and premium subscriptions. Administrators will manage users, moderate menu items, and read transaction records. The three roles are `customer`, `vendor`, and `admin`.

## Backend features

**Implemented now**

- Express 5 application with ECMAScript Modules
- Security headers via Helmet
- Environment-driven CORS with credentials
- Startup validation of environment variables with Zod
- Health-check endpoint
- Graceful shutdown on `SIGINT` / `SIGTERM`

**Planned (later milestones)**

- MongoDB connection, indexes, and collection layer
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
| Database | MongoDB (from Milestone 3) |
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

Only these four runtime packages are installed in Milestone 1. Node 24's built-in `--env-file-if-exists` and `--watch` flags remove the need for `dotenv` and `nodemon`, and we use Node's built-in test runner instead of adding Jest.

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
    └── modules/
        └── health/
            └── health.routes.js       # GET /api/health
```

Planned folders: `database/`, `auth/`, `middlewares/`, `modules/{user,menu,browse,order,admin,payment}/`, `routes/`, `services/`, `utils/`, `validators/`, `scripts/`, `tests/`. They will be added in the milestone that uses them so the repository contains no empty placeholders.

## Installation and local setup

Requirements: Node.js 22.9 or newer, npm, and (from Milestone 3) MongoDB.

```powershell
cd "C:\Users\SAYDA\Desktop\Programmig Hero\Assignments\Assignment 9 (M55)\PizzaHub\server"
npm install
Copy-Item .env.example .env
```

Edit `.env` with your local values. Do **not** commit it; `.gitignore` already excludes it.

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
| `MONGODB_URI` | Milestone 3 | Connection string |
| `MONGODB_DB_NAME` | Milestone 3 | Database name |
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

Currently, only `PORT` and `NODE_ENV` have defaults; the rest are parsed but optional until their milestone is implemented.

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
