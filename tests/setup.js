const dotenv = require('dotenv');
const path = require('path');

// Load .env.test BEFORE any application module is imported.
// dotenv does not override existing vars, so test values take priority
// over .env values loaded later by src/config/env.js.
dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });
 
const { assertTestDatabase } = require('./test-db-guard');
assertTestDatabase();
