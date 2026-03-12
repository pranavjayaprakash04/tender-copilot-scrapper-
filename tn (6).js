require('dotenv').config();

const axios                            = require('axios');
const cheerio                          = require('cheerio');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const BASE_URL = 'https://tntenders.gov.in/nicgep/app';
const PORTAL   = 'tn';

// Rotate user agents to avoid blocks
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const REF_NO_PATTERN = /[A-Z0-9].{2,}[\/\-].{1,}[A-Z0-9]/i;
const DATE_PATTERN   = /\d{1,2}[-\/\s](\w{3}|\d{2})[-\/\s]\d{4}/;

const JUNK_PATTERNS = [
  /^function\s/i, /^<[a-z]/i, /window\./i, /document\./i,
  /javascript/i, /screen\s*reader/i, /visitor\s*no/i,
  /designed.*developed/i, /national informatics/i,
  /help for contractors/i, /certifying agency/i,
  /advanced search/i, /mis reports/i, /online bidder/i,
  /welcome to eprocurement/i, /updates every 15/i,
  /search\s*\|/i, /portal policies/i, /tn tenders act/i,
  /select sorting option/i, /enter captcha/i,
  /provide captcha/i, /active tenders back/i,
  /eprocurement system/i, /sorting option/i,
  /sign in/i, /register/i, /forgot password/i,
];

const SKIP_TITLES = new Set([
  'tender title', 'reference no', 'closing date', 'bid opening date',
  'screen reader access', 'certifying agency', 'advanced search',
  'mis reports', 'help for contractors', 'corrigendum title',
  'latest tenders', 'latest corrigendum', 'more...', 'visitor no',
  'prequalification', 'active tenders', 'tenders by closing date',
  'corrigendum', 'results of tenders', 'select sorting option',
  'enter captcha', 'enter captcha refresh', 'active tenders back',
  'sl.no', 'sl. no', 'sno', 's.no',
]);

function isJunk(text) {
  if (!text || text.trim().length === 0) return true;
  if (text.length > 400) return true;
  for (const pat of JUNK_PATTERNS) if (pat.test(text)) return true;
  return false;
}

function isValidTender(title, refNo) {
  if (!title || isJunk(title)) return false;
  if (SKIP_TITLES.has(title.toLowerCase().trim())) return false;
  return !!(refNo && REF_NO_PATTERN.test(refNo));
}

function parseDate(raw) {
  if (!raw) return null;
  const m1 = raw.match(/(\d{1,2})[-\s\/](\w{3})[-\s\/](\d{4})/);
  if (m1) { const d = new Date(`${m1[1]} ${m1[2]} ${m1[3]}`); if (!isNaN(d.getTime())) return d.toISOString(); }
  const m2 = raw.match(/(\d{1,2})[-\/](\d{2})[-\/](\d{4})/);
  if (m2) { const d = new Date(`${m2[3]}-${m2[2]}-${m2[1]}`); if (!isNaN(d.getTime())) return d.toISOString(); }
  return null;
}

function makeTenderId(refNo, title) {
  const base = (refNo && REF_NO_PATTERN.test(refNo))
    ? refNo.replace(/\s+/g, '')
    : title.replace(/\s+/g, '').substring(0, 80);
  return `TN-${base}`.substring(0, 200);
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Build axios session with cookie jar behaviour
function makeClient() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      'User-Agent': randomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': 'https://tntenders.gov.in/',
    },
    maxRedirects: 5,
  });
}

function parseTendersFromHtml(html) {
  const $ = cheerio.load(html);
  const tenders = [];

  // Check if captcha wall is present — if so, return empty with flag
  if ($('#captchaImage, img[src*="captcha"]').length > 0) {
    logger.warn('[TN] Captcha wall detected in HTML response — axios approach blocked');
    return { tenders: [], captchaBlocked: true };
  }

  // Try all tables on the page
  $('table').each((_, table) => {
    $(table).find('tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const getText = (i) => $(cells[i]).text().trim().replace(/\s+/g, ' ');

      const rawTitle = getText(0);
      const title    = rawTitle.replace(/^\d+\.\s*/, '').trim();
      const col1     = cells.length > 1 ? getText(1) : '';
      const col2     = cells.length > 2 ? getText(2) : '';
      const col3     = cells.length > 3 ? getText(3) : '';

      let refNo = '', closingRaw = '';
      if (DATE_PATTERN.test(col1))      { closingRaw = col1; refNo = col2; }
      else if (DATE_PATTERN.test(col2)) { refNo = col1; closingRaw = col2; }
      else if (DATE_PATTERN.test(col3)) { refNo = col1; closingRaw = col3; }
      else                              { refNo = col1; closingRaw = col2; }

      if (!isValidTender(title, refNo)) return;

      // Get detail URL
      let detailUrl = '';
      const link = $(row).find('a[href]').first();
      if (link.length) {
        const href = link.attr('href') || '';
        detailUrl = href.startsWith('http') ? href : `https://tntenders.gov.in${href}`;
      }

      tenders.push({
        tender_id:    makeTenderId(refNo, title),
        title:        title.substring(0, 500),
        organization: 'Tamil Nadu Government',
        portal:       PORTAL,
        bid_end_date: parseDate(closingRaw),
        url:          (detailUrl || BASE_URL).substring(0, 1000),
        scraped_at:   new Date().toISOString(),
      });
    });
  });

  return { tenders, captchaBlocked: false };
}

async function scrapeTN() {
  const startTime = Date.now();
  logger.info('Starting scraper on TN Tenders');
  let totalScraped = 0;
  let pageNum = 1;

  try {
    const client = makeClient();

    // Step 1: Hit home page first to get session cookies
    logger.info('[TN] Initialising session...');
    try {
      await client.get('https://tntenders.gov.in/nicgep/app');
      await sleep(1500);
    } catch (e) {
      logger.warn(`[TN] Session init failed (continuing): ${e.message}`);
    }

    // Step 2: Fetch tender list pages
    while (true) {
      logger.info(`[TN] Fetching page ${pageNum}`);

      let html = '';
      try {
        const params = {
          page: 'FrontEndLatestActiveTenders',
          service: 'page',
        };
        if (pageNum > 1) params.pageNo = pageNum;

        const resp = await client.get('', { params });
        html = resp.data;
        logger.info(`[TN] Page ${pageNum} — HTTP ${resp.status}, ${html.length} bytes`);
      } catch (err) {
        logger.error(`[TN] Fetch failed page ${pageNum}: ${err.message}`);
        break;
      }

      const { tenders, captchaBlocked } = parseTendersFromHtml(html);

      if (captchaBlocked) {
        logger.error('[TN] Server returned captcha page to axios — site requires JS session. Falling back to 0 tenders.');
        break;
      }

      logger.info(`[TN] Page ${pageNum} — ${tenders.length} valid tenders`);

      if (tenders.length === 0 && pageNum > 1) break;

      if (tenders.length > 0) {
        await upsertTenders(tenders);
        totalScraped += tenders.length;
      }

      // Check if there's a next page link in the HTML
      const $ = cheerio.load(html);
      const hasNext = $('a:contains("Next >"), input[value="Next >"]').length > 0;
      if (!hasNext) break;

      pageNum++;
      await sleep(2000 + Math.random() * 2000);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`TN done. ${totalScraped} valid tenders in ${duration}s`);
    await logScraperRun({ portal: PORTAL, status: 'success', count: totalScraped });

  } catch (err) {
    logger.error(`TN failed: ${err.message}`);
    await logScraperRun({ portal: PORTAL, status: 'error', count: 0, message: err.message }).catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  scrapeTN().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { scrapeTN };
