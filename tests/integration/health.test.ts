jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    jwt: { secret: 'test-secret' },
    auth: {
      jwtSecret: 'test-secret',
      cookieSecret: 'test-cookie-secret',
      excludePaths: ['/health', '/auth/api/v1/token-refresh', '/api/auth/login', '/api/auth/register', '/api/auth/refresh-token'],
    },
    rateLimit: { windowMs: 900000, max: 100 },
    routes: [],
  },
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('../../src/config/redis', () => require('../__mocks__/redis').default);
jest.mock('../../src/middleware/cors', () => ({
  default: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../src/proxy', () => {
  const expressModule = jest.requireActual('express');
  return { default: expressModule.Router() };
});

import request from 'supertest';
import jwt from 'jsonwebtoken';

const cookieSignature = require('cookie-signature');
const mockRedis = require('../__mocks__/redis').default;
const TEST_COOKIE_SECRET = 'test-cookie-secret';

function signedRefreshCookie(token: string): string {
  return `refresh=s:${cookieSignature.sign(token, TEST_COOKIE_SECRET)}`;
}

let app: any;

beforeAll(async () => {
  const expressModule = jest.requireActual('express');
  const cookieParser = require('cookie-parser');
  const { authMiddleware } = require('../../src/middleware/auth');
  const { rateLimiter } = require('../../src/middleware/ratelimit');
  const { refreshTokenHandler } = require('../../src/handlers/refreshToken');
  const { errorHandler } = require('../../src/middleware/errorHandler');

  const testApp = expressModule();
  testApp.use(cookieParser(TEST_COOKIE_SECRET));
  testApp.use(expressModule.json());
  testApp.get('/health', (_req: any, res: any) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  testApp.use(authMiddleware);
  testApp.use(rateLimiter);
  testApp.post('/auth/api/v1/token-refresh', refreshTokenHandler);
  testApp.use((_req: any, res: any) => res.status(404).json({ error: 'Route not found' }));
  testApp.use(errorHandler);
  app = testApp;
});

describe('Health Integration', () => {
  it('GET /health should return 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('GET /unknown-route without auth should return 401', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(401);
  });

  it('GET /unknown-route with auth should return 404', async () => {
    const token = jwt.sign({ sessionId: 'test-session', type: 'access' }, 'test-secret');
    mockRedis.get.mockResolvedValue(JSON.stringify({ userId: 'u1', role: 'admin', email: 'a@b.com' }));
    const res = await request(app)
      .get('/nonexistent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });
});

describe('Refresh Token Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when no refresh cookie', async () => {
    const res = await request(app).post('/auth/api/v1/token-refresh');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing refresh token');
  });

  it('should return 200 and reuse the existing session on valid refresh', async () => {
    const token = jwt.sign({ sessionId: 'sess-integ', type: 'refresh' }, 'test-secret');
    mockRedis.get.mockResolvedValue(JSON.stringify({ userId: 'u1', role: 'admin', email: 'a@b.com' }));

    const res = await request(app)
      .post('/auth/api/v1/token-refresh')
      .set('Cookie', signedRefreshCookie(token));

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(typeof res.body.accessToken).toBe('string');
    expect(mockRedis.expire).toHaveBeenCalledWith('session:sess-integ', 604800);

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toMatch(/^refresh=s(%3A|:)/);

    const decoded = jwt.verify(res.body.accessToken, 'test-secret') as {
      sessionId: string;
      type: string;
    };
    expect(decoded.sessionId).toBe('sess-integ');
    expect(decoded.type).toBe('access');
  });

  it('should return 401 when the refresh cookie is unsigned', async () => {
    const token = jwt.sign({ sessionId: 'sess-unsigned', type: 'refresh' }, 'test-secret');
    const res = await request(app)
      .post('/auth/api/v1/token-refresh')
      .set('Cookie', `refresh=${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing refresh token');
  });

  it('should return 401 when the refresh cookie signature is invalid', async () => {
    const token = jwt.sign({ sessionId: 'sess-tampered', type: 'refresh' }, 'test-secret');
    const res = await request(app)
      .post('/auth/api/v1/token-refresh')
      .set('Cookie', `${signedRefreshCookie(token)}tampered`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing refresh token');
  });

  it('should return 401 for an access token sent as the refresh cookie', async () => {
    const token = jwt.sign({ sessionId: 'sess-access', type: 'access' }, 'test-secret');
    const res = await request(app)
      .post('/auth/api/v1/token-refresh')
      .set('Cookie', signedRefreshCookie(token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token type');
  });

  it('should return 401 for expired refresh token', async () => {
    const token = jwt.sign({ sessionId: 'sess-exp', type: 'refresh' }, 'test-secret', { expiresIn: '-1s' });
    const res = await request(app)
      .post('/auth/api/v1/token-refresh')
      .set('Cookie', signedRefreshCookie(token));
    expect(res.status).toBe(401);
  });
});
