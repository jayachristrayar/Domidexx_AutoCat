-- Groups users by library; the rule engine uses the single shared rules/ set, not per-institution profiles.
CREATE TABLE institutions (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  institution_id INTEGER REFERENCES institutions(id),
  subscription_tier TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE isbn_cache (
  isbn TEXT PRIMARY KEY,
  raw_json JSONB NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE marc_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  isbn TEXT,
  marc_json JSONB NOT NULL,
  marc_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE record_edits (
  id SERIAL PRIMARY KEY,
  marc_record_id INTEGER REFERENCES marc_records(id),
  user_prompt TEXT,
  diff_json JSONB,
  provider_used TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE api_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  provider TEXT NOT NULL,
  tokens_used INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE draft_state (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) UNIQUE,
  marc_record_id INTEGER REFERENCES marc_records(id),
  ui_state_json JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ddc_relative_index (
  id SERIAL PRIMARY KEY,
  term TEXT NOT NULL,
  ddc_number TEXT NOT NULL,
  qualifier TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', term)) STORED
);
CREATE INDEX ddc_relative_index_search_idx ON ddc_relative_index USING GIN(search_vector);
