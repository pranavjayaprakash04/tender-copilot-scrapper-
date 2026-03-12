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

// ─── Estimated value helpers ─────────────────────────────────────

const VALUE_KEYWORDS = [
  'tender value in',
  'estimated value', 'estimated cost', 'tender value',
  'contract value', 'approximate value', 'tender amount',
  'work value', 'nit value',
];

function parseAmount(text) {
  if (!text) return null;
  if (/^na$/i.test(text.trim())) return null;
  text = text.replace(/Rs\.?/gi, '').replace(/₹/g, '').replace(/\/-/g, '').trim();
  const crore = text.match(/([\d,.]+)\s*(?:crore|crores|cr\.?)\b/i);
  if (crore) return parseFloat(crore[1].replace(/,/g, '')) * 10_000_000;
  const lakh = text.match(/([\d,.]+)\s*(?:lakh|lakhs|lac|lacs)\b/i);
  if (lakh) return parseFloat(lakh[1].replace(/,/g, '')) * 100_000;
  const plain = text.replace(/,/g, '').match(/[\d.]+/);
  if (plain) { const v = parseFloat(plain[0]); return isNaN(v) ? null : v; }
  return null;
}

async function extractDetailPageData(page, url, baseUrl) {
  if (!url || url === baseUrl) return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  if (!url.includes('DirectLink')) return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  if (url.includes('gepnicreports')) return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  try {
    logger.info('[TN] Visiting detail page: ' + url.substring(0, 80));
    const detailPage = await page.context().newPage();
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await detailPage.waitForTimeout(800);

    const result = await detailPage.evaluate((keywords) => {
      let estimatedValue = null;
      let category = null;
      let location = null;
      let emdAmount = null;

      // ── Scrape ALL table key-value pairs into details object ──
      const details = {};
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length < 2) continue;

        // Handle both 2-col and 4-col rows
        const pairs = [];
        for (let i = 0; i + 1 < cells.length; i += 2) {
          const label = cells[i].innerText?.trim().replace(/\s+/g, ' ') || '';
          const val   = cells[i + 1].innerText?.trim().replace(/\s+/g, ' ') || '';
          if (label && val && label.length < 80) pairs.push([label, val]);
        }

        for (const [label, val] of pairs) {
          const labelLower = label.toLowerCase();
          if (!val || /^na$/i.test(val)) continue;

          // Store everything in details
          details[label] = val;

          // Also extract individual fields
          if (keywords.some(kw => labelLower.includes(kw)) && !estimatedValue)
            estimatedValue = val;
          if ((labelLower.includes('tender category') || labelLower.includes('product category')) && !category)
            category = val;
          if (labelLower === 'location' && !location)
            location = val;
          if (labelLower.includes('emd amount') && !emdAmount)
            emdAmount = val;
        }
      }

      // ── Required documents ──
      const docs = [];
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText?.trim().toLowerCase());
        if (!headers.some(h => h.includes('document name'))) continue;
        const tableRows = Array.from(table.querySelectorAll('tbody tr'));
        for (const row of tableRows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          const anchor = row.querySelector('a[href]');
          const name = anchor?.innerText?.trim() || '';
          if (!name || !/\.(pdf|xls|xlsx|doc|docx|zip)/i.test(name)) continue;
          const cellTexts = cells.map(c => c.innerText?.trim());
          const description = cellTexts.find(t => t && t !== name && !/^\d+$/.test(t) && t.length > 1 && !/^s\.?no/i.test(t)) || '';
          const sizeText = cellTexts.find(t => /^\d+(\.\d+)?$/.test(t)) || '';
          const href = anchor?.getAttribute('href') || '';
          docs.push({
            name,
            description: description || null,
            size_kb: sizeText ? parseFloat(sizeText) : null,
            url: href || null,
          });
        }
      }

      // ── Stable apply/bid URL ──
      let applyUrl = null;
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const applyKeywords = ['view more detail', 'apply', 'submit bid', 'bid submission', 'more detail'];
      for (const a of allLinks) {
        const text = a.innerText?.toLowerCase().trim() || '';
        const href = a.getAttribute('href') || '';
        if (applyKeywords.some(kw => text.includes(kw)) && href && !href.includes('sp=')) {
          applyUrl = href;
          break;
        }
      }
      if (!applyUrl) {
        const cur = window.location.href;
        if (!cur.includes('sp=')) applyUrl = cur;
      }

      return { estimatedValue, requiredDocuments: docs, category, location, emdAmount, applyUrl, details };
    }, VALUE_KEYWORDS);

    await detailPage.close();
    logger.info('[TN] Detail page extracted — value=' + result.estimatedValue + ' category=' + result.category + ' location=' + result.location);
    return {
      estimatedValue:    parseAmount(result.estimatedValue),
      requiredDocuments: result.requiredDocuments,
      category:          result.category,
      location:          result.location,
      emdAmount:         parseAmount(result.emdAmount),
      applyUrl:          result.applyUrl || null,
      details:           Object.keys(result.details).length > 0 ? result.details : null,
    };
  } catch (err) {
    logger.warn('[TN] Detail page failed: ' + err.message);
    return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  }
}



