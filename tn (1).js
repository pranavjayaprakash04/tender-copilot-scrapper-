require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const BASE_URL = 'https://tntenders.gov.in/nicgep/app';

const SEL = {
  tableRows:     'table tbody tr, table.list_table tbody tr',
  nextPage:      '.next-page a, a:has-text("Next"), button[value="Next >"], input[value="Next >"]',
  captchaImg:    '#captchaImage, img[src*="captcha"], .captchaImgDiv',
  captchaInput:  'input[name="captcha"], #captchaText',
  captchaSubmit: 'input[type="submit"], button[type="submit"]',
};

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw.trim().replace(/\s+/g, ' '));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function makeTenderId(raw) {
  const token = String(raw).replace(/\s+/g, '').substring(0, 100);
  return `TN-${token}` || null;
}

class TnScraper extends BaseScraper {
  constructor() { super('tn'); }

  async run() {
    const startTime = Date.now();
    logger.info('🚀 Starting scraper on TN Tenders');
    let totalScraped = 0;
    let pageNum = 1;

    try {
      await this.launchBrowser();
      const ok = await this.navigateTo(BASE_URL);
      if (!ok) throw new Error('Failed to load TN Tenders page');

      while (true) {
        logger.info(`📄 Scraping TN page ${pageNum}`);
        await this._handleCaptchaIfPresent();

        try {
          await this.page.waitForSelector(SEL.tableRows, { timeout: 15000, state: 'attached' });
        } catch {
          logger.warn(`No tender rows found at TN page ${pageNum} — stopping`);
          break;
        }

        const tenders = await this._scrapePage();
        logger.info(` TN page ${pageNum} — ${tenders.length} tenders scraped`);

        if (tenders.length === 0) break;

        await upsertTenders(tenders);
        totalScraped += tenders.length;

        const hasNext = await this._goToNextPage();
        if (!hasNext) break;

        pageNum++;
        await this.randomDelay();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ TN Tenders done. Total: ${totalScraped} tenders scraped in ${duration}s`);
      await logScraperRun({ portal: 'tn', status: 'success', count: totalScraped, duration_s: parseFloat(duration) });

    } catch (err) {
      logger.error(`💥 TN Tenders scraper failed: ${err.message}`, { portal: 'tn' });
      await logScraperRun({ portal: 'tn', status: 'error', count: totalScraped, message: err.message }).catch(() => {});
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  async _handleCaptchaIfPresent() {
    try {
      const visible = await this.page.isVisible(SEL.captchaImg, { timeout: 3000 });
      if (!visible) return;
      logger.warn('🔒 CAPTCHA detected on TN — attempting to solve CAPTCHA');
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
          logger.warn(`TN row extract failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`TN page error: ${err.message}`);
    }
    return tenders;
  }

  async _extractRow(row) {
    const cells = await row.$$('td');
    if (cells.length < 2) return null;

    const t = async (el) => { try { return (await el.textContent())?.trim() ?? ''; } catch { return ''; } };

    const rawId    = cells[0] ? await t(cells[0]) : '';
    const rawTitle = cells[1] ? await t(cells[1]) : '';
    const rawOrg   = cells[2] ? await t(cells[2]) : 'Tamil Nadu Government';
    const rawDate  = cells[3] ? await t(cells[3]) : '';

    if (!rawTitle && !rawId) return null;

    let detailUrl = '';
    try {
      const a = await row.$('a[href]');
      if (a) {
        const href = await a.getAttribute('href');
        detailUrl = href?.startsWith('http') ? href : `https://tntenders.gov.in${href}`;
      }
    } catch {}

    return {
      tender_id:    makeTenderId(rawId),
      title:        rawTitle.substring(0, 1000),
      organization: (rawOrg || 'N/A').substring(0, 500),
      portal:       'tn',
      bid_end_date: parseDate(rawDate),
      url:          (detailUrl || BASE_URL).substring(0, 1000),
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
