require('dotenv').config();

const axios = require('axios');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger = require('./logger');

const PORTAL = 'gem';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://bidplus.gem.gov.in/all-bids',
  'X-Requested-With': 'XMLHttpRequest',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseValue(str) {
  if (!str) return null;
  const num = parseFloat(String(str).replace(/[₹,\s]/g, ''));
  return isNaN(num) ? null : num;
}

function parseDate(str) {
  if (!str) return null;
  try { const d = new Date(str); return isNaN(d.getTime()) ? null : d.toISOString(); } catch { return null; }
}

function makeTenderId(raw) {
  return `GEM-${String(raw).replace(/\s+/g, '').substring(0, 100)}`;
}

// Try multiple known GeM API endpoints
async function fetchPage(page) {
  const endpoints = [
    `https://bidplus.gem.gov.in/bidding/bid/getBidPageData?searchIndex=ra&page=${page}`,
    `https://bidplus.gem.gov.in/all-bids?page=${page}`,
    `https://bidplus.gem.gov.in/bidding/bid/getBidPageData?page=${page}`,
  ];

  for (const url of endpoints) {
    try {
      logger.info(`[GeM] Trying: ${url}`);
      const res = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      // Log the top-level keys to debug structure
      if (res.data && typeof res.data === 'object') {
        logger.info(`[GeM] Response keys: ${Object.keys(res.data).join(', ')}`);
      }
      return res.data;
    } catch (err) {
      logger.warn(`[GeM] Endpoint failed (${url}): ${err.message}`);
    }
  }
  throw new Error('All GeM endpoints failed');
}

function extractRows(data) {
  if (!data) return [];
  // Try every known path
  const candidates = [
    data?.data?.data,
    data?.data?.bids,
    data?.data?.result,
    data?.data,
    data?.bids,
    data?.result,
    data?.records,
    data?.items,
    data?.list,
    data?.content,
    data?.bidList,
    data?.bidlist,
    data?.tenders,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      logger.info(`[GeM] Found rows array with ${c.length} items`);
      return c;
    }
  }
  // Log the full structure for debugging (first 500 chars)
  logger.warn(`[GeM] Could not find rows. Data snippet: ${JSON.stringify(data).substring(0, 500)}`);
  return [];
}

async function scrapeGeM() {
  const startTime = Date.now();
  const allTenders = [];
  let page = 1;
  let totalPages = 1;
  let tendersFetched = 0;

  logger.info(`[${PORTAL}] Starting scrape`);

  try {
    while (page <= Math.min(totalPages, 50)) {
      logger.info(`[${PORTAL}] Fetching page ${page} of ${totalPages}`);

      let data;
      try {
        data = await fetchPage(page);
      } catch (err) {
        logger.error(`[${PORTAL}] Failed to fetch page ${page}: ${err.message}`);
        break;
      }

      const rows = extractRows(data);
      if (rows.length === 0) {
        logger.warn(`[${PORTAL}] No rows on page ${page}, stopping`);
        break;
      }

      if (page === 1) {
        const total = data?.data?.total || data?.total || data?.totalRecords || data?.count || 0;
        totalPages = total ? Math.ceil(total / rows.length) : 1;
        totalPages = Math.min(totalPages, 50);
        logger.info(`[${PORTAL}] Total: ${total}, pages: ${totalPages}`);
      }

      for (const row of rows) {
        // Try every known field name for bid ID
        const rawId = row.bid_number || row.bidNumber || row.bid_no || row.bidNo
                   || row.id || row.tenderId || row.tender_id || '';
        if (!rawId) continue;

        const tender = {
          portal:          PORTAL,
          tender_id:       makeTenderId(rawId),
          title:           String(
            row.bid_item_description || row.itemDescription || row.item_description
            || row.name || row.title || row.subject || ''
          ).substring(0, 1000),
          organization:    String(
            row.buying_org_name || row.buyerOrgName || row.buyer_org_name
            || row.department || row.ministry || row.org_name || ''
          ).substring(0, 500),
          bid_end_date:    parseDate(
            row.bid_submission_end_date || row.endDate || row.end_date
            || row.closing_date || row.closingDate || row.bid_end_date
          ),
          estimated_value: parseValue(
            row.consignee_quantity_value || row.estimatedValue || row.estimated_value
            || row.value || row.amount
          ),
          detail_url: `https://bidplus.gem.gov.in/bidlists/detail/${rawId}`.substring(0, 1000),
          url:        `https://bidplus.gem.gov.in/bidlists/detail/${rawId}`.substring(0, 1000),
          scraped_at: new Date().toISOString(),
        };

        allTenders.push(tender);
        tendersFetched++;
      }

      logger.info(`[${PORTAL}] Page ${page}: ${rows.length} rows (total: ${tendersFetched})`);
      page++;
      if (page <= totalPages) await sleep(1500);
    }

    logger.info(`[${PORTAL}] Scrape complete. Total: ${tendersFetched}`);

    if (allTenders.length > 0) {
      await upsertTenders(allTenders);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    await logScraperRun({ portal: PORTAL, status: 'success', count: tendersFetched });
    logger.info(`[${PORTAL}] Done in ${duration}s`);
    process.exit(0);

  } catch (err) {
    logger.error(`[${PORTAL}] Fatal: ${err.message}`);
    await logScraperRun({ portal: PORTAL, status: 'error', message: err.message, count: tendersFetched }).catch(() => {});
    process.exit(1);
  }
}

scrapeGeM();
