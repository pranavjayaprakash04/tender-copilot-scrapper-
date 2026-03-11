require('dotenv').config();

const axios = require('axios');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger = require('./logger');

// ── GeM AJAX endpoint ─────────────────────────────────────────────────────────
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
  const cleaned = String(str).replace(/[₹,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseDate(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

async function fetchPage(page) {
  const url = `${BASE_URL}?searchIndex=ra&page=${page}`;
  const response = await axios.get(url, {
    headers: HEADERS,
    timeout: 30000,
  });
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

      // Handle various response shapes
      const rows = data?.data?.data || data?.data || data?.bids || data?.result || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        logger.warn(`[${PORTAL}] No rows found on page ${page}, stopping`);
        break;
      }

      // Set total pages from first response
      if (page === 1) {
        const total = data?.data?.total || data?.total || 0;
        const perPage = rows.length || 20;
        totalPages = total ? Math.ceil(total / perPage) : 1;
        logger.info(`[${PORTAL}] Total records: ${total}, pages: ${totalPages}`);
      }

      for (const row of rows) {
        const tender = {
          portal: PORTAL,
          tender_id: String(row.bid_number || row.bidNumber || row.id || '').trim(),
          title: String(row.bid_item_description || row.itemDescription || row.name || '').trim(),
          organization: String(row.buying_org_name || row.buyerOrgName || row.department || '').trim(),
          bid_end_date: parseDate(row.bid_submission_end_date || row.endDate || row.closing_date),
          estimated_value: parseValue(row.consignee_quantity_value || row.estimatedValue || row.value),
          detail_url: row.bid_number
            ? `https://bidplus.gem.gov.in/bidlists/detail/${row.bid_number}`
            : null,
          raw: row,
        };

        if (tender.tender_id) {
          allTenders.push(tender);
          tendersFetched++;
        }
      }

      logger.info(`[${PORTAL}] Page ${page}: ${rows.length} rows (total so far: ${tendersFetched})`);

      page++;
      if (page <= totalPages) await sleep(1500);
    }

    logger.info(`[${PORTAL}] Scrape complete. Total tenders: ${tendersFetched}`);

    if (allTenders.length > 0) {
      await upsertTenders(allTenders);
      logger.info(`[${PORTAL}] Upserted ${allTenders.length} tenders to Supabase`);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    await logScraperRun({
      portal: PORTAL,
      status: 'success',
      tenders_found: tendersFetched,
      duration_seconds: duration,
    });

    logger.info(`[${PORTAL}] Done in ${duration}s`);
    process.exit(0);
  } catch (err) {
    logger.error(`[${PORTAL}] Fatal error: ${err.message}`);

    await logScraperRun({
      portal: PORTAL,
      status: 'error',
      error_message: err.message,
      tenders_found: tendersFetched,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
    }).catch(() => {});

    process.exit(1);
  }
}

scrapeGeM();
