const catchAsync = require('../../utils/catchAsync');
const ApiError = require('../../utils/ApiError');
const authService = require('./auth.service');
const parseDuration = require('../../utils/parseDuration');
const env = require('../../config/env');

const REFRESH_TOKEN_COOKIE = 'refresh_token';

function setRefreshTokenCookie(res, refreshToken) {
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: parseDuration(env.refreshTokenExpiresIn),
  });
}

function clearRefreshTokenCookie(res) {
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/api/auth',
  });
}

const register = catchAsync(async (req, res) => {
  const user = await authService.register(req.body);
  res.status(201).json({ status: 'success', data: { user } });
});

const login = catchAsync(async (req, res) => {
  const { accessToken, refreshToken, user } = await authService.login(req.body);
  setRefreshTokenCookie(res, refreshToken);
  res.json({ status: 'success', data: { accessToken, user } });
});

const refresh = catchAsync(async (req, res) => {
  const oldRefreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
  if (!oldRefreshToken) {
    throw new ApiError(401, 'Refresh token not found');
  }

  const { accessToken, refreshToken } = await authService.refresh(oldRefreshToken);
  setRefreshTokenCookie(res, refreshToken);
  res.json({ status: 'success', data: { accessToken } });
});

const logout = catchAsync(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
  await authService.logout(refreshToken);
  clearRefreshTokenCookie(res);
  res.json({ status: 'success', message: 'Logged out successfully' });
});

module.exports = { register, login, refresh, logout };
