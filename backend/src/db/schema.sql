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
  is_active BOOLEAN NOT NULL DEFAULT true,
  device_limit INTEGER NOT NULL DEFAULT 2,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  device_id TEXT,
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

-- Additive migrations for databases created before access-control columns existed.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is a no-op when the column is present.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_limit INTEGER NOT NULL DEFAULT 2;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id TEXT;
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_user_device_idx ON sessions (user_id, device_id);

CREATE TABLE IF NOT EXISTS ddc_classes (
  number TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  parent_number TEXT,
  main_class TEXT NOT NULL,
  level INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ASSIGNED',
  path JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'project_supplied_ddc_reference',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ddc_aliases (
  id SERIAL PRIMARY KEY,
  term TEXT NOT NULL,
  ddc_number TEXT NOT NULL REFERENCES ddc_classes(number),
  source TEXT NOT NULL DEFAULT 'project_alias',
  weight INTEGER NOT NULL DEFAULT 1,
  UNIQUE (term, ddc_number, source)
);

CREATE TABLE IF NOT EXISTS ddc_decisions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  metadata_json JSONB NOT NULL,
  decision_json JSONB NOT NULL,
  ai_recommended_ddc TEXT,
  approved_ddc TEXT,
  approval_status TEXT NOT NULL DEFAULT 'PENDING',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ddc_classes_label_idx ON ddc_classes USING GIN (to_tsvector('english', label));
CREATE INDEX IF NOT EXISTS ddc_aliases_term_idx ON ddc_aliases USING GIN (to_tsvector('english', term));
CREATE INDEX IF NOT EXISTS ddc_decisions_user_idx ON ddc_decisions (user_id, created_at DESC);
