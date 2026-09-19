-- ============================================================
-- 《AI攻防战：城堡围攻》数据库 Schema
-- PostgreSQL 14+（Supabase / Neon 兼容）
-- 运行：psql "$DATABASE_URL" -f sql/schema.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------- 用户 ----------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9]{3,20}$'),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_seed   TEXT NOT NULL DEFAULT md5(random()::text),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- ---------------- 邮箱验证码（哈希存储；Redis 为主，DB 兜底/审计） ----------------
CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------- 模型供应商配置（BYOK） ----------------
CREATE TABLE IF NOT EXISTS model_providers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  provider_type  TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key_enc    TEXT NOT NULL,
  api_key_iv     TEXT NOT NULL,
  api_key_tag    TEXT NOT NULL,
  api_key_tail   TEXT,
  model_name     TEXT NOT NULL,
  extra_headers  JSONB NOT NULL DEFAULT '{}',
  params         JSONB NOT NULL DEFAULT '{}',
  is_default     BOOLEAN NOT NULL DEFAULT false,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_tested_at TIMESTAMPTZ,
  last_test_ok   BOOLEAN,
  usage_count    BIGINT NOT NULL DEFAULT 0,
  total_tokens   BIGINT NOT NULL DEFAULT 0,
  total_cost     NUMERIC(14,6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_providers_user ON model_providers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_default_per_user
  ON model_providers(user_id) WHERE is_default = true;

-- ---------------- 模型用量 ----------------
CREATE TABLE IF NOT EXISTS model_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id       UUID REFERENCES model_providers(id) ON DELETE SET NULL,
  room_id           TEXT,
  campaign_id       TEXT,
  role              TEXT NOT NULL,
  model_name        TEXT NOT NULL,
  prompt_tokens     INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens      INT NOT NULL DEFAULT 0,
  cost              NUMERIC(14,8) NOT NULL DEFAULT 0,
  latency_ms        INT NOT NULL DEFAULT 0,
  success           BOOLEAN NOT NULL DEFAULT true,
  error_msg         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_user_time ON model_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_room ON model_usage(room_id);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON model_usage(provider_id);

-- ---------------- 对局存档 ----------------
CREATE TABLE IF NOT EXISTS matches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      TEXT NOT NULL,
  mode         TEXT NOT NULL,
  winner_id    UUID,
  turns        INT NOT NULL DEFAULT 0,
  players_json JSONB NOT NULL DEFAULT '[]',
  report       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id);
