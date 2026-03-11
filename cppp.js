require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndTendersByOrganisation';

const SEL = {
  tableRows:    'table.list_table tbody tr, tbody tr, table tbody tr',
  tenderTable:  '.tender-table, table.list_table, table tbody',
  tenderId:     'td:nth-child(1)',
  title:        'td:nth-child(2)',
  org:          'td:nth-child(3)',
  closingDate:  'td:nth-child(4)',
  detailLink:   'a[href*="eprocure"]',
  nextPage:     '.pagination a[rel="next"], a:has-text("Next"), a[rel="next"]',
  captchaImg:   '#captchaImage, img[src*="captcha"]',
  captchaInput: '#captchaText, input[name="captcha"]',
  captchaSubmit:'#submitCaptcha, button[type="submit"], input[type="submit"]',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function safeTenderId(prefix, raw) {
  const cleaned = `${prefix}-${raw}`.replace(/\s+/g, '');
  return cleaned.substring(0, 200);
}

// ── CpppScraper ───────────────────────────────────────────────────────────────

class CpppScraper extends BaseScraper {
  constructor() {
    super('cppp');
  }

  async run() {
    const startTime = Date.now();
    logger.info('🚀 Starting scraper on CPPP');

    let totalScraped = 0;
    let pageNum      = 1;

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
        logger.info(`📦 Page ${pageNum} — ${tenders.length} tenders scraped`);

        if (tenders.length === 0) {
          logger.info('No more tenders found — stopping');
          break;
        }

        await upsertTenders(tenders);
        totalScraped += tenders.length;

        const hasNext = await this._goToNextPage();
        if (!hasNext) {
          logger.info(`No more pages after page ${pageNum}`);
          break;
        }

        pageNum++;
        await this.randomDelay();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ CPPP done. Total: ${totalScraped} tenders scraped`);

      await logScraperRun({ portal: 'cppp', status: 'success', count: totalScraped });

    } catch (err) {
      logger.error(`💥 CPPP scraper failed — e error: ${err.message}`, { portal: 'cppp' });
      await logScraperRun({ portal: 'cppp', status: 'error', count: totalScraped, message: err.message }).catch(() => {});
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  async _handleCaptchaIfPresent() {
    try {
      const visible = await this.page.isVisible(SEL.captchaImg, { timeout: 3000 });
      if (!visible) return;
      logger.warn('🔒 CAPTCHA detected on CPPP — attempting to solve CAPTCHA...');
      await this.solveCaptcha(this.page);
    } catch {
      // no captcha or detection failed — continue
    }
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
      tender_id:     safeTenderId('CPPP', rawId),
      title:         rawTitle,
      organization:  rawOrg || 'N/A',
      portal:        'cppp',
      bid_end_date:  parseDate(rawDate),
      url:           detailUrl || BASE_URL,
      scraped_at:    new Date().toISOString(),
    };
  }

  async _goToNextPage() {
    try {
      const next = await this.page.$(SEL.nextPage);
      if (!next) return false;
      await next.click();
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  }
}

if (require.main === module) {
  const scraper = new CpppScraper();
  scraper.run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = CpppScraper;
