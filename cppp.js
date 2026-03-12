require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const BASE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndTendersByOrganisation';
const PORTAL   = 'cppp';

const SEL = {
  tableRows:    'table.list_table tbody tr, table tbody tr',
  nextPage:     '.pagination a[rel="next"], a:has-text("Next >"), a[rel="next"]',
  captchaImg:   '#captchaImage, img[src*="captcha"]',
  captchaInput: '#captchaText, input[name="captcha"]',
  captchaSubmit:'#submitCaptcha, button[type="submit"], input[type="submit"]',
};

// ── Validation helpers ────────────────────────────────────────────────────────

const JUNK_PATTERNS = [
  /^function\s/i, /^<[a-z]/i, /window\./i, /document\./i,
  /javascript/i, /screen\s*reader/i, /visitor\s*no/i,
  /designed.*developed/i, /national informatics/i,
  /help for contractors/i, /certifying agency/i,
  /advanced search/i, /mis reports/i, /online bidder/i,
  /welcome to eprocurement/i, /updates every 15/i,
  /search\s*\|/i, /active tenders/i, /portal policies/i,
];

const SKIP_TITLES = new Set([
  'tender title', 'reference no', 'closing date', 'bid opening date',
  'screen reader access', 'certifying agency', 'advanced search',
  'mis reports', 'help for contractors', 'corrigendum title',
  'latest tenders', 'latest corrigendum', 'more...', 'visitor no',
]);

const REF_NO_PATTERN = /[A-Z0-9].{2,}[\/\-].{1,}[A-Z0-9]/i;

function isJunk(text) {
  if (!text || text.trim().length === 0) return true;
  if (text.length > 300) return true;
  for (const pat of JUNK_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

function isValidTender(title, refNo, closingDate) {
  if (!title || isJunk(title)) return false;
  if (SKIP_TITLES.has(title.toLowerCase().trim())) return false;
  const hasRef   = refNo && REF_NO_PATTERN.test(refNo);
  const hasDate  = !!closingDate && closingDate.match(/\d{1,2}[-\/]\w{3}[-\/]\d{4}/);
  return !!(hasRef || hasDate);
}

function parseDate(raw) {
  if (!raw) return null;
  const match = raw.match(/(\d{1,2})[-\s](\w{3})[-\s](\d{4})/);
  if (!match) return null;
  const d = new Date(`${match[1]} ${match[2]} ${match[3]}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function makeTenderId(refNo, title) {
  const base = (refNo && REF_NO_PATTERN.test(refNo))
    ? refNo.replace(/\s+/g, '')
    : title.replace(/\s+/g, '').substring(0, 80);
  return `CPPP-${base}`.substring(0, 200);
}

// ── Scraper ───────────────────────────────────────────────────────────────────

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
          logger.warn(`No rows found at page ${pageNum} — stopping`);
          break;
        }

        const tenders = await this._scrapePage();
        logger.info(`📦 Page ${pageNum} — ${tenders.length} valid tenders`);

        if (tenders.length === 0 && pageNum > 1) break;

        if (tenders.length > 0) {
          await upsertTenders(tenders);
          totalScraped += tenders.length;
        }

        const hasNext = await this._goToNextPage();
        if (!hasNext) break;

        pageNum++;
        await this.randomDelay();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ CPPP done. ${totalScraped} valid tenders in ${duration}s`);
      await logScraperRun({ portal: PORTAL, status: 'success', count: totalScraped });

    } catch (err) {
      logger.error(`💥 CPPP failed: ${err.message}`, { portal: PORTAL });
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
      logger.warn('🔒 CAPTCHA detected — solving...');
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
          logger.warn(`Row extract failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Page scrape error: ${err.message}`);
    }
    return tenders;
  }

  async _extractRow(row) {
    const cells = await row.$$('td');
    if (cells.length < 3) return null;

    const getText = async (el) => {
      try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
      catch { return ''; }
    };

    // Strip leading row number like "1. ", "12. " from title
    const stripRowNum = (s) => s.replace(/^\d+\.\s*/, '').trim();

    const rawTitle   = cells[0] ? await getText(cells[0]) : '';
    const title      = stripRowNum(rawTitle);
    const refNo      = cells[1] ? await getText(cells[1]) : '';
    const closingRaw = cells[2] ? await getText(cells[2]) : '';

    if (!isValidTender(title, refNo, closingRaw)) return null;

    let detailUrl = '';
    try {
      const a = await row.$('a[href]');
      if (a) {
        const href = await a.getAttribute('href');
        detailUrl = href?.startsWith('http') ? href : `https://eprocure.gov.in${href}`;
      }
    } catch {}

    return {
      tender_id:    makeTenderId(refNo, title),
      title:        title.substring(0, 500),
      organization: 'Central Government',
      portal:       PORTAL,
      bid_end_date: parseDate(closingRaw),
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
  new CpppScraper().run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = CpppScraper;
