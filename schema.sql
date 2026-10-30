-- ════════════════════════════════════════════
--  TenderPilot Scraper — Supabase Schema
--  Run this in your Supabase SQL Editor
-- ════════════════════════════════════════════

-- Tenders table
CREATE TABLE IF NOT EXISTS tenders (
  id                BIGSERIAL PRIMARY KEY,
  tender_id         TEXT UNIQUE NOT NULL,       -- portal-prefixed source ID
  title             TEXT,
  department        TEXT,
  organization      TEXT,
  portal            TEXT NOT NULL,              -- scraper source key (gem, cppp, tn, nic-*)
  closing_date      DATE,
  bid_end_date      TIMESTAMPTZ,
  estimated_value   NUMERIC,
  detail_url        TEXT,
  url               TEXT,
  required_documents JSONB,
  category          TEXT,
  location          TEXT,
  emd_amount        NUMERIC,
  apply_url         TEXT,
  details           JSONB,
  status            TEXT DEFAULT 'active',      -- active, closed, cancelled
  scraped_at        TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Add scraper fields to databases created from earlier versions of this schema.
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS organization TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS bid_end_date TIMESTAMPTZ;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS required_documents JSONB;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS emd_amount NUMERIC;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS apply_url TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS details JSONB;

-- Auto-update updated_at on any change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenders_updated_at ON tenders;
CREATE TRIGGER tenders_updated_at
  BEFORE UPDATE ON tenders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Index for fast querying by portal, status, closing date
CREATE INDEX IF NOT EXISTS idx_tenders_portal ON tenders(portal);
CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(status);
CREATE INDEX IF NOT EXISTS idx_tenders_closing_date ON tenders(closing_date);
CREATE INDEX IF NOT EXISTS idx_tenders_scraped_at ON tenders(scraped_at);

-- Full text search on title and department
CREATE INDEX IF NOT EXISTS idx_tenders_title_fts ON tenders USING GIN(to_tsvector('english', title));

-- ────────────────────────────────────────────

-- Scraper logs table (tracks every run)
CREATE TABLE IF NOT EXISTS scraper_logs (
  id              BIGSERIAL PRIMARY KEY,
  portal          TEXT NOT NULL,
  status          TEXT NOT NULL,               -- success, error
  tenders_found   INTEGER DEFAULT 0,
  error_message   TEXT,
  ran_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraper_logs_portal ON scraper_logs(portal);
CREATE INDEX IF NOT EXISTS idx_scraper_logs_ran_at ON scraper_logs(ran_at);

-- ────────────────────────────────────────────
-- Useful views

-- Active tenders closing in next 7 days
CREATE OR REPLACE VIEW tenders_closing_soon AS
SELECT *
FROM tenders
WHERE status = 'active'
  AND COALESCE(bid_end_date::date, closing_date) BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
ORDER BY COALESCE(bid_end_date::date, closing_date) ASC;

-- Scraper health dashboard
CREATE OR REPLACE VIEW scraper_health AS
SELECT
  portal,
  COUNT(*) FILTER (WHERE status = 'success') AS successful_runs,
  COUNT(*) FILTER (WHERE status = 'error') AS failed_runs,
  MAX(ran_at) AS last_run,
  SUM(tenders_found) AS total_tenders_collected
FROM scraper_logs
WHERE ran_at > NOW() - INTERVAL '7 days'
GROUP BY portal;
