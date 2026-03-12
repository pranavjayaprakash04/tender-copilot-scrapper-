require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const HOME_URL = 'https://tntenders.gov.in/nicgep/app';
const PORTAL   = 'tn';

const SEL = {
  // Top nav links
  tendersByDate:    'a:has-text("Tenders by Closing Date")',
  activeTab:        'a:has-text("Closing within 14 days")',
  // Table
  tableRows:        'table tbody tr',
  // Pagination
  nextPage:         'a:has-text("Next"), input[value*="Next"]',
  // Captcha check
  captcha:          '#captchaImage, img[src*="captcha"]',
};

const REF_NO_PATTERN = /[A-Z0-9].{2,}[\/\-].{1,}[A-Z0-9]/i;
const DATE_PATTERN   = /\d{1,2}[-\/\s](\w{3}|\d{2})[-\/\s]\d{4}/;

const JUNK_PATTERNS = [
  /^function\s/i, /^<[a-z]/i, /window\./i, /document\./i,
  /javascript/i, /screen\s*reader/i, /visitor\s*no/i,
  /designed.*developed/i, /national informatics/i,
  /advanced search/i, /mis reports/i, /search\s*\|/i,
  /eprocurement system/i, /enter captcha/i, /provide captcha/i,
  /no tenders found/i, /closing today/i, /closing within/i,
];

const SKIP_TITLES = new Set([
  'tender title', 'reference no', 'closing date', 'bid opening date',
  'e-published date', 'bid submission closing date', 'tender opening date',
  'title and ref.no./tender id', 'name of dept./orgn.', 'organisation chain',
  's.no', 'sno', 'sl.no', 'screen reader access', 'more...', 'latest tenders',
  'tenders/auctions closing today',
]);

function isJunk(text) {
  if (!text || text.trim().length === 0) return true;
  if (text.length > 500) return true;
  return JUNK_PATTERNS.some(p => p.test(text));
}