// ─── Core helpers ─────────────────────────────────────────────────

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
  // Filter system IDs like 2026_DMRH_668573_1
  if (/^\d{4}_[A-Za-z]+_\d+_\d+$/.test(title)) return false;
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

function parseTitleCell(titleCell) {
  const bracketContents = [...titleCell.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  const beforeBracket   = titleCell.split('[')[0].trim();
  let title = '', refNo = '';

  if (bracketContents.length === 0) {
    title = cleanTitle(titleCell); refNo = '';
  } else if (bracketContents.length === 1) {
    if (bracketContents[0].length < 40 && REF_NO_PATTERN.test(bracketContents[0])) {
      refNo = bracketContents[0];
      title = cleanTitle(beforeBracket || bracketContents[0]);
    } else {
      title = cleanTitle(bracketContents[0]); refNo = '';
    }
  } else {
    const shortBracket = bracketContents.find(b => b.length < 40 && REF_NO_PATTERN.test(b));
    const longBracket  = bracketContents.find(b => b.length >= 15);
    if (shortBracket && longBracket && shortBracket !== longBracket) {
      refNo = shortBracket; title = cleanTitle(longBracket);
    } else if (shortBracket) {
      refNo = shortBracket;
      title = cleanTitle(beforeBracket || longBracket || bracketContents[0]);
    } else {
      title = cleanTitle(beforeBracket || bracketContents[0]);
      refNo = bracketContents[0];
    }
  }
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
          logger.info(`[TN] Clicked tab "${label}"`);
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

  async _scrapePage() {
    const tenders = [];
    const rows = await this.page.$$(SEL.tableRows).catch(() => []);

    for (const row of rows) {
      try {
        const cells = await row.$$('td');

        if (cells.length >= 12) {
          const getText = async (el) => {
            try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
            catch { return ''; }
          };
          const allCells = await Promise.all(cells.map(getText));

          let dataStart = -1;
          for (let i = 0; i < allCells.length - 5; i++) {
            const v = allCells[i].toLowerCase();
            if (v === 's.no' || v === 'sno' || v === 'sl.no') { dataStart = i + 6; break; }
          }
          if (dataStart === -1) dataStart = 0;

          logger.info(`[TN] Found data row with ${allCells.length} cells, data starts at index ${dataStart}`);

          const anchorHrefs = await row.$$eval('a[href]', els =>
            els.map(a => a.getAttribute('href'))
              .filter(h => h && h.includes('DirectLink'))
          ).catch(() => []);

          let linkIdx = 0;
          for (let i = dataStart; i + 5 < allCells.length; i += 6) {
            const sno       = allCells[i];
            const closing   = allCells[i + 2];
            const titleCell = allCells[i + 4];
            const org       = allCells[i + 5];

            if (sno && !/^\d+\.?$/.test(sno.trim())) break;

            const { title, refNo } = parseTitleCell(titleCell);
            const orgClean = (org || 'Tamil Nadu Government')
              .split('||').map(s => s.trim()).filter(Boolean).pop() || 'Tamil Nadu Government';

            if (!isValidTender(title, refNo)) {
              logger.warn(`[TN] Skipped: title="${title?.substring(0, 50)}" ref="${refNo?.substring(0, 50)}"`);
              linkIdx++;
              continue;
            }

            let detailUrl = '';
            const rawHref = anchorHrefs[linkIdx] || '';
            if (rawHref) {
              detailUrl = rawHref.startsWith('http')
                ? rawHref
                : `https://tntenders.gov.in${rawHref}`;
            }
            linkIdx++;

            // Extract estimated value from detail page
            const { estimatedValue, requiredDocuments, category, location, emdAmount, applyUrl, details } = await extractDetailPageData(this.page, detailUrl, HOME_URL).catch(() => ({ estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null }));
            if (estimatedValue) logger.info(`[TN] Extracted value ₹${estimatedValue} for "${title.substring(0, 40)}"`);

            tenders.push({
              tender_id:       makeTenderId(refNo, title),
              title:           title.substring(0, 500),
              organization:    orgClean.substring(0, 200),
              portal:          PORTAL,
              bid_end_date:    parseDate(closing),
              estimated_value:       estimatedValue,
              required_documents:   requiredDocuments.length > 0 ? requiredDocuments : null,
              category:             category || null,
              location:             location || null,
              emd_amount:           emdAmount || null,
              apply_url:            applyUrl || null,
              details:              details || null,
              url:             (detailUrl || HOME_URL).substring(0, 1000),
              scraped_at:      new Date().toISOString(),
            });
          }
          continue;
        }

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

      const { estimatedValue, requiredDocuments, category, location, emdAmount, applyUrl, details } = await extractDetailPageData(this.page, detailUrl, HOME_URL).catch(() => ({ estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null }));

      return {
        tender_id:       makeTenderId(refNo, title),
        title:           title.substring(0, 500),
        organization:    orgClean.substring(0, 200),
        portal:          PORTAL,
        bid_end_date:    parseDate(closing),
        estimated_value:       estimatedValue,
              required_documents:   requiredDocuments.length > 0 ? requiredDocuments : null,
              category:             category || null,
              location:             location || null,
              emd_amount:           emdAmount || null,
              apply_url:            applyUrl || null,
              details:              details || null,
        url:             (detailUrl || HOME_URL).substring(0, 1000),
        scraped_at:      new Date().toISOString(),
      };
    }

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

    const { estimatedValue, requiredDocuments, category, location, emdAmount, applyUrl, details } = await extractDetailPageData(this.page, detailUrl, HOME_URL).catch(() => ({ estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null }));

    return {
      tender_id:       makeTenderId(refNo, title),
      title:           title.substring(0, 500),
      organization:    'Tamil Nadu Government',
      portal:          PORTAL,
      bid_end_date:    parseDate(closingRaw),
      estimated_value:       estimatedValue,
              required_documents:   requiredDocuments.length > 0 ? requiredDocuments : null,
              category:             category || null,
              location:             location || null,
              emd_amount:           emdAmount || null,
              apply_url:            applyUrl || null,
              details:              details || null,
      url:             (detailUrl || HOME_URL).substring(0, 1000),
      scraped_at:      new Date().toISOString(),
    };
  }

  async _goToNextPage() {
    try {
      const allLinks = await this.page.$$('a');
      for (const link of allLinks) {
        const text = (await link.textContent().catch(() => '')).trim();
        if (text === '>') {
          await link.click();
          await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          await this.page.waitForTimeout(1500);
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
