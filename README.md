# CourseWave API Gateway

[![CI](https://github.com/geraldrolland/api-gateway-coursewave/actions/workflows/ci.yml/badge.svg)](https://github.com/geraldrolland/api-gateway-coursewave/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](#license)

A production-grade reverse proxy and edge API gateway for the CourseWave platform. Built with Express, TypeScript, and Redis, it centralizes JWT authentication, session validation, token refresh, rate limiting, request logging, CORS, and HMAC-signed upstream requests.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Authentication and Sessions](#authentication-and-sessions)
- [Rate Limiting](#rate-limiting)
- [Reverse Proxy](#reverse-proxy)
- [Project Structure](#project-structure)
- [Scripts](#scripts)
- [Testing](#testing)
- [Continuous Integration](#continuous-integration)
- [Docker](#docker)
- [Production Checklist](#production-checklist)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Features

- **Edge authentication** - Validates Bearer JWTs and resolves Redis-backed sessions before requests reach upstream services.
- **Native token refresh** - `POST /auth/api/v1/token-refresh` reissues access and refresh tokens without rotating the session ID.
- **Session management** - Sessions are stored as `session:<sessionId>` in Redis with a seven-day TTL extended on refresh.
- **Rate limiting** - Fixed-window limiting by default, with a token-bucket strategy for bursty video traffic.
- **Reverse proxy** - Route-based forwarding to upstream microservices using `http-proxy-middleware`.
- **Signed upstream requests** - Every proxied request carries HMAC-SHA256 headers for upstream verification.
- **Security headers** - Helmet, configurable CORS, and `HttpOnly`/`Secure`/`SameSite=Strict` refresh cookies.
- **Observability** - Structured JSON request and error logs through Winston.
- **Tested** - Unit, integration, and smoke coverage powered by Jest and Supertest.

## Architecture

```text
                                 ┌──────────────────────┐
                                 │        Redis         │
                                 │  sessions, counters  │
                                 └──────────┬───────────┘
                                            │
┌──────────┐        HTTPS        ┌───────────▼───────────┐        ┌────────────────────┐
│  Client  │────────────────────▶│   CourseWave Gateway  │───────▶│  Upstream services │
└──────────┘                     │      (port 3000)      │        │ auth, video, etc.  │
                                 └───────────────────────┘        └────────────────────┘
```

Every request flows through the same ordered pipeline:

1. `helmet()` adds security headers.
2. `corsMiddleware` applies the configured CORS policy.
3. `requestLogger` records structured request/response logs.
4. `cookieParser()` parses auth cookies.
5. `authMiddleware` validates the Bearer token and loads the Redis session, except for excluded paths.
6. `rateLimiter` selects and enforces the route's rate-limit strategy.
7. The native `POST /auth/api/v1/token-refresh` route or the configured proxy routes handle the request.
8. Unmatched requests receive a JSON `404`.

The proxy is mounted before `express.json()` so upstream request streams are never consumed by body parsing.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript |
| HTTP framework | Express 5 |
| Session store / counters | Redis (ioredis) |
| Authentication | JSON Web Tokens (`jsonwebtoken`) |
| Reverse proxy | `http-proxy-middleware` |
| Logging | Winston |
| Security | Helmet, CORS, HttpOnly cookies |
| Testing | Jest, Supertest, SWC |

## Getting Started

### Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Redis 7 or newer
- Docker (optional, for containerized deployment)

### Installation

```bash
git clone https://github.com/geraldrolland/api-gateway-coursewave.git
cd api-gateway-coursewave
npm ci --legacy-peer-deps
```

> `--legacy-peer-deps` is required by the current TypeScript 7 / ts-jest peer dependency combination. The CI workflow and Dockerfile use the same flag.

### Configure

```bash
cp .env.example .env
```

On Windows:

```powershell
Copy-Item .env.example .env
```

Set at minimum:

- `JWT_SECRET` - shared with the auth service and used to sign/verify tokens.
- `PROXY_SECRET` - shared with upstream services to verify signed proxy requests.
- `REDIS_HOST` / `REDIS_PORT` - connection details for Redis.
- `ROUTES` - JSON array describing upstream services, if proxying is needed.

### Run

Development (hot reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

The gateway listens on `http://127.0.0.1:3000` by default. Verify it with:

```bash
curl http://localhost:3000/health
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind address | `127.0.0.1` |
| `CORS_ORIGIN` | Allowed origin(s): `*` or comma-separated list | `*` |
| `CORS_METHODS` | Allowed HTTP methods | `GET,POST,PUT,PATCH,DELETE,OPTIONS` |
| `CORS_HEADERS` | Allowed request headers | `Content-Type,Authorization,X-Request-ID` |
| `CORS_CREDENTIALS` | Allow credentialed CORS requests | `false` |
| `JWT_SECRET` | Secret used to sign and verify JWTs | `change-me-in-production` |
| `ACCESS_TOKEN_EXPIRY` | Access token lifetime | `7m` |
| `REFRESH_TOKEN_EXPIRY` | Refresh token lifetime | `7d` |
| `REFRESH_TOKEN_MAX_AGE` | Refresh cookie max age in milliseconds | `604800000` |
| `AUTH_EXCLUDE_PATHS` | Comma-separated paths that bypass Bearer authentication | `/health,/auth/api/v1/token-refresh,/api/auth/login,/api/auth/register` |
| `RATE_LIMIT_WINDOW_MS` | Global fixed-window duration in milliseconds | `900000` |
| `RATE_LIMIT_MAX` | Global request limit per window | `100` |
| `LOG_LEVEL` | Winston log level | `info` |
| `REDIS_HOST` | Redis hostname | `127.0.0.1` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password | _(empty)_ |
| `REDIS_DB` | Redis database index | `0` |
| `PROXY_SECRET` | HMAC secret shared with upstream services | `change-me-in-production` |
| `ROUTES` | JSON array of upstream route definitions | `[]` |

> The default secrets are for local development only. Always provide strong, unique values in production.

### Route Configuration

Routes are defined as a JSON array in `ROUTES`:

```json
[
  {
    "prefix": "/api/auth",
    "target": "http://localhost:4002",
    "rateLimit": {
      "strategy": "fixedWindow",
      "windowMs": 900000,
      "max": 100
    }
  },
  {
    "prefix": "/api/video",
    "target": "http://localhost:4002",
    "rewrite": true,
    "rateLimit": {
      "strategy": "tokenBucket",
      "max": 10,
      "refillRate": 2
    }
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `prefix` | Yes | Path prefix that selects the route |
| `target` | Yes | Upstream service URL |
| `rewrite` | No | Strip `prefix` before forwarding (default: `false`) |
| `auth` | No | Reserved for route-level auth policy |
| `rateLimit.strategy` | No | `fixedWindow` or `tokenBucket` |
| `rateLimit.windowMs` | No | Fixed-window duration in milliseconds |
| `rateLimit.max` | No | Requests per window, or token-bucket capacity |
| `rateLimit.refillRate` | No | Tokens added per second (token bucket only) |

`POST /auth/api/v1/token-refresh` is handled natively by the gateway. Do not add it to `ROUTES`.

## API Reference

Base URL: `http://localhost:3000` (development).

### Health Check

```http
GET /health
```

Returns service status and the current server timestamp. This endpoint bypasses authentication and rate limiting.

```json
{
  "status": "ok",
  "timestamp": "2026-10-27T00:00:00.000Z"
}
```

### Refresh Access Token

```http
POST /auth/api/v1/token-refresh
```

Authenticates with the `refresh` HttpOnly cookie. No request body or Bearer token is required.

```bash
curl -i -X POST http://localhost:3000/auth/api/v1/token-refresh \
  --cookie "refresh=<refresh-token>"
```

Successful response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Set-Cookie: refresh=<new-refresh-token>; Max-Age=604800; Path=/auth/api/v1/token-refresh; HttpOnly; Secure; SameSite=Strict

{
  "accessToken": "<new-access-token>"
}
```

Behavior:

- Verifies the refresh JWT with `JWT_SECRET`.
- Requires a valid `sessionId` and an existing Redis session.
- Extends the existing session's TTL to seven days.
- Issues new access and refresh tokens using the **same** session ID.
- Rotates the `refresh` cookie scoped to `/auth/api/v1/token-refresh`.

| Status | Condition |
|--------|-----------|
| `200` | Tokens refreshed successfully |
| `401` | Refresh cookie missing, invalid, or expired |
| `401` | Session expired or not found |
| `429` | Rate limit exceeded |
| `500` | Unexpected refresh failure |

## Authentication and Sessions

Requests to protected routes must include:

```http
Authorization: Bearer <access-token>
```

The gateway then:

1. Checks whether the path is listed in `AUTH_EXCLUDE_PATHS`.
2. Verifies the JWT signature and expiry.
3. Extracts `sessionId` from the token payload.
4. Loads `session:<sessionId>` from Redis.
5. Attaches `{ userId, role, email }` to `req.user`.
6. Rejects the request with `401` if any step fails.

Sessions are written by the authentication service and read by the gateway. Token refresh extends the session TTL but keeps the same session ID, so existing sessions remain valid.

### Refresh Cookie

The gateway sets the refresh cookie with:

- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- `Path=/auth/api/v1/token-refresh`
- `Max-Age` from `REFRESH_TOKEN_MAX_AGE`

Because the cookie is `Secure`, browsers only store it over HTTPS. For browser-based clients, configure `CORS_ORIGIN` with explicit origins and set `CORS_CREDENTIALS=true`.

### Upstream Session Propagation

For authenticated proxied requests, the gateway adds a URL-encoded `session` cookie containing the resolved session data. Upstream services can use this to identify the user without re-validating the JWT.

## Rate Limiting

The rate limiter supports two strategies:

| Strategy | Behavior | Default use |
|----------|----------|-------------|
| `fixedWindow` | Counts requests in a fixed time window | All routes |
| `tokenBucket` | Refills tokens at a steady rate and allows bursts | `/api/video` |

Limits are keyed by `userId` for authenticated requests, otherwise by client IP address.

Responses include:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1798765432
```

When a limit is exceeded:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 900
```

```json
{
  "error": "Too many requests, please try again later"
}
```

The global fallback is configured with `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`. Strategy selection is built in: `/api/video` uses the token bucket, while every other path uses the fixed window.

## Reverse Proxy

For each configured route, the gateway:

- Matches requests by path prefix.
- Forwards to the configured upstream target with `changeOrigin: true`.
- Optionally strips the prefix when `rewrite` is `true`.
- Injects the resolved session cookie for authenticated requests.
- Signs the outgoing request with HMAC-SHA256.

Signed headers:

```http
x-proxy-signature: <hex-hmac>
x-proxy-timestamp: <unix-ms>
```

The signature is computed over:

```text
{METHOD}:{REQUEST_URL}:{TIMESTAMP}
```

Upstream services should verify the signature with the shared `PROXY_SECRET` and reject missing or stale signatures. Connection failures return:

```http
HTTP/1.1 502 Bad Gateway
```

```json
{
  "error": "Bad gateway - upstream service unavailable"
}
```

## Project Structure

```text
.
├── .github/
│   └── workflows/ci.yml        # Build and test pipeline
├── src/
│   ├── config/
│   │   ├── index.ts            # Environment configuration
│   │   └── redis.ts            # Redis client
│   ├── handlers/
│   │   └── refreshToken.ts     # Native token refresh handler
│   ├── middleware/
│   │   ├── auth.ts             # JWT + Redis session authentication
│   │   ├── cors.ts             # CORS policy
│   │   ├── errorHandler.ts     # Global error handling
│   │   ├── logger.ts           # Winston logger + request logging
│   │   └── ratelimit/
│   │       ├── index.ts        # Strategy selection
│   │       ├── fixedWindow.ts  # Fixed-window implementation
│   │       ├── tokenBucket.ts  # Token-bucket Lua implementation
│   │       └── utils.ts        # Shared rate-limit helpers
│   ├── proxy/
│   │   └── index.ts            # Proxy router + HMAC signing
│   ├── types/
│   │   └── index.ts            # Shared TypeScript types
│   └── server.ts               # Application bootstrap
├── tests/
│   ├── unit/                   # Unit tests
│   ├── integration/            # Integration tests
│   ├── smoke/                  # Smoke tests
│   ├── load/                   # Load-test harness
│   └── performance/            # Performance harness
├── Dockerfile
├── jest.config.js
├── package.json
└── tsconfig.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot reload via nodemon and tsx |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled production build |
| `npm test` | Run the full Jest suite |
| `npm run test:unit` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run test:smoke` | Run smoke tests |
| `npm run test:load` | Run the standalone load-test harness |
| `npm run test:perf` | Run the standalone performance harness |
| `npm run test:all` | Run unit, integration, and smoke tests |

## Testing

Tests use Jest with the SWC transformer and Supertest. Redis is mocked for unit and integration tests.

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:smoke
```

Before opening a pull request, run:

```bash
npm run build
npm test
```

## Continuous Integration

The GitHub Actions workflow in `.github/workflows/ci.yml` runs on pushes and pull requests to `main` and `master`:

1. Checks out the repository.
2. Sets up Node.js 20 with npm caching.
3. Installs dependencies with `npm ci --legacy-peer-deps`.
4. Builds the TypeScript project.
5. Runs the Jest test suite.

## Docker

Build the image:

```bash
docker build -t coursewave-api-gateway .
```

Run it with the environment file:

```bash
docker run --rm -p 3000:3000 --env-file .env coursewave-api-gateway
```

The Dockerfile uses a multi-stage build, installs production dependencies only in the runtime image, and starts `dist/server.js`.

## Production Checklist

- [ ] Replace the default `JWT_SECRET` and `PROXY_SECRET` with strong, randomly generated values.
- [ ] Terminate TLS in front of the gateway; refresh cookies are marked `Secure`.
- [ ] Set `CORS_ORIGIN` to explicit trusted origins and enable `CORS_CREDENTIALS` only when required.
- [ ] Restrict `AUTH_EXCLUDE_PATHS` to endpoints that genuinely do not require a Bearer token.
- [ ] Secure Redis with authentication, TLS where supported, and private network isolation.
- [ ] Use a managed Redis instance or configure persistence appropriate for session durability.
- [ ] Configure `trust proxy` if the gateway runs behind a load balancer so client IPs are correct for rate limiting.
- [ ] Pin container images and run the container as a non-root user.
- [ ] Ship logs to a centralized platform and alert on `5xx`, Redis failures, and rate-limit spikes.
- [ ] Add health/readiness probes around `GET /health` and Redis availability.
- [ ] Review token lifetimes and rate limits against expected traffic before launch.

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---------|--------------|------------|
| `401 Missing or invalid Authorization header` | No Bearer token on a protected route | Send `Authorization: Bearer <token>` or add the path to `AUTH_EXCLUDE_PATHS` |
| `401 Session expired or not found` | Token references a missing Redis session | Sign in again or verify Redis connectivity |
| `401 Missing refresh token` | Cookie absent, expired, or blocked by its path/security attributes | Use HTTPS, confirm `Path=/auth/api/v1/token-refresh`, and enable credentialed CORS |
| `429 Too many requests` | Rate limit exceeded for the user or IP | Wait for `Retry-After` or raise the configured limit |
| `502 Bad gateway` | Upstream service unreachable | Check the route `target` and upstream health |
| Redis connection errors | Redis unavailable or misconfigured | Verify `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, and `REDIS_DB` |

## Contributing

1. Create a feature branch from `main`.
2. Make your changes and add or update tests.
3. Run `npm run build` and `npm test`.
4. Open a pull request with a clear description of the change.

## License

Released under the ISC License. See `package.json` for details.
