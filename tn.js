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
};

const REF_NO_PATTERN = /[A-Z0-9].{2,}[\/\-].{1,}[A-Z0-9]/i;

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
  // "12-Mar-2026 09:00 AM"
  const m1 = raw.match(/(\d{1,2})[-\s\/](\w{3})[-\s\/](\d{4})/);
  if (m1) { const d = new Date(`${m1[1]} ${m1[2]} ${m1[3]}`); if (!isNaN(d.getTime())) return d.toISOString(); }
  // "12/03/2026"
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

async function clickTabByText(page, text) {
  const selectors = [
    `a:has-text("${text}")`,
    `td:has-text("${text}")`,
    `span:has-text("${text}")`,
    `input[value="${text}"]`,
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(3000);
        logger.info(`[TN] Clicked tab "${text}" via: ${sel}`);
        return true;
      }
    } catch {}
  }
  logger.warn(`[TN] Tab not found: "${text}"`);
  return false;
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

      // 1. Load homepage to establish session
      logger.info('[TN] Loading homepage...');
      const ok = await this.navigateTo(HOME_URL);
      if (!ok) throw new Error('Failed to load TN homepage');
      await this.page.waitForTimeout(2000);

      // 2. Click "Tenders by Closing Date" in left nav
      logger.info('[TN] Navigating to Tenders by Closing Date...');
      await this.page.click(SEL.tendersByDate);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.page.waitForTimeout(3000);
      logger.info(`[TN] URL: ${this.page.url()}`);

      const captchaEl = await this.page.$(SEL.captcha).catch(() => null);
      if (captchaEl) throw new Error('Captcha wall detected');

      // Log all links on page (to confirm tab structure)
      const allLinks = await this.page.$$eval('a', els =>
        els.map(e => e.textContent?.trim()).filter(t => t && t.length > 0 && t.length < 80)
      ).catch(() => []);
      logger.info(`[TN] Links on page: ${JSON.stringify(allLinks.slice(0, 40))}`);

      // 3. Scrape all 3 date tabs (skip "Closing by Date" — needs date input form)
      const tabs = [
        'Closing within 14 days',
        'Closing within 7 days',
        'Closing Today',
      ];

      for (const tabText of tabs) {
        const clicked = await clickTabByText(this.page, tabText);
        if (!clicked) continue;

        let pageNum = 1;
        while (true) {
          const tenders = await this._scrapePage();
          const newTenders = tenders.filter(t => !seenIds.has(t.tender_id));
          newTenders.forEach(t => seenIds.add(t.tender_id));

          logger.info(`[TN] "${tabText}" page ${pageNum} — ${tenders.length} found, ${newTenders.length} new`);

          if (newTenders.length > 0) {
            await upsertTenders(newTenders);
            totalScraped += newTenders.length;
          }

          if (tenders.length === 0) break;

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
    const getText = async (el) => {
      try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
      catch { return ''; }
    };

    const allCells = await Promise.all(cells.map(getText));

    // Debug: log first 5 rows with their cell count and content
    if (cells.length !== 6) {
      logger.info(`[TN] Row has ${cells.length} cells: ${JSON.stringify(allCells.map(c => c.substring(0, 40)))}`);
    }

    if (cells.length < 5) return null;

    // From screenshot — 6 columns:
    // [0] S.No
    // [1] e-Published Date
    // [2] Bid Submission Closing Date  ← bid deadline
    // [3] Tender Opening Date
    // [4] Title and Ref.No./Tender ID  ← "Title [RefNo] [SystemID]"
    // [5] Organisation Chain

    const sno       = allCells[0] || '';
    const closing   = allCells[2] || '';
    const titleCell = allCells[4] || '';
    const orgChain  = allCells[5] || 'Tamil Nadu Government';

    // Skip header rows
    if (/s\.?no/i.test(sno) || /e.published/i.test(allCells[1])) return null;

    // Parse title cell: "Title text [A3/2972/2025] [2026_RDTN_673676_1]"
    const bracketMatch = titleCell.match(/^([\s\S]*?)\[([^\]]+)\]/);
    let title = '', refNo = '';

    if (bracketMatch) {
      title = cleanTitle(bracketMatch[1].trim());
      refNo = bracketMatch[2].trim();
    } else {
      title = cleanTitle(titleCell);
      refNo = '';
    }

    // If title is empty but ref is in brackets, check second bracket for system ID and first for ref
    if (!title && refNo) {
      title = refNo;
      refNo = '';
    }

    // Organisation: last segment after "||" separators
    const orgParts = orgChain.split('||').map(s => s.trim()).filter(Boolean);
    const org = orgParts[orgParts.length - 1] || orgParts[0] || 'Tamil Nadu Government';

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
      organization: org.substring(0, 200),
      portal:       PORTAL,
      bid_end_date: parseDate(closing),
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
      await this.page.waitForTimeout(1000);
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
