const { execSync } = require('child_process');
const dotenv = require('dotenv');
const path = require('path');

// Load test environment before running prisma commands
dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });

module.exports = async function () {
  try {
    // Push schema to test database (creates DB if it doesn't exist, resets all data)
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
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
