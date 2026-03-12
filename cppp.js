require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

// FIX: Correct URL — FrontEndTendersByOrganisation was showing org list, not tenders
const BASE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndLatestActiveTenders&service=page';
const PORTAL   = 'cppp';

const SEL = {
  tableRows:    'table.list_table tbody tr, tbody tr, table tbody tr',
  captchaImg:   '#captchaImage, img[src*="captcha"]',
};

// FIX 1: Filter out corrigendum/extension noise — these are not real tenders
const NOISE_PATTERNS = [
  /^corrigendum/i,
  /^amendment/i,
  /^bid auto ext/i,
  /date extension/i,
  /^extension[-\s]/i,
  /^revised p\.g/i,
  /^corr$/i,
  /^nda approval/i,
  /^bid due date/i,
  /^pre-tender meet/i,
  /^invitation to pre-tender/i,
];

function isNoiseTender(title) {
  if (!title) return true;
  const t = title.trim();
  if (t.length < 5) return true;
  return NOISE_PATTERNS.some(p => p.test(t));
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw.trim().replace(/\s+/g, ' '));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function makeTenderId(raw) {
  const token = String(raw).replace(/\s+/g, '').substring(0, 100);
  return `CPPP-${token}` || null;
}

class CpppScraper extends BaseScraper {
  constructor() { super(PORTAL); }

  async run() {
    const startTime = Date.now();
    logger.info('🚀 Starting scraper on CPPP');
    let totalScraped = 0;
    let pageNum = 1;

    try {
      await this.launchBrowser();
      const ok = await this.navigateTo(BASE_URL);
      if (!ok) throw new Error('Failed to load CPPP page');

      while (true) {
        logger.info(`📄 Scraping CPPP page ${pageNum}`);
        await this._handleCaptchaIfPresent();

        try {
          await this.page.waitForSelector(SEL.tableRows, { timeout: 15000, state: 'attached' });
        } catch {
          logger.warn(`No tender rows found at page ${pageNum} — stopping`);
          break;
        }

        const tenders = await this._scrapePage();
        const valid = tenders.filter(t => !isNoiseTender(t.title));
        const skipped = tenders.length - valid.length;

        logger.info(`📦 Page ${pageNum} — ${valid.length} valid tenders (${skipped} noise skipped)`);

        if (valid.length === 0 && tenders.length === 0) break;

        if (valid.length > 0) {
          await upsertTenders(valid);
          totalScraped += valid.length;
        }

        // FIX 2: CPPP pagination — try multiple strategies
        const hasNext = await this._goToNextPage(pageNum);
        if (!hasNext) {
          logger.info(`📄 No more pages after page ${pageNum}`);
          break;
        }

        pageNum++;
        await this.randomDelay();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ CPPP done. ${totalScraped} valid tenders in ${duration}s`);
      await logScraperRun({ portal: PORTAL, status: 'success', count: totalScraped });

    } catch (err) {
      logger.error(`💥 CPPP scraper failed: ${err.message}`);
      await logScraperRun({ portal: PORTAL, status: 'error', count: totalScraped, message: err.message }).catch(() => {});
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  async _handleCaptchaIfPresent() {
    try {
      const visible = await this.page.isVisible(SEL.captchaImg, { timeout: 3000 });
      if (!visible) return;
      logger.warn('🔒 CAPTCHA detected on CPPP — attempting to solve...');
      await this.solveCaptcha(this.page);
    } catch {}
  }

  async _scrapePage() {
    const tenders = [];
    try {
      const rows = await this.page.$$(SEL.tableRows);
      for (const row of rows) {
        try {
          const t = await this._extractRow(row);
          if (t) tenders.push(t);
        } catch (err) {
          logger.warn(`Failed to extract row: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Page scrape error: ${err.message}`);
    }
    return tenders;
  }

  async _extractRow(row) {
    const cells = await row.$$('td');
    if (cells.length < 2) return null;

    const t = async (el) => { try { return (await el.textContent())?.trim() ?? ''; } catch { return ''; } };

    const rawId    = cells[0] ? await t(cells[0]) : '';
    const rawTitle = cells[1] ? await t(cells[1]) : '';
    const rawOrg   = cells[2] ? await t(cells[2]) : '';
    const rawDate  = cells[3] ? await t(cells[3]) : '';

    if (!rawTitle && !rawId) return null;

    let detailUrl = '';
    try {
      const a = await row.$('a[href]');
      if (a) {
        const href = await a.getAttribute('href');
        detailUrl = href?.startsWith('http') ? href : `https://eprocure.gov.in${href}`;
      }
    } catch {}

    return {
      tender_id:    makeTenderId(rawId),
      title:        rawTitle.substring(0, 1000),
      organization: (rawOrg || 'Central Government').substring(0, 500),
      portal:       PORTAL,
      bid_end_date: parseDate(rawDate),
      url:          (detailUrl || BASE_URL).substring(0, 1000),
      scraped_at:   new Date().toISOString(),
    };
  }

  // FIX: CPPP uses Apache Tapestry — pagination via hidden pageIndex input + form submit
  async _goToNextPage(currentPage) {
    try {
      const nextPageNum = currentPage + 1;

      // Strategy 1: Tapestry pageIndex hidden input — most common on CPPP
      const moved = await this.page.evaluate((nextPage) => {
        // Look for pageIndex or currentPage hidden input
        const input = document.querySelector(
          'input[name="pageIndex"], input[name="currentPage"], input[name="page"]'
        );
        if (input) {
          input.value = nextPage;
          // Find and submit the parent form
          const form = input.closest('form');
          if (form) { form.submit(); return true; }
        }
        return false;
      }, nextPageNum);

      if (moved) {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await this.page.waitForTimeout(1500);
        logger.info(`[CPPP] Navigated to page ${nextPageNum} via pageIndex input`);
        return true;
      }

      // Strategy 2: find ">" or numbered page link by iterating actual handles
      const allLinks = await this.page.$$('a');
      for (const link of allLinks) {
        const text = (await link.textContent().catch(() => '')).trim();
        if (text === '>' || text === String(nextPageNum) || /^next$/i.test(text)) {
          logger.info(`[CPPP] Clicking pagination link: "${text}"`);
          await link.click();
          await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          await this.page.waitForTimeout(1500);
          return true;
        }
      }

      // Strategy 3: direct URL with page param
      const currentUrl = this.page.url();
      if (currentUrl.includes('pageIndex=') || currentUrl.includes('currentPage=')) {
        const nextUrl = currentUrl
          .replace(/pageIndex=\d+/, `pageIndex=${nextPageNum}`)
          .replace(/currentPage=\d+/, `currentPage=${nextPageNum}`);
        await this.page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.page.waitForTimeout(1500);
        logger.info(`[CPPP] Navigated via URL to page ${nextPageNum}`);
        return true;
      }

      // Debug: log pagination area
      const paginationLinks = await this.page.$$eval(
        'a', els => els
          .filter(a => a.closest('td, .pagination, [class*="page"], [class*="list_footer"]'))
          .map(a => ({ text: a.innerText?.trim(), href: a.href }))
      ).catch(() => []);

      logger.info(`[CPPP] Pagination links found: ${JSON.stringify(paginationLinks.slice(0, 15))}`);
      return false;

    } catch (err) {
      logger.warn(`[CPPP] Pagination error: ${err.message}`);
      return false;
    }
  }
}

if (require.main === module) {
  new CpppScraper().run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = CpppScraper;
