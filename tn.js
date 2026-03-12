require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const HOME_URL = 'https://tntenders.gov.in/nicgep/app';
const PORTAL   = 'tn';

const SEL = {
  tendersByDate: 'a:has-text("Tenders by Closing Date")',
  tableRows:     'table tbody tr',
  nextPage:      'a:has-text("Next"), input[value*="Next"]',
  captcha:       '#captchaImage, img[src*="captcha"]',
  // Tab links on the Tenders by Date page
  tabToday:      'input[value="Closing Today"], a:has-text("Closing Today")',
  tab7days:      'input[value="Closing within 7 days"], a:has-text("Closing within 7 days")',
  tab14days:     'input[value="Closing within 14 days"], a:has-text("Closing within 14 days")',
  tabByDate:     'input[value="Closing by Date"], a:has-text("Closing by Date")',
};

const REF_NO_PATTERN = /[A-Z0-9].{2,}[\/\-].{1,}[A-Z0-9]/i;
const DATE_PATTERN   = /\d{1,2}[-\/\s](\w{3}|\d{2})[-\/\s]\d{4}/;

const JUNK_PATTERNS = [
  /^function\s/i, /^<[a-z]/i, /window\./i, /document\./i,
  /javascript/i, /screen\s*reader/i, /visitor\s*no/i,
  /designed.*developed/i, /national informatics/i,
  /advanced search/i, /mis reports/i, /search\s*\|/i,
  /eprocurement system/i, /enter captcha/i, /provide captcha/i,
  /no tenders found/i, /tenders\/auctions/i, /search by/i,
];

const SKIP_TITLES = new Set([
  'tender title', 'reference no', 'closing date', 'bid opening date',
  'e-published date', 'bid submission closing date', 'tender opening date',
  'title and ref.no./tender id', 'name of dept./orgn.', 'organisation chain',
  's.no', 'sno', 'sl.no', 'screen reader access', 'more...', 'latest tenders',
  'tenders/auctions closing today', 'search by',
]);

function isJunk(text) {
  if (!text || text.trim().length === 0) return true;
  if (text.length > 500) return true;
  return JUNK_PATTERNS.some(p => p.test(text));
}

function cleanTitle(raw) {
  // Remove wrapping brackets: "[Title text]" -> "Title text"
  return raw.replace(/^\[/, '').replace(/\]$/, '').trim();
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
    const seenIds = new Set();

    try {
      await this.launchBrowser();

      // Navigate to homepage first to establish session
      logger.info('[TN] Loading homepage...');
      const ok = await this.navigateTo(HOME_URL);
      if (!ok) throw new Error('Failed to load TN homepage');
      await this.page.waitForTimeout(2000);

      // Click "Tenders by Closing Date" to get to the tab page
      logger.info('[TN] Navigating to Tenders by Closing Date...');
      await this.page.click(SEL.tendersByDate);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.page.waitForTimeout(2000);
      logger.info(`[TN] URL: ${this.page.url()}`);

      // Check for captcha
      const captchaEl = await this.page.$(SEL.captcha).catch(() => null);
      if (captchaEl) throw new Error('Captcha wall on Tenders by Closing Date page');

      // Log what tabs are visible
      const tabTexts = await this.page.$$eval('input[type="button"], input[type="submit"]', 
        els => els.map(e => e.value)).catch(() => []);
      logger.info(`[TN] Tab buttons found: ${JSON.stringify(tabTexts)}`);

      // Scrape each tab by clicking and waiting for table refresh
      const tabs = [
        { label: 'Closing within 14 days', selector: SEL.tab14days },
        { label: 'Closing within 7 days',  selector: SEL.tab7days },
        { label: 'Closing Today',          selector: SEL.tabToday },
      ];

      for (const { label, selector } of tabs) {
        logger.info(`[TN] Clicking tab: ${label}`);
        try {
          const tabEl = await this.page.$(selector);
          if (!tabEl) {
            logger.warn(`[TN] Tab not found: ${label}`);
            continue;
          }
          await tabEl.click();
          await this.page.waitForTimeout(3000); // wait for table to reload
          await this.page.waitForSelector(SEL.tableRows, { timeout: 10000 });
        } catch (err) {
          logger.warn(`[TN] Tab click failed "${label}": ${err.message}`);
          continue;
        }

        // Log first row to verify tab switched
        const sample = await this.page.$eval('table tbody tr:first-child', 
          el => el.innerText?.substring(0, 150)).catch(() => '');
        logger.info(`[TN] ${label} sample row: ${sample}`);

        let pageNum = 1;
        while (true) {
          const tenders = await this._scrapePage();
          const newTenders = tenders.filter(t => !seenIds.has(t.tender_id));
          newTenders.forEach(t => seenIds.add(t.tender_id));

          logger.info(`[TN] ${label} page ${pageNum} — ${tenders.length} found, ${newTenders.length} new`);

          if (newTenders.length > 0) {
            await upsertTenders(newTenders);
            totalScraped += newTenders.length;
          }

          if (tenders.length === 0 && pageNum > 1) break;

          const hasNext = await this._goToNextPage();
          if (!hasNext) break;
          pageNum++;
          await this.randomDelay();
        }
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
    // [0] S.No | [1] e-Published | [2] Bid Closing | [3] Opening | [4] Title+RefNo+ID | [5] Organisation
    if (allCells.length >= 5) {
      const titleCell = allCells[4] || '';
      const org       = allCells[5] || 'Tamil Nadu Government';
      const closing   = allCells[2] || '';

      // Title cell format: "Title text [RefNo/2026] [2026_XXXX_1]"
      // Extract title (before first bracket) and refNo (inside first bracket)
      const beforeBracket = titleCell.split('[')[0].trim();
      const bracketContents = [...titleCell.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);

      const title = cleanTitle(beforeBracket || titleCell);
      // First bracket is usually the ref number, second is the tender system ID
      const refNo = bracketContents[0] || '';
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

    // Fallback: 4-column layout
    const title      = cleanTitle(allCells[0].replace(/^\d+\.\s*/, '').trim());
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
