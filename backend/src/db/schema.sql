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

-- ---------------------------------------------------------------------
-- MARC21 framework engine.
--
-- Two layers, never merged:
--   1. General MARC21 vocabulary -- marc_fields/marc_subfields/marc_indicators,
--      seeded once against the "GENERAL" framework row. This is the master
--      MARC21 definition: what a tag/subfield *means*. It is never deleted
--      or mutated when a custom framework changes.
--   2. Per-framework configuration -- framework_field_settings /
--      framework_subfield_settings. A custom framework (or the GENERAL
--      framework itself) is a set of rows pointing at the master
--      marc_fields/marc_subfields rows, carrying only what differs per
--      framework: enabled, required, default_value, display_order.
-- Disabling/require-ing a field in one framework only touches that
-- framework's settings rows -- the master marc_fields/marc_subfields rows
-- are untouched.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marc_frameworks (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  framework_type TEXT NOT NULL CHECK (framework_type IN ('GENERAL', 'CUSTOM')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Master MARC21 vocabulary. One row per tag, independent of any framework.
CREATE TABLE IF NOT EXISTS marc_fields (
  id SERIAL PRIMARY KEY,
  tag TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  section TEXT NOT NULL,
  repeatable BOOLEAN NOT NULL DEFAULT false,
  field_type TEXT NOT NULL CHECK (field_type IN ('CONTROL_FIELD', 'VARIABLE_FIELD')) DEFAULT 'VARIABLE_FIELD',
  authority_control BOOLEAN NOT NULL DEFAULT false,
  is_koha_field BOOLEAN NOT NULL DEFAULT false,
  minimal_definition BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marc_subfields (
  id SERIAL PRIMARY KEY,
  field_id INTEGER NOT NULL REFERENCES marc_fields(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  repeatable BOOLEAN NOT NULL DEFAULT false,
  required BOOLEAN NOT NULL DEFAULT false,
  default_value TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  authority_control BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (field_id, code)
);

CREATE TABLE IF NOT EXISTS marc_indicators (
  id SERIAL PRIMARY KEY,
  field_id INTEGER NOT NULL REFERENCES marc_fields(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position IN (1, 2)),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  UNIQUE (field_id, position, code)
);

-- Per-framework field configuration. Every framework (GENERAL included) has
-- its own settings rows so "what does this framework show" is always a
-- plain settings lookup, never a special case for GENERAL.
CREATE TABLE IF NOT EXISTS framework_field_settings (
  id SERIAL PRIMARY KEY,
  framework_id INTEGER NOT NULL REFERENCES marc_frameworks(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES marc_fields(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  required BOOLEAN NOT NULL DEFAULT false,
  default_value TEXT,
  -- Which tab (Koha's "0"-"9" section navigation) this field appears under
  -- *for this framework*. Deliberately independent of marc_fields.section
  -- (the field's general MARC block, e.g. "2XX") -- a framework's own
  -- section tab grouping (per its screenshots/local practice) can and does
  -- diverge from the general MARC block a tag semantically belongs to.
  section TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (framework_id, field_id)
);

CREATE TABLE IF NOT EXISTS framework_subfield_settings (
  id SERIAL PRIMARY KEY,
  framework_field_setting_id INTEGER NOT NULL REFERENCES framework_field_settings(id) ON DELETE CASCADE,
  subfield_id INTEGER NOT NULL REFERENCES marc_subfields(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  required BOOLEAN NOT NULL DEFAULT false,
  default_value TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (framework_field_setting_id, subfield_id)
);

CREATE INDEX IF NOT EXISTS marc_fields_section_idx ON marc_fields (section, display_order);
CREATE INDEX IF NOT EXISTS marc_subfields_field_idx ON marc_subfields (field_id, display_order);
CREATE INDEX IF NOT EXISTS marc_indicators_field_idx ON marc_indicators (field_id, position);
CREATE INDEX IF NOT EXISTS framework_field_settings_framework_idx ON framework_field_settings (framework_id, display_order);
CREATE INDEX IF NOT EXISTS framework_subfield_settings_setting_idx ON framework_subfield_settings (framework_field_setting_id, display_order);
