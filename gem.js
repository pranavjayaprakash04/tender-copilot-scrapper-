require('dotenv').config();

const BaseScraper         = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger              = require('./logger');

// ── Selectors ────────────────────────────────────────────────────────────────

const SELECTORS = {
  // Tender list rows
  tenderRows:   'tbody tr',
  tenderList:   '.bid-list, .bid-list-item, table tbody tr',

  // Individual tender fields
  tenderId:     'td:nth-child(1), [data-field="tender_id"]',
  title:        'td:nth-child(2), h.bid-title, .tender-row .bid-value',
  org:          'td:nth-child(3), .org-name',
  bidEndDate:   '.bid-end-date, td:nth-child(4), [data-date]',
  estimatedVal: '.estimated-date, td:nth-child(2)',
  detailLink:   'a[href*="bid"], a[href*="biddetail"]',

  // Pagination
  nextPage:     '.pagination .next, li.next a, a:has-text("Next"), [rel="Next"], button[aria-label="Next"]',

  // CAPTCHA
  captchaImg:   'img[src*="captcha-img"], img[src*="captcha"], .captcha-image, .cap-mage',
  captchaInput: 'input[name="captchaInput"], input[type="text"][name*="captcha"]',
  captchaSubmit: 'input[type="submit"], button[type="submit"]',
};

const BASE_URL = 'https://bidplus.gem.gov.in/bidlists';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── GemScraper ────────────────────────────────────────────────────────────────

class GemScraper extends BaseScraper {
  constructor() {
    super('gem');
  }

  async run() {
    const startTime = Date.now();
    logger.info('🚀 Starting scraper on GeM');

    let totalScraped = 0;
    let pageNum      = 1;

    try {
      await this.launchBrowser();

      const reached = await this.navigateTo(BASE_URL);
      if (!reached) throw new Error('Failed to load GeM bid list page');

      while (true) {
        logger.info(`📄 Scraping page ${pageNum}`);

        // Handle CAPTCHA if present
        const hasCaptcha = await this._handleCaptchaIfPresent();
        if (!hasCaptcha) {
          logger.warn('CAPTCHA detected on GeM — attempting solve');
        }

        // Wait for tender rows to appear
        try {
          await this.page.waitForSelector(SELECTORS.tenderRows, { timeout: 15000, state: 'attached' });
        } catch {
          logger.warn(`No tender rows found at page ${pageNum} — stopping`);
          break;
        }

        // Extract tenders from current page
        const tenders = await this._extractTenders();
        logger.info(`  Found ${tenders.length} tenders scraped on page ${pageNum}`);

        if (tenders.length === 0) {
          logger.info('No more tenders found — stopping');
          break;
        }

        // Save to Supabase
        if (tenders.length > 0) {
          await upsertTenders(tenders);
          totalScraped += tenders.length;
        }

        // Go to next page
        const hasNext = await this._goToNextPage();
        if (!hasNext) {
          logger.info(`No more pages after page ${pageNum}`);
          break;
        }

        pageNum++;
        await this.randomDelay();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ GeM scraper done. Total: ${totalScraped} tenders scraped (${duration}s)`);

      await logScraperRun({
        portal:    'gem',
        status:    'success',
        count:     totalScraped,
        duration_s: parseFloat(duration),
      });

    } catch (err) {
      logger.error(`Scraper failed — error: ${err.message}`, { portal: 'gem' });

      await logScraperRun({
        portal:  'gem',
        status:  'error',
        count:   totalScraped,
        message: err.message,
      }).catch(() => {});

      process.exit(1);

    } finally {
      await this.cleanup();
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  async _handleCaptchaIfPresent() {
    try {
      const captchaVisible = await this.page.isVisible(SELECTORS.captchaImg, { timeout: 3000 });
      if (!captchaVisible) return true; // no captcha

      logger.warn('🔒 CAPTCHA detected on GeM — attempting to solve CAPTCHA');
      await this.solveCaptcha(this.page);
      return false;
    } catch {
      return true; // assume no captcha if detection fails
    }
  }

  async _extractTenders() {
    const tenders = [];

    try {
      const rows = await this.page.$$(SELECTORS.tenderRows);

      for (const row of rows) {
        try {
          const tender = await this._extractTenderData(row);
          if (tender) tenders.push(tender);
        } catch (err) {
          logger.warn(`Failed to extract row: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`extractTenders error: ${err.message}`);
    }

    return tenders;
  }

  async _extractTenderData(row) {
    const cells = await row.$$('td');
    if (cells.length < 2) return null;

    const getText = async (el) => {
      try { return (await el.textContent())?.trim() ?? ''; }
      catch { return ''; }
    };

    const rawId      = cells[0] ? await getText(cells[0]) : '';
    const rawTitle   = cells[1] ? await getText(cells[1]) : '';
    const rawOrg     = cells[2] ? await getText(cells[2]) : '';
    const rawEndDate = cells[3] ? await getText(cells[3]) : '';
    const rawVal     = cells[4] ? await getText(cells[4]) : '';

    // Get detail link
    let detailUrl = '';
    try {
      const link = await row.$('a[href*="bid"], a[href*="biddetail"]');
      if (link) {
        const href = await link.getAttribute('href');
        detailUrl = href?.startsWith('http') ? href : `https://bidplus.gem.gov.in${href}`;
      }
    } catch {}

    if (!rawTitle && !rawId) return null;

    return {
      tender_id:       `GEM-${rawId}`.replace(/\s+/g, ''),
      title:           rawTitle,
      organization:    rawOrg,
      portal:          'gem',
      bid_end_date:    parseDate(rawEndDate),
      estimated_value: rawVal || null,
      url:             detailUrl || BASE_URL,
      scraped_at:      new Date().toISOString(),
    };
  }

  async _goToNextPage() {
    try {
      const nextBtn = await this.page.$(SELECTORS.nextPage);
      if (!nextBtn) return false;

      const isDisabled = await nextBtn.getAttribute('class');
      if (isDisabled?.includes('active') || isDisabled?.includes('disabled')) return false;

      await nextBtn.click();
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const scraper = new GemScraper();
  scraper.run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = GemScraper;
