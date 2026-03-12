require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger                           = require('./logger');

const HOME_URL = 'https://tntenders.gov.in/nicgep/app';
const PORTAL   = 'tn';

const SEL = {
  tendersByDate: 'a:has-text("Tenders by Closing Date")',
  tableRows:     'table tbody tr',
  captcha:       '#captchaImage, img[src*="captcha"]',
  tabToday:      'a:has-text("Closing Today")',
  tab7days:      'a:has-text("Closing within 7 days")',
  tab14days:     'a:has-text("Closing within 14 days")',
};

// FIX 1: Relaxed pattern — allows spaces and dots (handles "B1/2025 Dated 6.3.2026")
const REF_NO_PATTERN = /[A-Z0-9][A-Z0-9\/\-\.\s]{1,}[0-9]/i;

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

// FIX 2: Smart title/ref swap detection
// If first bracket is short (<40 chars) → it's the ref; long text → it's the title
function parseTitleCell(titleCell) {
  const bracketContents = [...titleCell.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  const beforeBracket   = titleCell.split('[')[0].trim();

  let title = '';
  let refNo = '';

  if (bracketContents.length === 0) {
    title = cleanTitle(titleCell);
    refNo = '';
  } else if (bracketContents.length === 1) {
    // Only one bracket — decide if it's ref or title
    if (bracketContents[0].length < 40 && REF_NO_PATTERN.test(bracketContents[0])) {
      refNo = bracketContents[0];
      title = cleanTitle(beforeBracket || bracketContents[0]);
    } else {
      title = cleanTitle(bracketContents[0]);
      refNo = '';
    }
  } else {
    // Multiple brackets — short one is ref, long one is title
    const shortBracket = bracketContents.find(b => b.length < 40 && REF_NO_PATTERN.test(b));
    const longBracket  = bracketContents.find(b => b.length >= 15);

    if (shortBracket && longBracket && shortBracket !== longBracket) {
      refNo = shortBracket;
      title = cleanTitle(longBracket);
    } else if (shortBracket) {
      refNo = shortBracket;
      title = cleanTitle(beforeBracket || longBracket || bracketContents[0]);
    } else {
      title = cleanTitle(beforeBracket || bracketContents[0]);
      refNo = bracketContents[0];
    }
  }

  // Final fallback: title from beforeBracket text if still empty
  if (!title && beforeBracket.length > 5) title = cleanTitle(beforeBracket);

  return { title, refNo };
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
      await this.page.waitForTimeout(2000);
      logger.info(`[TN] URL: ${this.page.url()}`);

      const captchaEl = await this.page.$(SEL.captcha).catch(() => null);
      if (captchaEl) throw new Error('Captcha wall on Tenders by Closing Date page');

      // Log visible links for debug
      const links = await this.page.$$eval('a', els => els.map(e => e.innerText?.trim()).filter(Boolean)).catch(() => []);
      logger.info(`[TN] Links on page: ${JSON.stringify(links.slice(0, 40))}`);

      const tabs = [
        { label: 'Closing within 14 days', selector: SEL.tab14days },
        { label: 'Closing within 7 days',  selector: SEL.tab7days },
        { label: 'Closing Today',          selector: SEL.tabToday },
      ];

      for (const { label, selector } of tabs) {
        try {
          const tabEl = await this.page.$(selector);
          if (!tabEl) { logger.warn(`[TN] Tab not found: ${label}`); continue; }

          await tabEl.click();
          await this.page.waitForTimeout(3000);
          logger.info(`[TN] Clicked tab "${label}" via: ${selector}`);
        } catch (err) {
          logger.warn(`[TN] Tab click failed "${label}": ${err.message}`);
          continue;
        }

        let pageNum = 1;
        while (true) {
          const tenders = await this._scrapePage();
          const newTenders = tenders.filter(t => !seenIds.has(t.tender_id));
          newTenders.forEach(t => seenIds.add(t.tender_id));

          logger.info(`[TN] "${label}" page ${pageNum} — ${tenders.length} found, ${newTenders.length} new`);

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

  // FIX 3: Giant row parser — TN dumps all tenders in one huge <tr> with N×6 cells
  async _scrapePage() {
    const tenders = [];
    const rows = await this.page.$$(SEL.tableRows).catch(() => []);

    for (const row of rows) {
      try {
        const cells = await row.$$('td');

        // FIX 3a: Detect the giant data row (12+ cells containing header keywords)
        if (cells.length >= 12) {
          const getText = async (el) => {
            try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
            catch { return ''; }
          };

          const allCells = await Promise.all(cells.map(getText));

          // Find where the header row starts (look for "S.No" or "e-Published")
          let dataStart = -1;
          for (let i = 0; i < allCells.length - 5; i++) {
            const v = allCells[i].toLowerCase();
            if (v === 's.no' || v === 'sno' || v === 'sl.no') {
              dataStart = i + 6; // skip 6 header cells
              break;
            }
          }

          if (dataStart === -1) {
            // No header found — try parsing from start in chunks of 6
            dataStart = 0;
          }

          logger.info(`[TN] Found data row with ${allCells.length} cells, data starts at index ${dataStart}`);

          // Collect <a href> links from title cells (every 5th cell after dataStart)
          const anchorHrefs = await row.$$eval('a[href]', els =>
            els.map(a => a.getAttribute('href')).filter(Boolean)
          ).catch(() => []);

          let linkIdx = 0;
          for (let i = dataStart; i + 5 < allCells.length; i += 6) {
            const sno     = allCells[i];
            const pub     = allCells[i + 1];
            const closing = allCells[i + 2];
            const opening = allCells[i + 3];
            const titleCell = allCells[i + 4];
            const org     = allCells[i + 5];

            // Stop on non-numeric S.No (footer junk)
            if (sno && !/^\d+\.?$/.test(sno.trim())) break;

            const { title, refNo } = parseTitleCell(titleCell);
            const orgClean = (org || 'Tamil Nadu Government')
              .split('||')
              .map(s => s.trim())
              .filter(Boolean)
              .pop() || 'Tamil Nadu Government';

            if (!isValidTender(title, refNo)) {
              logger.warn(`[TN] Skipped: title="${title?.substring(0, 50)}" ref="${refNo?.substring(0, 50)}"`);
              linkIdx++;
              continue;
            }

            // FIX 4: Get detail URL from anchor list
            let detailUrl = '';
            const rawHref = anchorHrefs[linkIdx] || '';
            if (rawHref) {
              detailUrl = rawHref.startsWith('http')
                ? rawHref
                : `https://tntenders.gov.in${rawHref}`;
            }
            linkIdx++;

            tenders.push({
              tender_id:    makeTenderId(refNo, title),
              title:        title.substring(0, 500),
              organization: orgClean.substring(0, 200),
              portal:       PORTAL,
              bid_end_date: parseDate(closing),
              url:          (detailUrl || HOME_URL).substring(0, 1000),
              scraped_at:   new Date().toISOString(),
            });
          }

          continue; // skip the regular row extractor for this giant row
        }

        // Normal row (< 12 cells) — original logic
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

    if (allCells.length >= 5) {
      const { title, refNo } = parseTitleCell(allCells[4] || '');
      const org     = allCells[5] || 'Tamil Nadu Government';
      const closing = allCells[2] || '';
      const orgClean = org.split('||').map(s => s.trim()).filter(Boolean).pop() || 'Tamil Nadu Government';

      if (!isValidTender(title, refNo)) return null;

      let detailUrl = '';
      try {
        const a = await row.$('td:nth-child(5) a[href]');
        if (a) {
          const href = await a.getAttribute('href');
          detailUrl = href?.startsWith('http') ? href : `https://tntenders.gov.in${href}`;
        }
      } catch {}

      return {
        tender_id:    makeTenderId(refNo, title),
        title:        title.substring(0, 500),
        organization: orgClean.substring(0, 200),
        portal:       PORTAL,
        bid_end_date: parseDate(closing),
        url:          (detailUrl || HOME_URL).substring(0, 1000),
        scraped_at:   new Date().toISOString(),
      };
    }

    // Fallback: 4-column
    const { title, refNo } = parseTitleCell(allCells[0].replace(/^\d+\.\s*/, '').trim());
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

  // FIX 5: TN pagination uses single ">" character, not "Next" text
  async _goToNextPage() {
    try {
      // Find all pagination links and look for the exact single ">" character
      const nextEl = await this.page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.find(a => a.innerText?.trim() === '>') || null;
      });

      if (!nextEl || nextEl.toString() === 'JSHandle:null') return false;

      await nextEl.click();
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.page.waitForTimeout(1500);
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
