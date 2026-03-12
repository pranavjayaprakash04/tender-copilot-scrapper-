require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const HOME_URL = 'https://tntenders.gov.in/nicgep/app';
const PORTAL   = 'tn';

const SEL = {
  tendersByDate: 'a:has-text("Tenders by Closing Date")',
  tableRows:     'table tbody tr',
  nextPage:      'a:has-text("Next"), input[value*="Next"], a:has-text(">")',
  captcha:       '#captchaImage, img[src*="captcha"]',
};

const REF_NO_PATTERN = /[A-Z0-9][A-Z0-9\/\-\.\s]{1,}[0-9]/i;

const JUNK_PATTERNS = [
  /^function\s/i, /^<[a-z]/i, /window\./i, /document\./i,
  /javascript/i, /screen\s*reader/i, /visitor\s*no/i,
  /designed.*developed/i, /national informatics/i,
  /advanced search/i, /mis reports/i, /search\s*\|/i,
  /eprocurement system/i, /enter captcha/i, /provide captcha/i,
  /no tenders found/i, /tenders\/auctions/i, /search by/i,
  /closing today/i, /closing within/i, /closing by date/i,
  /version\s*:/i, /portal policies/i, /contents owned/i,
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

// Parse a title cell like "[ Construction of Room ] [A3/2972/2025] [2026_RDTN_1]"
// Returns { title, refNo }
function parseTitleCell(raw) {
  if (!raw) return { title: '', refNo: '' };

  // Extract all bracket contents
  const brackets = [...raw.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim());
  const beforeFirst = raw.split('[')[0].trim();

  let title = '';
  let refNo = '';

  if (brackets.length >= 2) {
    // Format: "[ Title text ] [RefNo] [SystemID]"
    // OR: "[Title text [RefNo] [SystemID]]" 
    // First bracket might be the title, second the ref
    const first = brackets[0];
    const second = brackets[1];

    if (REF_NO_PATTERN.test(first)) {
      // First bracket is ref number
      refNo = first;
      title = beforeFirst || second;
    } else if (REF_NO_PATTERN.test(second)) {
      // Second bracket is ref number, first is title
      title = cleanTitle(first);
      refNo = second;
    } else {
      title = cleanTitle(first);
      refNo = second;
    }
  } else if (brackets.length === 1) {
    const content = brackets[0];
    if (REF_NO_PATTERN.test(content)) {
      refNo = content;
      title = cleanTitle(beforeFirst);
    } else {
      title = cleanTitle(content);
    }
  } else {
    title = cleanTitle(raw);
  }

  return { title: cleanTitle(title), refNo };
}

async function clickTabByText(page, text) {
  const selectors = [
    `a:has-text("${text}")`,
    `td:has-text("${text}")`,
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

      logger.info('[TN] Loading homepage...');
      const ok = await this.navigateTo(HOME_URL);
      if (!ok) throw new Error('Failed to load TN homepage');
      await this.page.waitForTimeout(2000);

      logger.info('[TN] Navigating to Tenders by Closing Date...');
      await this.page.click(SEL.tendersByDate);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.page.waitForTimeout(3000);
      logger.info(`[TN] URL: ${this.page.url()}`);

      const captchaEl = await this.page.$(SEL.captcha).catch(() => null);
      if (captchaEl) throw new Error('Captcha wall detected');

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

    // The TN portal renders ALL tenders into one giant <tr> with N*6 cells
    // Strategy: find the row with the most cells that contains "e-Published Date"
    // and parse it in chunks of 6
    const rows = await this.page.$$(SEL.tableRows).catch(() => []);

    for (const row of rows) {
      const cells = await row.$$('td').catch(() => []);
      if (cells.length < 12) continue; // Need at least 2 tenders worth of cells

      const getText = async (el) => {
        try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
        catch { return ''; }
      };

      const allCells = await Promise.all(cells.map(getText));

      // Find where the header row starts: look for "S.No" followed by "e-Published Date"
      let dataStart = -1;
      for (let i = 0; i < allCells.length - 6; i++) {
        if (/^s\.?no$/i.test(allCells[i]) && /e.published/i.test(allCells[i+1])) {
          dataStart = i + 6; // skip the 6 header cells
          break;
        }
      }

      if (dataStart === -1) continue;

      logger.info(`[TN] Found data row with ${cells.length} cells, data starts at index ${dataStart}`);

      // Parse in chunks of 6: [S.No, e-Published, Bid Closing, Opening, Title+Ref, Org]
      for (let i = dataStart; i + 5 < allCells.length; i += 6) {
        const sno       = allCells[i];
        const published = allCells[i + 1];
        const closing   = allCells[i + 2];
        const opening   = allCells[i + 3];
        const titleCell = allCells[i + 4];
        const orgChain  = allCells[i + 5];

        // Stop if we hit footer junk
        if (!sno || !/^\d/.test(sno)) break;
        if (isJunk(titleCell)) break;

        const { title, refNo } = parseTitleCell(titleCell);
        const orgParts = orgChain.split('||').map(s => s.trim()).filter(Boolean);
        const org = orgParts[orgParts.length - 1] || orgParts[0] || 'Tamil Nadu Government';

        if (!isValidTender(title, refNo)) {
          logger.warn(`[TN] Skipped: title="${title.substring(0,50)}" ref="${refNo}"`);
          continue;
        }

        // Get detail URL from the link in the title cell
        // We need to find the <a> element at position i+4 in the cells array
        let detailUrl = '';
        try {
          const titleEl = cells[i + 4];
          const a = await titleEl.$('a[href]');
          if (a) {
            const href = await a.getAttribute('href');
            detailUrl = href?.startsWith('http') ? href : `https://tntenders.gov.in${href}`;
          }
        } catch {}

        tenders.push({
          tender_id:    makeTenderId(refNo, title),
          title:        title.substring(0, 500),
          organization: org.substring(0, 200),
          portal:       PORTAL,
          bid_end_date: parseDate(closing),
          url:          (detailUrl || HOME_URL).substring(0, 1000),
          scraped_at:   new Date().toISOString(),
        });
      }

      // Only parse the first matching big row per page
      if (tenders.length > 0) break;
    }

    return tenders;
  }

  async _goToNextPage() {
    try {
      // TN pagination uses plain <a> links: "2","3",">",">>","<<"
      // Find the ">" link that is NOT ">>" 
      const links = await this.page.$$('a').catch(() => []);
      for (const link of links) {
        const text = ((await link.textContent()) ?? '').trim();
        if (text === '>') {
          const cls = (await link.getAttribute('class') ?? '').toLowerCase();
          if (cls.includes('disabled') || cls.includes('grey')) return false;
          await link.click();
          await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          await this.page.waitForTimeout(1000);
          return true;
        }
      }
      return false;
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
