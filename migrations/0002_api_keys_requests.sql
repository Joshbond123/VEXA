-- Older deployments created api_keys without the requests counter.
-- SQLite has no ADD COLUMN IF NOT EXISTS, so apply once:
--   wrangler d1 execute vexa_colab --remote --file migrations/0002_api_keys_requests.sql
ALTER TABLE api_keys ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
