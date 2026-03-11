require('dotenv').config();

const axios = require('axios');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger = require('./logger');

const BASE_URL = 'https://bidplus.gem.gov.in/bidding/bid/getBidPageData';
const PORTAL = 'gem';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://bidplus.gem.gov.in/all-bids',
  'X-Requested-With': 'XMLHttpRequest',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseValue(str) {
  if (!str) return null;
  const num = parseFloat(String(str).replace(/[₹,\s]/g, ''));
  return isNaN(num) ? null : num;
}

function parseDate(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

function makeTenderId(raw) {
  return `GEM-${String(raw).replace(/\s+/g, '').substring(0, 100)}`;
}

async function fetchPage(page) {
  const url = `${BASE_URL}?searchIndex=ra&page=${page}`;
  const response = await axios.get(url, { headers: HEADERS, timeout: 30000 });
  return response.data;
}

async function scrapeGeM() {
  const startTime = Date.now();
  const allTenders = [];
  let page = 1;
  let totalPages = 1;
  let tendersFetched = 0;

  logger.info(`[${PORTAL}] Starting scrape`);

  try {
    while (page <= totalPages) {
      logger.info(`[${PORTAL}] Fetching page ${page} of ${totalPages}`);

      let data;
      try {
        data = await fetchPage(page);
      } catch (err) {
        logger.error(`[${PORTAL}] Failed to fetch page ${page}: ${err.message}`);
        break;
      }

      const rows = data?.data?.data || data?.data || data?.bids || data?.result || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        logger.warn(`[${PORTAL}] No rows found on page ${page}, stopping`);
        break;
      }

      if (page === 1) {
        const total = data?.data?.total || data?.total || 0;
        totalPages = total ? Math.ceil(total / rows.length) : 1;
        // Cap at 50 pages to avoid runaway
        totalPages = Math.min(totalPages, 50);
        logger.info(`[${PORTAL}] Total records: ${total}, pages: ${totalPages}`);
      }

      for (const row of rows) {
        const rawId = row.bid_number || row.bidNumber || row.id || '';
        if (!rawId) continue;

        const tender = {
          portal:          PORTAL,
          tender_id:       makeTenderId(rawId),
          title:           String(row.bid_item_description || row.itemDescription || row.name || '').substring(0, 1000),
          organization:    String(row.buying_org_name || row.buyerOrgName || row.department || '').substring(0, 500),
          bid_end_date:    parseDate(row.bid_submission_end_date || row.endDate || row.closing_date),
          estimated_value: parseValue(row.consignee_quantity_value || row.estimatedValue || row.value),
          detail_url:      `https://bidplus.gem.gov.in/bidlists/detail/${rawId}`.substring(0, 1000),
        };

        allTenders.push(tender);
        tendersFetched++;
      }

      logger.info(`[${PORTAL}] Page ${page}: ${rows.length} rows (total so far: ${tendersFetched})`);
      page++;
      if (page <= totalPages) await sleep(1500);
    }

    logger.info(`[${PORTAL}] Scrape complete. Total tenders: ${tendersFetched}`);

    if (allTenders.length > 0) {
      await upsertTenders(allTenders);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    await logScraperRun({ portal: PORTAL, status: 'success', tenders_found: tendersFetched, duration_seconds: duration });
    logger.info(`[${PORTAL}] Done in ${duration}s`);
    process.exit(0);

  } catch (err) {
    logger.error(`[${PORTAL}] Fatal error: ${err.message}`);
    await logScraperRun({ portal: PORTAL, status: 'error', error_message: err.message, tenders_found: tendersFetched }).catch(() => {});
    process.exit(1);
  }
}

scrapeGeM();
