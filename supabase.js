require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Deduplicate by tender_id and truncate all fields before upserting
function sanitizeTenders(tenders) {
  const seen = new Map();
  for (const t of tenders) {
    if (!t.tender_id) continue;
    const clean = {
      ...t,
      tender_id:    String(t.tender_id).substring(0, 200),
      title:        t.title        ? String(t.title).substring(0, 1000)        : null,
      organization: t.organization ? String(t.organization).substring(0, 500)  : null,
      url:          t.url          ? String(t.url).substring(0, 1000)          : null,
      detail_url:   t.detail_url   ? String(t.detail_url).substring(0, 1000)   : null,
    };
    seen.set(clean.tender_id, clean);
  }
  return Array.from(seen.values());
}

async function upsertTenders(tenders) {
  if (!tenders || tenders.length === 0) return;

  const unique = sanitizeTenders(tenders);
  if (unique.length === 0) return;

  // Batch in groups of 50 to avoid payload limits
  const BATCH = 50;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const { error } = await supabase
      .from('tenders')
      .upsert(batch, { onConflict: 'tender_id', ignoreDuplicates: false });
    if (error) {
      logger.error(`Supabase upsert error: ${error.message}`);
      throw error;
    }
  }

  logger.info(`✅ Upserted ${unique.length} tenders to Supabase`);
}

async function logScraperRun({ portal, status, count = 0, message = null, duration_s = null }) {
  try {
    const { error } = await supabase.from('scraper_logs').insert({
      portal,
      status,
      tenders_found: count,
      error_message: message ? String(message).substring(0, 500) : null,
      ran_at: new Date().toISOString(),
    });
    if (error) throw error;
    logger.info(`log scraper run: portal=${portal} status=${status} tenders=${count}`);
  } catch (err) {
    logger.error(`Failed to log scraper run: ${err.message}`);
  }
}

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
