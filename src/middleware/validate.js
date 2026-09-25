const ApiError = require('../utils/ApiError');

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));

    const error = new ApiError(400, 'Validation failed');
    error.errors = errors;
    return next(error);
  }

  req.body = result.data;
  next();
};

module.exports = validate;
