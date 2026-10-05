const crypto = require('crypto');
const { logger } = require('../utils/logger');

const VALID_REQUEST_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function getOrGenerateRequestId(req) {
  const headerValue = req.headers['x-request-id'];
  if (typeof headerValue === 'string' && VALID_REQUEST_ID_REGEX.test(headerValue)) {
    return headerValue;
  }
  return crypto.randomUUID();
}

function requestLogger(req, res, next) {
  const requestId = getOrGenerateRequestId(req);
  const startNs = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  req.log = logger.child({ requestId });

  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startNs) / 1e4) / 100;
    const path = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
    const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : undefined;

    const contentLength = res.getHeader('content-length');
    const responseSize = contentLength ? parseInt(contentLength, 10) : undefined;

    req.log.info(
      {
        requestId,
        method: req.method,
        path,
        route,
        statusCode: res.statusCode,
        status: res.statusCode,
        durationMs,
        duration: durationMs,
        userId: req.user?.id || null,
        responseSize: !isNaN(responseSize) ? responseSize : undefined,
      },
      'HTTP request completed'
    );
  });

  next();
}

module.exports = requestLogger;
