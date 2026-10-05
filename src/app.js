const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./modules/auth/auth.routes');
const productRoutes = require('./modules/products/product.routes');
const orderRoutes = require('./modules/orders/order.routes');
const healthRoutes = require('./modules/health/health.routes');

const app = express();

// Request logging and request ID tracking
app.use(requestLogger);

// Security headers
app.use(helmet());

// CORS
app.use(
  cors({
    origin: env.cors.origin,
    credentials: true,
  })
);

// Body parsing
app.use(express.json());

// Cookie parsing
app.use(cookieParser());

// Rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    env.nodeEnv === 'test'
      ? 10000
      : parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20,
  message: { status: 'error', message: 'Too many requests, please try again later' },
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);

// Health and readiness checks
app.use('/health', healthRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

// Global error handler
app.use(errorHandler);

module.exports = app;
