require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

// ── Client ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── upsertTenders ─────────────────────────────────────────────────────────────

/**
 * Insert or update an array of tender objects into the `tenders` table.
 * Conflicts on `tender_id` are ignored (upsert = update existing row).
 */
async function upsertTenders(tenders) {
  if (!tenders || tenders.length === 0) return;

  try {
    const { error } = await supabase
      .from('tenders')
      .upsert(tenders, { onConflict: 'tender_id', ignoreDuplicates: false });

    if (error) throw error;

    logger.info(`✅ Upserted ${tenders.length} tenders to Supabase`);
  } catch (err) {
    logger.error(`Supabase upsert error: ${err.message}`);
    throw err;
  }
}

// ── logScraperRun ─────────────────────────────────────────────────────────────

/**
 * Insert a row into `scraper_logs` to record every run.
 * @param {{ portal: string, status: string, count?: number, message?: string, duration_s?: number }} opts
 */
async function logScraperRun({ portal, status, count = 0, message = null, duration_s = null }) {
  try {
    const { error } = await supabase.from('scraper_logs').insert({
      portal,
      status,
      tenders_found: count,
      error_message: message,
      ran_at: new Date().toISOString(),
    });

    if (error) throw error;

    logger.info(`log scraper run: portal=${portal} status=${status} tenders=${count}`);
  } catch (err) {
    logger.error(`Failed to log scrape r run: ${err.message}`);
    // Don't rethrow — logging failure should not crash the scraper
  }
}

// ── Connection check ──────────────────────────────────────────────────────────

/**
 * Quick sanity-check that Supabase credentials are working.
 */
async function checkConnection() {
  try {
    const { error } = await supabase.from('tenders').select('id').limit(1);
    if (error) throw error;
    logger.info('Supabase connection OK');
    return true;
  } catch (err) {
    logger.error(`Supabase connection error: ${err.message}`);
    return false;
  }
}

module.exports = { supabase, upsertTenders, logScraperRun, checkConnection };
