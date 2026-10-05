const { execSync } = require('child_process');
const dotenv = require('dotenv');
const path = require('path');

// Load test environment before running prisma commands
dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });

const { assertTestDatabase } = require('./test-db-guard');

module.exports = async function () {
  // Safety guard: ensure migrations only deploy to a verified test database
  assertTestDatabase();

  try {
    // Deploy migrations to test database
    execSync('npx prisma migrate deploy', {
      env: { ...process.env },
      stdio: 'pipe',
    });
  } catch (error) {
    console.error('\nFailed to set up test database.');
    console.error('Make sure the test database exists. Create it in pgAdmin or run:');
    console.error('  CREATE DATABASE "ShopScale_test";\n');
    console.error(error.stderr?.toString() || error.message);
    throw error;
  }
};
