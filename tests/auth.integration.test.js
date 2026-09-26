const request = require('supertest');
const app = require('../src/app');
const { prisma, cleanDatabase } = require('./helpers');

// --- Helpers ---

/**
 * Extracts just the "refresh_token=<value>" part from a Set-Cookie header.
 * Set-Cookie headers include attributes (HttpOnly, Path, etc.) that must NOT
 * be sent back in the Cookie request header.
 */
function getRefreshCookie(res) {
  const cookies = res.headers['set-cookie'];
  if (!cookies) return null;
  const cookie = cookies.find((c) => c.startsWith('refresh_token='));
  if (!cookie) return null;
  return cookie.split(';')[0]; // "refresh_token=abc123"
}

/**
 * Returns the full raw Set-Cookie header string (for asserting attributes).
 */
function getRawCookieHeader(res) {
  const cookies = res.headers['set-cookie'];
  if (!cookies) return null;
  return cookies.find((c) => c.startsWith('refresh_token='));
}

// --- Lifecycle ---

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
});

// --- Tests ---

describe('GET /health', () => {
  it('should return 200 with status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('POST /api/auth/register', () => {
  const validUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
  };

  it('should register a new user and return 201', async () => {
    const res = await request(app).post('/api/auth/register').send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data.user).toMatchObject({
      name: 'Test User',
      email: 'test@example.com',
      role: 'USER',
    });
    expect(res.body.data.user.id).toBeDefined();
    // Password hash must never be returned
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.user.password_hash).toBeUndefined();
  });

  it('should return 409 for duplicate email', async () => {
    await request(app).post('/api/auth/register').send(validUser);

    const res = await request(app).post('/api/auth/register').send(validUser);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already registered/i);
  });

  it('should return 409 (not 500) for concurrent duplicate registrations', async () => {
    const userData = {
      name: 'Race User',
      email: 'race@example.com',
      password: 'password123',
    };

    // Fire two requests simultaneously — bcrypt's ~250ms hash time creates
    // a wide window where both requests pass the findUnique check before
    // either reaches the create call.
    const [res1, res2] = await Promise.all([
      request(app).post('/api/auth/register').send(userData),
      request(app).post('/api/auth/register').send(userData),
    ]);

    const statuses = [res1.status, res2.status].sort();

    // Exactly one 201 and one 409 — never a 500
    expect(statuses).toEqual([201, 409]);
  });

  it('should return 400 for missing name', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.errors).toBeDefined();
  });

  it('should return 400 for invalid email', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Test',
      email: 'not-an-email',
      password: 'password123',
    });

    expect(res.status).toBe(400);
  });

  it('should return 400 for short password', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Test',
      email: 'test@example.com',
      password: '123',
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  const validUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
  };

  beforeEach(async () => {
    await request(app).post('/api/auth/register').send(validUser);
  });

  it('should return access token in body and refresh token in HttpOnly cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: validUser.email,
      password: validUser.password,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.user.email).toBe(validUser.email);

    // Verify cookie security attributes
    const rawCookie = getRawCookieHeader(res);
    expect(rawCookie).toBeDefined();
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('SameSite=Strict');
    expect(rawCookie).toContain('Path=/api/auth');
  });

  it('should store hashed refresh token in the database', async () => {
    await request(app).post('/api/auth/login').send({
      email: validUser.email,
      password: validUser.password,
    });

    const tokenCount = await prisma.refreshToken.count();
    expect(tokenCount).toBe(1);
  });

  it('should return 401 for wrong email (same message as wrong password)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'wrong@example.com',
      password: validUser.password,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('should return 401 for wrong password (same message as wrong email)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: validUser.email,
      password: 'wrongpassword',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });
});

describe('POST /api/auth/refresh', () => {
  let refreshCookie;

  beforeEach(async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    });

    const loginRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'password123',
    });

    refreshCookie = getRefreshCookie(loginRes);
  });

  it('should return a new access token and rotate the refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();

    // New cookie should be set (rotation)
    const newCookie = getRefreshCookie(res);
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(refreshCookie);
  });

  it('should reject the old refresh token after rotation (replay protection)', async () => {
    // Use the token once — it gets rotated
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    // Try the old token again — should fail
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(401);
  });

  it('should return 401 when no cookie is present', async () => {
    const res = await request(app).post('/api/auth/refresh');

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/refresh token/i);
  });

  it('should return 401 for an invalid refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'refresh_token=invalidtoken123');

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  let refreshCookie;

  beforeEach(async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    });

    const loginRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'password123',
    });

    refreshCookie = getRefreshCookie(loginRes);
  });

  it('should clear the cookie and remove token from database', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/logged out/i);

    // Verify token was removed from the database
    const tokenCount = await prisma.refreshToken.count();
    expect(tokenCount).toBe(0);

    // Verify cookie is being cleared (expires in the past)
    const rawCookie = getRawCookieHeader(res);
    expect(rawCookie).toBeDefined();
  });

  it('should succeed even without a refresh token cookie (idempotent)', async () => {
    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(200);
  });

  it('should invalidate the refresh token after logout', async () => {
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookie);

    // Try to use the old refresh token — should fail
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(401);
  });
});
