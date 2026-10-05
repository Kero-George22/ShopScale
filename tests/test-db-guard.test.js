const {
  isTestDatabase,
  isTestDatabaseName,
  extractDatabaseDetails,
  assertTestDatabase,
} = require('./test-db-guard');
const { cleanDatabase, prisma } = require('./helpers');

describe('Test Database Safety Guard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Case 1 — Valid test database', () => {
    it('accepts clearly identified test databases when NODE_ENV=test', () => {
      const validTestUrls = [
        'postgresql://postgres:secret@localhost:5432/ShopScale_test',
        'postgresql://postgres:secret@localhost:5432/shopscale_test',
        'postgresql://postgres:secret@localhost:5432/ShopScale_Test',
        'postgresql://postgres:secret@localhost:5432/test_shopscale',
        'postgresql://postgres:secret@localhost:5432/shopscale-test',
        'postgresql://postgres:secret@localhost:5432/test-shopscale',
        'postgresql://postgres:secret@localhost:5432/test',
        'postgresql://user:pass@db.internal:5432/my_app_test?schema=public',
        'postgres://user:pass@localhost:5432/ShopScale_test',
      ];

      for (const url of validTestUrls) {
        expect(isTestDatabase(url)).toBe(true);
        expect(() => assertTestDatabase(url, 'test')).not.toThrow();
        expect(assertTestDatabase(url, 'test')).toBe(true);
      }
    });

    it('allows cleanDatabase() to proceed when configured with a valid test database', async () => {
      // In the Jest environment, .env.test is loaded pointing to ShopScale_test and NODE_ENV=test
      expect(() => assertTestDatabase()).not.toThrow();
      await expect(cleanDatabase()).resolves.toBeUndefined();
    });
  });

  describe('Case 2 — Development database', () => {
    it('rejects clearly identified development databases even if NODE_ENV=test', () => {
      const devUrls = [
        'postgresql://postgres:secret_pass_123@localhost:5432/ShopScale',
        'postgresql://shopscale:secret_pass_123@localhost:5432/shopscale',
        'postgresql://postgres:secret_pass_123@localhost:5432/ShopScale_dev',
        'postgresql://postgres:secret_pass_123@localhost:5432/shopscale_development',
      ];

      for (const url of devUrls) {
        expect(isTestDatabase(url)).toBe(false);

        expect(() => assertTestDatabase(url, 'test')).toThrowError(
          /Destructive test database operation blocked/
        );

        try {
          assertTestDatabase(url, 'test');
        } catch (error) {
          expect(error.code).toBe('ERR_TEST_DB_SAFETY_GUARD');
          // Crucial: Must NOT leak the password
          expect(error.message).not.toContain('secret_pass_123');
          // Must explain why blocked with sanitized database name
          expect(error.message).toMatch(/database=ShopScale|database=shopscale/i);
          expect(error.message).toMatch(/must have a "_test" suffix/i);
        }
      }
    });
  });

  describe('Case 3 — Production database', () => {
    it('rejects production databases and credentials are sanitized from error', () => {
      const prodUrls = [
        'postgresql://admin:super_secret_prod_pw@prod-cluster.internal:5432/shopscale_production',
        'postgresql://admin:super_secret_prod_pw@prod-cluster.internal:5432/shopscale_prod',
        'postgresql://admin:super_secret_prod_pw@prod-cluster.internal:5432/ShopScale_prod',
        'postgresql://admin:super_secret_prod_pw@prod-cluster.internal:5432/shopscale_live',
      ];

      for (const url of prodUrls) {
        expect(isTestDatabase(url)).toBe(false);

        try {
          assertTestDatabase(url, 'test');
          throw new Error('Expected assertTestDatabase to throw');
        } catch (error) {
          expect(error.code).toBe('ERR_TEST_DB_SAFETY_GUARD');
          // Crucial: Password must NOT appear in error message
          expect(error.message).not.toContain('super_secret_prod_pw');
          expect(error.message).toContain('prod-cluster.internal:5432');
          expect(error.message).toMatch(/database=shopscale_/i);
          expect(error.message).toMatch(/must have a "_test" suffix/i);
        }
      }
    });

    it('rejects test database if NODE_ENV is set to production', () => {
      const testUrl = 'postgresql://postgres:pass@localhost:5432/ShopScale_test';
      expect(() => assertTestDatabase(testUrl, 'production')).toThrowError(
        /NODE_ENV is not "test"/
      );
    });
  });

  describe('Case 4 — Ambiguous / unknown database', () => {
    it('fails closed when database identity cannot be confidently determined', () => {
      const ambiguousCases = [
        'postgresql://postgres:pass@localhost:5432/postgres',
        'postgresql://postgres:pass@localhost:5432/',
        'postgresql://postgres:pass@localhost:5432',
        'postgresql://postgres:pass@localhost:5432/contest',
        'postgresql://postgres:pass@localhost:5432/protest',
        'postgresql://postgres:pass@localhost:5432/testing',
        'postgresql://postgres:pass@localhost:5432/test1',
        'postgresql://postgres:pass@localhost:5432/latest',
        'mysql://postgres:pass@localhost:3306/ShopScale_test',
        'not_a_valid_url',
      ];

      for (const url of ambiguousCases) {
        expect(isTestDatabase(url)).toBe(false);

        expect(() => assertTestDatabase(url, 'test')).toThrowError(
          /Destructive test database operation blocked/
        );
      }
    });
  });

  describe('Case 5 — Missing test environment configuration', () => {
    it('rejects when DATABASE_URL is unset or empty', () => {
      expect(() => assertTestDatabase(undefined, 'test')).toThrowError(
        /DATABASE_URL is not set or empty/
      );
      expect(() => assertTestDatabase('', 'test')).toThrowError(
        /DATABASE_URL is not set or empty/
      );
    });

    it('blocks cleanup when .env.test is missing and environment falls back to .env development config', async () => {
      // Simulate fallback to development .env
      process.env.DATABASE_URL = 'postgresql://postgres:Kokokoko12@@localhost:5432/ShopScale';
      process.env.NODE_ENV = 'development';

      expect(() => assertTestDatabase()).toThrowError(/ERR_TEST_DB_SAFETY_GUARD/);

      // Verify cleanDatabase fails closed and aborts before executing any transaction
      const transactionSpy = jest.spyOn(prisma, '$transaction');

      await expect(cleanDatabase()).rejects.toThrowError(
        /Destructive test database operation blocked/
      );

      // Prove that zero delete operations were sent to Prisma
      expect(transactionSpy).not.toHaveBeenCalled();

      transactionSpy.mockRestore();
    });

    it('blocks cleanup even if NODE_ENV=test but DATABASE_URL fell back to development', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:Kokokoko12@@localhost:5432/ShopScale';
      process.env.NODE_ENV = 'test';

      const transactionSpy = jest.spyOn(prisma, '$transaction');

      await expect(cleanDatabase()).rejects.toThrowError(
        /Destructive test database operation blocked/
      );

      expect(transactionSpy).not.toHaveBeenCalled();

      transactionSpy.mockRestore();
    });
  });
});
