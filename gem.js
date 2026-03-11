require('dotenv').config();

const axios                            = require('axios');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

// ── GeM AJAX endpoint ─────────────────────────────────────────────────────────
// bidplus.gem.gov.in/all-bids loads data via an internal paginated endpoint.
// We call it directly with axios — no browser/Playwright needed.

const BASE        = 'https://bidplus.gem.gov.in';
const LIST_URL    = `${BASE}/bidding/bid/getBidPageData`;
const DETAIL_BASE = `${BASE}/bidding/bid/showbidDocument/`;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Referer':         `${BASE}/all-bids`,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw.trim().replace(/\s+/g, ' '));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseBidCards(html) {
  const tenders = [];
  const src = typeof html === 'string' ? html : JSON.stringify(html);

  // Each bid card contains a link like /bidding/bid/showbidDocument/1234567
  // and structured divs for bid number, title, org, end date
  const docIdPattern = /showbidDocument\/(\d+)/g;
  const chunks = src.split(/(?=showbidDocument\/\d+)/);

  for (const chunk of chunks) {
    const idMatch = chunk.match(/showbidDocument\/(\d+)/);
    if (!idMatch) continue;
    const docId = idMatch[1];

    // Bid reference number (GEM/YYYY/B/NNNNN)
    const numMatch = chunk.match(/(GEM\/\d{4}\/[A-Z]+\/\d+)/i);
    const bidNum   = numMatch ? numMatch[1].trim() : `GEM-${docId}`;

    // Strip all HTML tags for text extraction
    const text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // Title: usually the longest meaningful sentence
    const titleMatch = text.match(/([A-Z][^.!?\n]{20,120})/);
    const title = titleMatch ? titleMatch[1].trim() : bidNum;

    // Date pattern DD-MM-YYYY HH:MM or similar
    const dateMatch = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/);
    const endDate   = dateMatch ? dateMatch[1] : null;

    tenders.push({
      tender_id:    bidNum.replace(/\s+/g, ''),
      title:        title.substring(0, 500),
      organization: 'GeM',
      portal:       'gem',
      bid_end_date: parseDate(endDate),
      url:          `${DETAIL_BASE}${docId}`,
      scraped_at:   new Date().toISOString(),
    });
  }

  return tenders;
}

async function scrapeGem() {
  const startTime  = Date.now();
  let totalScraped = 0;
  let pageNum      = 1;

  logger.info('🚀 Starting scraper on GeM (HTTP mode — no browser)');

  try {
    while (true) {
      logger.info(`📄 Fetching GeM page ${pageNum}`);

      let html;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await axios.get(LIST_URL, {
            params:  { searchIndex: 'ra', page: pageNum },
            headers: HEADERS,
            timeout: 30000,
          });
          html = resp.data;
          break;
        } catch (err) {
          logger.warn(`GeM page ${pageNum} attempt ${attempt} failed: ${err.message}`);
          if (attempt < 3) await sleep(5000);
          else { logger.error(`GeM page ${pageNum} failed after 3 attempts — stopping`); }
        }
      }

      if (!html) break;

      const tenders = parseBidCards(html);
      logger.info(`  Found ${tenders.length} tenders on page ${pageNum}`);

      if (tenders.length === 0) {
        logger.info('No tenders parsed — reached end or format changed');
        break;
      }

      await upsertTenders(tenders);
      totalScraped += tenders.length;

      if (pageNum >= 50) { logger.info('Reached 50-page limit — stopping'); break; }

      pageNum++;
      await sleep(2000 + Math.floor(Math.random() * 2000));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ GeM scraper done. Total: ${totalScraped} tenders (${duration}s)`);
    await logScraperRun({ portal: 'gem', status: 'success', count: totalScraped });

  } catch (err) {
    logger.error(`GeM scraper failed: ${err.message}`);
    await logScraperRun({ portal: 'gem', status: 'error', count: totalScraped, message: err.message }).catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) scrapeGem();
module.exports = scrapeGem;