function isValidTender(title, refNo) {
  if (!title || isJunk(title)) return false;
  if (SKIP_TITLES.has(title.toLowerCase().trim())) return false;
  if (title.length < 10) return false;
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

class TnScraper extends BaseScraper {
  constructor() { super(PORTAL); }

  async run() {
    const startTime = Date.now();
    logger.info('Starting TN scraper');
    let totalScraped = 0;

    try {
      await this.launchBrowser();

      // Step 1: Load homepage (no captcha confirmed)
      logger.info('[TN] Loading homepage...');
      const ok = await this.navigateTo(HOME_URL);
      if (!ok) throw new Error('Failed to load TN homepage');

      await this.page.waitForTimeout(2000);
      logger.info(`[TN] Homepage loaded: ${this.page.url()}`);

      // Step 2: Click "Tenders by Closing Date" in top nav
      logger.info('[TN] Clicking "Tenders by Closing Date"...');
      await this.page.click(SEL.tendersByDate);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.page.waitForTimeout(2000);
      logger.info(`[TN] Page after nav: ${this.page.url()}`);

      // Check for captcha
      const captchaEl = await this.page.$(SEL.captcha).catch(() => null);
      if (captchaEl) {
        logger.warn('[TN] Captcha appeared after nav — trying Active Tenders instead');
      } else {
        // Step 3: Click "Closing within 14 days" tab
        logger.info('[TN] Clicking "Closing within 14 days" tab...');
        try {
          await this.page.click(SEL.activeTab);
          await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          await this.page.waitForTimeout(1500);
        } catch {
          logger.warn('[TN] Could not click tab — scraping current page');
        }

        // Step 4: Scrape pages
        totalScraped = await this._scrapeAllPages();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`TN done. ${totalScraped} total tenders in ${duration}s`);
      await logScraperRun({ portal: PORTAL, status: 'success', count: totalScraped });

    } catch (err) {
      logger.error(`TN failed: ${err.message}`);
      await logScraperRun({ portal: PORTAL, status: 'error', count: totalScraped, message: err.message }).catch(() => {});
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  async _scrapeAllPages() {
    let pageNum = 1;
    let total = 0;

    while (true) {
      logger.info(`[TN] Scraping page ${pageNum}`);

      try {
        await this.page.waitForSelector(SEL.tableRows, { timeout: 15000, state: 'attached' });
      } catch {
        logger.warn(`[TN] No table rows on page ${pageNum}`);
        break;
      }

      // Log sample on first page
      if (pageNum === 1) {
        const rowCount = await this.page.$$eval('table tbody tr', r => r.length).catch(() => 0);
        const sample   = await this.page.$eval('table tbody tr:first-child', el => el.innerText?.substring(0, 200)).catch(() => '');
        logger.info(`[TN] Page ${pageNum}: ${rowCount} rows. Sample: ${sample}`);
      }

      const tenders = await this._scrapePage();
      logger.info(`[TN] Page ${pageNum} — ${tenders.length} valid tenders`);

      if (tenders.length === 0 && pageNum > 1) break;

      if (tenders.length > 0) {
        await upsertTenders(tenders);
        total += tenders.length;
      }

      const hasNext = await this._goToNextPage();
      if (!hasNext) break;

      pageNum++;
      await this.randomDelay();
    }

    return total;
  }

  async _scrapePage() {
    const tenders = [];
    const rows = await this.page.$$(SEL.tableRows).catch(() => []);

    for (const row of rows) {
      try {
        const t = await this._extractRow(row);
        if (t) tenders.push(t);
      } catch (err) {
        logger.warn(`[TN] Row error: ${err.message}`);
      }
    }
    return tenders;
  }

  async _extractRow(row) {
    const cells = await row.$$('td');
    if (cells.length < 2) return null;

    const getText = async (el) => {
      try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
      catch { return ''; }
    };

    const allCells = await Promise.all(cells.map(getText));

    // "Tenders by Date" 6-column layout:
    // [0] S.No | [1] e-Published | [2] Bid Closing | [3] Opening | [4] Title+RefNo | [5] Organisation
    if (allCells.length >= 5) {
      const titleCell = allCells[4] || '';
      const org       = allCells[5] || 'Tamil Nadu Government';
      const closing   = allCells[2] || '';

      // Title cell: "Title text [RefNo/2026] [2026_XXXX_1]"
      const match = titleCell.match(/^([\s\S]+?)\s*\[([^\]]+)\]\s*(?:\[([^\]]+)\])?/);
      const title = match ? match[1].trim() : titleCell.split('[')[0].trim();
      const refNo = match ? match[2].trim() : '';

      const orgClean = org.split('||')[0].trim().substring(0, 200);

      if (!isValidTender(title, refNo)) return null;

      let detailUrl = '';
      try {
        const a = await row.$('a[href]');
        if (a) {
          const href = await a.getAttribute('href');
          detailUrl = href?.startsWith('http') ? href : `https://tntenders.gov.in${href}`;
        }
      } catch {}

      return {
        tender_id:    makeTenderId(refNo, title),
        title:        title.substring(0, 500),
        organization: orgClean,
        portal:       PORTAL,
        bid_end_date: parseDate(closing),
        url:          (detailUrl || HOME_URL).substring(0, 1000),
        scraped_at:   new Date().toISOString(),
      };
    }

    // Fallback: simpler layout (homepage latest tenders, 4 columns)
    const title      = allCells[0].replace(/^\d+\.\s*/, '').trim();
    const refNo      = allCells[1] || '';
    const closingRaw = allCells[2] || '';

    if (!isValidTender(title, refNo)) return null;

    let detailUrl = '';
    try {
      const a = await row.$('a[href]');
      if (a) {
        const href = await a.getAttribute('href');
        detailUrl = href?.startsWith('http') ? href : `https://tntenders.gov.in${href}`;
      }
    } catch {}

    return {
      tender_id:    makeTenderId(refNo, title),
      title:        title.substring(0, 500),
      organization: 'Tamil Nadu Government',
      portal:       PORTAL,
      bid_end_date: parseDate(closingRaw),
      url:          (detailUrl || HOME_URL).substring(0, 1000),
      scraped_at:   new Date().toISOString(),
    };
  }

  async _goToNextPage() {
    try {
      const next = await this.page.$(SEL.nextPage);
      if (!next) return false;
      const cls = await next.getAttribute('class') ?? '';
      if (cls.includes('disabled')) return false;
      await next.click();
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      return true;
    } catch { return false; }
  }
}

if (require.main === module) {
  new TnScraper().run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = TnScraper;
