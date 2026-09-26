module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  globalSetup: './tests/global-setup.js',
  setupFiles: ['./tests/setup.js'],
};
