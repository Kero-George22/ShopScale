const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/token');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Access token is required'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (error) {
    next(new ApiError(401, 'Invalid or expired access token'));
  }
};

module.exports = authenticate;
