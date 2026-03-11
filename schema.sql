-- ════════════════════════════════════════════
--  TenderPilot Scraper — Supabase Schema
--  Run this in your Supabase SQL Editor
-- ════════════════════════════════════════════

-- Tenders table
CREATE TABLE IF NOT EXISTS tenders (
  id                BIGSERIAL PRIMARY KEY,
  tender_id         TEXT UNIQUE NOT NULL,       -- e.g. GEM-12345, CPPP-ABC-123
  title             TEXT,
  department        TEXT,
  portal            TEXT NOT NULL,              -- GeM, CPPP, TN Tenders
  closing_date      DATE,
  estimated_value   NUMERIC,
  detail_url        TEXT,
  status            TEXT DEFAULT 'active',      -- active, closed, cancelled
  scraped_at        TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at on any change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
  AND closing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
ORDER BY closing_date ASC;

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
