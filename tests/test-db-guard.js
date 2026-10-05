/**
 * Test Database Safety Guard
 *
 * Prevents accidental execution of destructive test operations
 * (cleanDatabase, test migrations, etc.) against non-test databases.
 *
 * Fails closed: if the database cannot be definitively verified
 * as a test database, destructive operations are immediately blocked.
 */

/**
 * Extracts and sanitizes database target information from a connection URL.
 * Never exposes passwords or credentials.
 *
 * @param {string} databaseUrl
 * @returns {{ isValidUrl: boolean, databaseName: string|null, sanitizedTarget: string }}
 */
function extractDatabaseDetails(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    return {
      isValidUrl: false,
      databaseName: null,
      sanitizedTarget: '<unset>',
    };
  }

  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return {
        isValidUrl: false,
        databaseName: null,
        sanitizedTarget: `<unsupported protocol: ${parsed.protocol}>`,
      };
    }

    const rawPath = parsed.pathname.replace(/^\/+/, '');
    const dbName = rawPath ? decodeURIComponent(rawPath.split('/')[0]) : null;
    const host = parsed.host || '<unknown-host>';
    const sanitizedTarget = dbName
      ? `database=${dbName}, host=${host}`
      : `host=${host} (no database specified)`;

    return {
      isValidUrl: true,
      databaseName: dbName,
      sanitizedTarget,
    };
  } catch {
    return {
      isValidUrl: false,
      databaseName: null,
      sanitizedTarget: '<unparseable URL>',
    };
  }
}

/**
 * Validates whether a database name unambiguously identifies as a test database.
 * Requires explicit test markers:
 *   - Suffix: "_test" or "-test" (case-insensitive)
 *   - Prefix: "test_" or "test-" (case-insensitive)
 *   - Exact: "test" (case-insensitive)
 *
 * Examples:
 *   - "ShopScale_test" -> true
 *   - "shopscale_test" -> true
 *   - "test_shopscale" -> true
 *   - "ShopScale"      -> false
 *   - "shopscale_dev"  -> false
 *   - "production"     -> false
 *   - "postgres"       -> false
 *
 * @param {string} dbName
 * @returns {boolean}
 */
function isTestDatabaseName(dbName) {
  if (!dbName || typeof dbName !== 'string') {
    return false;
  }
  const normalized = dbName.trim().toLowerCase();
  if (normalized === 'test') {
    return true;
  }
  if (normalized.endsWith('_test') || normalized.endsWith('-test')) {
    return true;
  }
  if (normalized.startsWith('test_') || normalized.startsWith('test-')) {
    return true;
  }
  return false;
}

/**
 * Checks whether a given database URL points to a valid test database.
 *
 * @param {string} databaseUrl
 * @returns {boolean}
 */
function isTestDatabase(databaseUrl) {
  const { isValidUrl, databaseName } = extractDatabaseDetails(databaseUrl);
  if (!isValidUrl || !databaseName) {
    return false;
  }
  return isTestDatabaseName(databaseName);
}

/**
 * Asserts that the current environment and target database are safe for
 * destructive test operations. Throws immediately if unsafe (fails closed).
 *
 * @param {string} [databaseUrl] Defaults to process.env.DATABASE_URL
 * @param {string} [nodeEnv] Defaults to process.env.NODE_ENV
 * @throws {Error} If the database cannot be verified as a test database
 */
function assertTestDatabase(databaseUrl, nodeEnv) {
  const resolvedUrl = arguments.length > 0 ? databaseUrl : process.env.DATABASE_URL;
  const resolvedEnv = arguments.length > 1 ? nodeEnv : process.env.NODE_ENV;

  const { isValidUrl, databaseName, sanitizedTarget } = extractDatabaseDetails(resolvedUrl);

  const errors = [];

  if (resolvedEnv !== 'test') {
    errors.push(`NODE_ENV is not "test" (current: ${JSON.stringify(resolvedEnv || '<unset>')})`);
  }

  if (!resolvedUrl) {
    errors.push('DATABASE_URL is not set or empty');
  } else if (!isValidUrl) {
    errors.push(`DATABASE_URL is not a valid PostgreSQL connection string (target: ${sanitizedTarget})`);
  } else if (!databaseName) {
    errors.push(`DATABASE_URL does not specify a database name (target: ${sanitizedTarget})`);
  } else if (!isTestDatabaseName(databaseName)) {
    errors.push(
      `Database name "${databaseName}" does not match test naming conventions (must have a "_test" suffix, e.g. "ShopScale_test")`
    );
  }

  if (errors.length > 0) {
    const message = [
      '[SAFETY GUARD] [ERR_TEST_DB_SAFETY_GUARD] Destructive test database operation blocked.',
      `Target: ${sanitizedTarget}`,
      'Reason(s):',
      ...errors.map((e) => `  - ${e}`),
      '',
      'Destructive operations (such as cleanDatabase or test migrations) are only permitted when:',
      '  1. NODE_ENV is set to "test"',
      '  2. DATABASE_URL points to a designated test database with a "_test" suffix (e.g. "ShopScale_test")',
      '',
      'How to resolve:',
      '  - Ensure .env.test exists in the project root with your test configuration:',
      '      DATABASE_URL=postgresql://<user>:<password>@localhost:5432/ShopScale_test',
      '      NODE_ENV=test',
      '  - Or export DATABASE_URL pointing to your test database before running tests.',
    ].join('\n');

    const err = new Error(message);
    err.code = 'ERR_TEST_DB_SAFETY_GUARD';
    throw err;
  }

  return true;
}

module.exports = {
  extractDatabaseDetails,
  isTestDatabaseName,
  isTestDatabase,
  assertTestDatabase,
};
