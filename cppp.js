require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const BASE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndTendersByOrganisation';
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

  // FIX 2: Multi-strategy pagination for CPPP
  async _goToNextPage(currentPage) {
    try {
      // Strategy 1: look for exact ">" or "Next" link in pagination
      const nextEl = await this.page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return (
          links.find(a => a.innerText?.trim() === '>') ||
          links.find(a => /\bnext\b/i.test(a.innerText?.trim())) ||
          null
        );
      });

      if (nextEl && nextEl.toString() !== 'JSHandle:null') {
        logger.info(`[CPPP] Clicking next page via link`);
        await nextEl.click();
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await this.page.waitForTimeout(1500);
        return true;
      }

      // Strategy 2: look for numbered page link = currentPage + 1
      const nextPageNum = currentPage + 1;
      const pageLink = await this.page.$(`a:has-text("${nextPageNum}")`);
      if (pageLink) {
        logger.info(`[CPPP] Clicking page number ${nextPageNum}`);
        await pageLink.click();
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await this.page.waitForTimeout(1500);
        return true;
      }

      // Strategy 3: check for a form input with page number
      const pageInput = await this.page.$('input[name="pageNumber"], input[name="page"]');
      if (pageInput) {
        logger.info(`[CPPP] Navigating via page input to page ${nextPageNum}`);
        await pageInput.fill(String(nextPageNum));
        await pageInput.press('Enter');
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await this.page.waitForTimeout(1500);
        return true;
      }

      // Strategy 4: log all pagination links for debug
      const paginationLinks = await this.page.$$eval(
        'a', els => els
          .filter(a => a.closest('td, .pagination, .paginationUL, [class*="page"]'))
          .map(a => ({ text: a.innerText?.trim(), href: a.href }))
      ).catch(() => []);

      if (paginationLinks.length > 0) {
        logger.info(`[CPPP] Pagination links found: ${JSON.stringify(paginationLinks.slice(0, 10))}`);
      }

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
