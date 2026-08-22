-- Groups users by library; the rule engine uses the single shared rules/ set, not per-institution profiles.
-- IF NOT EXISTS so ensureSchema() can be re-run safely on every boot.
CREATE TABLE IF NOT EXISTS institutions (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  institution_id INTEGER REFERENCES institutions(id),
  subscription_tier TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS isbn_cache (
  isbn TEXT PRIMARY KEY,
  raw_json JSONB NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marc_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  isbn TEXT,
  marc_json JSONB NOT NULL,
  marc_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS record_edits (
  id SERIAL PRIMARY KEY,
  marc_record_id INTEGER REFERENCES marc_records(id),
  user_prompt TEXT,
  diff_json JSONB,
  provider_used TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  provider TEXT NOT NULL,
  tokens_used INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_state (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) UNIQUE,
  marc_record_id INTEGER REFERENCES marc_records(id),
  ui_state_json JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ddc_relative_index (
  id SERIAL PRIMARY KEY,
  term TEXT NOT NULL,
  ddc_number TEXT NOT NULL,
  qualifier TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', term)) STORED
);

CREATE INDEX IF NOT EXISTS ddc_relative_index_search_idx ON ddc_relative_index USING GIN(search_vector);
