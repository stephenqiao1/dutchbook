import 'dotenv/config';

import { defineConfig } from 'drizzle-kit';

// Read the env directly rather than importing src/config.ts: drizzle-kit bundles
// this file on its own, and a CLI that only needs DATABASE_URL shouldn't fail
// because an unrelated app variable is missing.
const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
