require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const JUNK_PATTERNS = [
  /^function\s/i, /^<[a-z]/i, /window\./i, /document\./i,
  /javascript/i, /screen\s*reader/i, /visitor\s*no/i,
  /designed.*developed/i, /national informatics/i,
  /help for contractors/i, /certifying agency/i,
  /advanced search/i, /mis reports/i, /online bidder/i,
  /welcome to eprocurement/i, /updates every 15/i,
  /search\s*\|/i, /portal policies/i,
];

function isJunkTender(t) {
  if (!t.tender_id || !t.title) return true;
  if (t.title.length > 400) return true;
  if (t.tender_id.length > 200) return true;
  for (const pat of JUNK_PATTERNS) {
    if (pat.test(t.title)) return true;
    if (pat.test(t.tender_id)) return true;
  }
  return false;
}

function sanitizeTenders(tenders) {
  const seen = new Map();
  for (const t of tenders) {
    if (!t.tender_id) continue;
    if (isJunkTender(t)) continue;

    const clean = {
      ...t,
      tender_id:    String(t.tender_id).substring(0, 200),
      title:        t.title        ? String(t.title).substring(0, 500)        : null,
      organization: t.organization ? String(t.organization).substring(0, 300)  : null,
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
  if (unique.length === 0) {
    logger.warn('All tenders filtered as junk — nothing to upsert');
    return;
  }

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

  logger.info(`✅ Upserted ${unique.length} clean tenders`);
}

async function logScraperRun({ portal, status, count = 0, message = null }) {
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
