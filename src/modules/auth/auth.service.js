const bcrypt = require('bcrypt');
const prisma = require('../../database/prisma');
const ApiError = require('../../utils/ApiError');
const { generateAccessToken, generateRefreshToken, hashToken } = require('../../utils/token');
const parseDuration = require('../../utils/parseDuration');
const env = require('../../config/env');

const SALT_ROUNDS = 12;

async function register({ name, email, password }) {
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new ApiError(409, 'Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const user = await prisma.user.create({
      data: { name, email, passwordHash },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    return user;
  } catch (error) {
    // Race condition: another request registered this email between our
    // findUnique check and this create call. The DB UNIQUE constraint
    // caught it — convert to a clean 409 instead of letting it bubble as 500.
    if (error.code === 'P2002') {
      throw new ApiError(409, 'Email already registered');
    }
    throw error;
  }
}

async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new ApiError(401, 'Invalid email or password');
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    throw new ApiError(401, 'Invalid email or password');
  }

  const accessToken = generateAccessToken({ sub: user.id, role: user.role });
  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);

  const expiresAt = new Date(Date.now() + parseDuration(env.refreshTokenExpiresIn));

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

async function refresh(oldRefreshToken) {
  const tokenHash = hashToken(oldRefreshToken);

  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!storedToken) {
    throw new ApiError(401, 'Invalid refresh token');
  }

  if (storedToken.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: storedToken.id } });
    throw new ApiError(401, 'Refresh token expired');
  }

  // Token rotation: delete old, create new — in a transaction
  const newRefreshToken = generateRefreshToken();
  const newTokenHash = hashToken(newRefreshToken);
  const expiresAt = new Date(Date.now() + parseDuration(env.refreshTokenExpiresIn));

  await prisma.$transaction([
    prisma.refreshToken.delete({ where: { id: storedToken.id } }),
    prisma.refreshToken.create({
      data: {
        userId: storedToken.userId,
        tokenHash: newTokenHash,
        expiresAt,
      },
    }),
  ]);

  const accessToken = generateAccessToken({
    sub: storedToken.user.id,
    role: storedToken.user.role,
  });

  return { accessToken, refreshToken: newRefreshToken };
}

async function logout(refreshToken) {
  if (!refreshToken) return;

  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.deleteMany({ where: { tokenHash } });
}

module.exports = { register, login, refresh, logout };
