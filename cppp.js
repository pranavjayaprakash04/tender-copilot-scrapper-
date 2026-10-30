require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun, supabase } = require('./supabase');
const logger                           = require('./logger');

const BASE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndListTendersbyDate&service=page';
const PORTAL   = 'cppp';
process.env.PORTAL = process.env.PORTAL || PORTAL;

const SEL = {
  tableRows: 'table tbody tr',
  captcha:   '#captchaImage, img[src*="captcha"], input[name*="captcha"], input[id*="captcha"]',
  tab14days: 'a:has-text("Closing within 14 days")',
  tab7days:  'a:has-text("Closing within 7 days")',
  tabToday:  'a:has-text("Closing Today")',
};

const NOISE_PATTERNS = [
  /^corrigendum/i, /^amendment/i, /^bid auto ext/i,
  /date extension/i, /^extension[-\s]/i, /^revised p\.g/i,
  /^corr$/i, /^nda approval/i, /^bid due date/i,
  /^pre-tender meet/i, /^invitation to pre-tender/i,
];

const SKIP_TITLES = new Set([
  's.no', 'sno', 'sl.no', 'e-published date', 'bid submission closing date',
  'tender opening date', 'title and ref.no./tender id', 'organisation chain',
  'name of dept./orgn.', 'screen reader access',
]);

function isNoise(title) {
  if (!title || title.trim().length < 5) return true;
  if (SKIP_TITLES.has(title.toLowerCase().trim())) return true;
  return NOISE_PATTERNS.some(p => p.test(title.trim()));
}

const REF_NO_PATTERN = /[A-Z0-9][A-Z0-9\/\-\.\s]{1,}[0-9]/i;
const MAX_PAGES_PER_TAB = Number.parseInt(process.env.CPPP_MAX_PAGES_PER_TAB, 10) || 100;

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
  if (/^0(\.0+)?$/.test(text.trim())) return null;
  text = text.replace(/Rs\.?/gi, '').replace(/₹/g, '').replace(/\/-/g, '').trim();
  const crore = text.match(/([\d,.]+)\s*(?:crore|crores|cr\.?)\b/i);
  if (crore) return parseFloat(crore[1].replace(/,/g, '')) * 10_000_000;
  const lakh = text.match(/([\d,.]+)\s*(?:lakh|lakhs|lac|lacs)\b/i);
  if (lakh) return parseFloat(lakh[1].replace(/,/g, '')) * 100_000;
  const plain = text.replace(/,/g, '').match(/[\d.]+/);
  if (plain) { const v = parseFloat(plain[0]); return isNaN(v) ? null : v; }
  return null;
}


// ─── Fetch tender IDs already enriched in DB ─────────────────────
async function fetchEnrichedIds() {
  try {
    const enriched = new Set();
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('tenders')
        .select('tender_id')
        .eq('portal', 'cppp')
        .not('details', 'is', null)
        .range(from, from + pageSize - 1);
      if (error || !data || data.length === 0) break;
      data.forEach(r => enriched.add(r.tender_id));
      if (data.length < pageSize) break;
      from += pageSize;
    }
    logger.info('[CPPP] Skipping detail pages for ' + enriched.size + ' already-enriched tenders');
    return enriched;
  } catch (err) {
    logger.warn('[CPPP] Could not fetch enriched IDs: ' + err.message);
    return new Set();
  }
}

async function extractDetailPageData(page, url, baseUrl) {
  if (!url || url === baseUrl) return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  if (!url.includes('DirectLink')) return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  if (url.includes('gepnicreports')) return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  try {
    logger.info('[CPPP] Visiting detail page: ' + url.substring(0, 80));
    const detailPage = await page.context().newPage();
    try {
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
        const firstRow = table.querySelector('tr');
        const headers = [
          ...Array.from(table.querySelectorAll('th')).map(th => th.innerText?.trim().toLowerCase() || ''),
          ...Array.from(firstRow?.querySelectorAll(':scope > td') || [])
            .filter(td => !td.querySelector('table'))
            .map(td => td.innerText?.trim().toLowerCase() || ''),
        ];
        if (!headers.some(h => h.includes('document name'))) continue;
        const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
        const tableRows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1);
        for (const row of tableRows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          const fileCell = cells.find(cell => /\.(pdf|xls|xlsx|doc|docx|zip)\b/i.test(cell.innerText?.trim() || ''));
          const anchor = fileCell?.querySelector('a[href]') || null;
          const name = anchor?.innerText?.trim() || fileCell?.innerText?.trim() || '';
          if (!name || !/\.(pdf|xls|xlsx|doc|docx|zip)/i.test(name)) continue;
          const cellTexts = cells.map(c => c.innerText?.trim());
          const description = cellTexts.find(t => t && t !== name && !/^\d+$/.test(t) && t.length > 1 && !/^s\.?no/i.test(t)) || '';
          const sizeText = cellTexts.find(t => /^\d+(\.\d+)?$/.test(t)) || '';
          const href = anchor?.getAttribute('href') || '';
          docs.push({
            name,
            description: description || null,
            size_kb: sizeText ? parseFloat(sizeText) : null,
            url: href ? new URL(href, window.location.href).href : null,
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

    logger.info('[CPPP] Detail page extracted — value=' + result.estimatedValue + ' category=' + result.category + ' location=' + result.location);
    return {
      estimatedValue:    parseAmount(result.estimatedValue),
      requiredDocuments: result.requiredDocuments,
      category:          result.category,
      location:          result.location,
      emdAmount:         parseAmount(result.emdAmount),
      applyUrl:          result.applyUrl || null,
      details:           Object.keys(result.details).length > 0 ? result.details : null,
    };
    } finally {
      await detailPage.close().catch(() => {});
    }
  } catch (err) {
    logger.warn('[CPPP] Detail page failed: ' + err.message);
    return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  }
}



// ─── Core helpers ─────────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return null;
  // CPPP dates with a time are displayed in India Standard Time.
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const timePattern = '(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?)?';
  const m1 = raw.match(new RegExp(`(\\d{1,2})[-\\s/](\\w{3,9})[-\\s/](\\d{4})${timePattern}`, 'i'));
  const m2 = raw.match(new RegExp(`(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})${timePattern}`, 'i'));
  let day, month, year, hour, minute, second, hasTime;
  if (m1 && months[m1[2].slice(0, 3).toLowerCase()] !== undefined) {
    [, day, , year, hour, minute, second] = m1;
    month = months[m1[2].slice(0, 3).toLowerCase()];
    hasTime = Boolean(hour);
    if (m1[7]) hour = Number(hour) % 12 + (m1[7].toUpperCase() === 'PM' ? 12 : 0);
  } else if (m2) {
    [, day, month, year, hour, minute, second] = m2;
    month = Number(month) - 1;
    hasTime = Boolean(hour);
    if (m2[7]) hour = Number(hour) % 12 + (m2[7].toUpperCase() === 'PM' ? 12 : 0);
  } else {
    const date = new Date(raw.trim());
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  day = Number(day); year = Number(year); hour = Number(hour || 0);
  minute = Number(minute || 0); second = Number(second || 0);
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month, day, hour, minute, second) - (hasTime ? 330 * 60 * 1000 : 0);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function makeTenderId(refNo, title) {
  const base = refNo
    ? refNo.replace(/\s+/g, '').substring(0, 100)
    : title.replace(/\s+/g, '').substring(0, 80);
  return `CPPP-${base}`.substring(0, 200);
}

function parseTitleCell(titleCell) {
  const bracketContents = [...titleCell.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  const beforeBracket   = titleCell.split('[')[0].trim();
  let title = '', refNo = '';

  if (bracketContents.length === 0) {
    title = titleCell.replace(/^\[/, '').replace(/\]$/, '').trim();
  } else if (bracketContents.length === 1) {
    if (bracketContents[0].length < 40 && REF_NO_PATTERN.test(bracketContents[0])) {
      refNo = bracketContents[0]; title = beforeBracket || refNo;
    } else {
      title = bracketContents[0];
    }
  } else {
    const shortBracket = bracketContents.find(b => b.length < 40 && REF_NO_PATTERN.test(b));
    const longBracket  = bracketContents.find(b => b.length >= 15);
    if (shortBracket && longBracket && shortBracket !== longBracket) {
      refNo = shortBracket; title = longBracket;
    } else {
      title = beforeBracket || bracketContents[0]; refNo = bracketContents[0];
    }
  }
  if (!title && beforeBracket.length > 5) title = beforeBracket;
  title = title.replace(/^\[/, '').replace(/\]$/, '').trim();
  return { title, refNo };
}

class CpppScraper extends BaseScraper {
  constructor() { super(PORTAL); }

  async run() {
    const startTime = Date.now();
    logger.info('Starting CPPP scraper');
    let totalScraped = 0;
    const seenIds = new Set();

    try {
      await this.launchBrowser();
      const ok = await this.navigateTo(BASE_URL);
      if (!ok) throw new Error('Failed to load CPPP page');
      logger.info(`[CPPP] URL: ${this.page.url()}`);
      const captchaEl = await this.page.$(SEL.captcha).catch(() => null);
      if (captchaEl) throw new Error('Captcha wall on CPPP tender listing page');
      const enrichedIds = await fetchEnrichedIds();

      const tabs = [
        { label: 'Closing within 14 days', selector: SEL.tab14days },
        { label: 'Closing within 7 days',  selector: SEL.tab7days },
        { label: 'Closing Today',          selector: SEL.tabToday },
      ];

      let tabsClicked = 0;
      for (const { label, selector } of tabs) {
        try {
          const tabEl = await this.page.$(selector);
          if (!tabEl) { logger.warn(`[CPPP] Tab not found: ${label}`); continue; }
          await tabEl.click();
          await this.page.waitForTimeout(3000);
          tabsClicked++;
          logger.info(`[CPPP] Clicked tab: ${label}`);
        } catch (err) {
          logger.warn(`[CPPP] Tab click failed "${label}": ${err.message}`);
          continue;
        }

        let pageNum = 1;
        const visitedPageKeys = new Set();
        while (true) {
          if (pageNum > MAX_PAGES_PER_TAB) {
            logger.warn(`[CPPP] Stopping "${label}" after safety limit of ${MAX_PAGES_PER_TAB} pages`);
            break;
          }
          const tenders = await this._scrapePage(enrichedIds, seenIds);
          const pageKey = await this._pageFingerprint();
          if (visitedPageKeys.has(pageKey)) {
            logger.warn(`[CPPP] Stopping "${label}": pagination returned to an already-seen page`);
            break;
          }
          visitedPageKeys.add(pageKey);
          const newTenders = tenders.filter(t => !seenIds.has(t.tender_id) && !isNoise(t.title));
          newTenders.forEach(t => seenIds.add(t.tender_id));

          logger.info(`[CPPP] "${label}" page ${pageNum} — ${newTenders.length} valid (${tenders.length - newTenders.length} skipped)`);

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

      if (tabsClicked === 0) throw new Error('No expected closing-date tabs were found on CPPP');

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`CPPP done. ${totalScraped} total tenders in ${duration}s`);
      await logScraperRun({ portal: PORTAL, status: 'success', count: totalScraped });

    } catch (err) {
      logger.error(`CPPP failed: ${err.message}`);
      await logScraperRun({ portal: PORTAL, status: 'error', count: totalScraped, message: err.message }).catch(() => {});
      process.exitCode = 1;
    } finally {
      await this.cleanup();
    }
  }

  async _scrapePage(enrichedIds = new Set(), alreadySeenIds = new Set()) {
    const tenders = [];
    const rows = await this.page.$$(SEL.tableRows).catch(() => []);

    for (const row of rows) {
      try {
        const cells = await row.$$('css=:scope > td');

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

          logger.info(`[CPPP] Found data row with ${allCells.length} cells, data starts at index ${dataStart}`);

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
            const orgClean = (org || 'Central Government')
              .split('||').map(s => s.trim()).filter(Boolean).pop() || 'Central Government';

            if (!title || title.length < 5) { linkIdx++; continue; }

            let detailUrl = '';
            const rawHref = anchorHrefs[linkIdx] || '';
            if (rawHref) {
              detailUrl = new URL(rawHref, BASE_URL).href;
            }
            linkIdx++;

            // Skip detail page if already enriched
            const tenderId = makeTenderId(refNo, title);
            if (alreadySeenIds.has(tenderId)) continue;
            if (enrichedIds.has(tenderId)) {
              tenders.push({ tender_id: tenderId, title: title.substring(0, 500), organization: orgClean.substring(0, 200), portal: PORTAL, bid_end_date: parseDate(closing), url: (detailUrl || BASE_URL).substring(0, 1000), scraped_at: new Date().toISOString() });
              continue;
            }
            const { estimatedValue, requiredDocuments, category, location, emdAmount, applyUrl, details } = await extractDetailPageData(this.page, detailUrl, BASE_URL).catch(() => ({ estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null }));
            if (estimatedValue) logger.info(`[CPPP] Extracted value ₹${estimatedValue} for "${title.substring(0, 40)}"`);

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
              url:             (detailUrl || BASE_URL).substring(0, 1000),
              scraped_at:      new Date().toISOString(),
            });
          }
          continue;
        }

        // Normal row fallback
        const getText = async (el) => {
          try { return (await el.textContent())?.trim().replace(/\s+/g, ' ') ?? ''; }
          catch { return ''; }
        };
        const allCells = await Promise.all(cells.map(getText));
        if (allCells.length < 5) continue;

        const { title, refNo } = parseTitleCell(allCells[4] || '');
        const org     = allCells[5] || 'Central Government';
        const closing = allCells[2] || '';
        const orgClean = org.split('||').map(s => s.trim()).filter(Boolean).pop() || 'Central Government';

        if (!title || title.length < 5) continue;

        let detailUrl = '';
        try {
          const a = await row.$('a[href]');
          if (a) {
            const href = await a.getAttribute('href');
            detailUrl = href ? new URL(href, BASE_URL).href : '';
          }
        } catch {}

        const tenderId = makeTenderId(refNo, title);
        if (alreadySeenIds.has(tenderId)) continue;
        if (enrichedIds.has(tenderId)) {
          tenders.push({
            tender_id: tenderId,
            title: title.substring(0, 500),
            organization: orgClean.substring(0, 200),
            portal: PORTAL,
            bid_end_date: parseDate(closing),
            url: (detailUrl || BASE_URL).substring(0, 1000),
            scraped_at: new Date().toISOString(),
          });
          continue;
        }

        const { estimatedValue, requiredDocuments, category, location, emdAmount, applyUrl, details } = await extractDetailPageData(this.page, detailUrl, BASE_URL).catch(() => ({ estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null }));

        tenders.push({
          tender_id:       tenderId,
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
          url:             (detailUrl || BASE_URL).substring(0, 1000),
          scraped_at:      new Date().toISOString(),
        });

      } catch (err) {
        logger.warn(`[CPPP] Row error: ${err.message}`);
      }
    }
    return tenders;
  }

  async _goToNextPage() {
    try {
      const allLinks = await this.page.$$('a');
      for (const link of allLinks) {
        const text = (await link.textContent().catch(() => '')).trim();
        const disabled = await link.evaluate(el => el.closest('li')?.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true').catch(() => false);
        if (text === '>' && !disabled) {
          const before = await this._pageFingerprint();
          await link.click();
          try {
            await this.page.waitForFunction((previous) => {
              const rows = Array.from(document.querySelectorAll('table tbody tr'));
              const text = rows.map(row => row.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join('|');
              return `${location.href}::${text}` !== previous;
            }, before, { timeout: 8000 });
          } catch {
            return false;
          }
          return true;
        }
      }
      return false;
    } catch { return false; }
  }

  async _pageFingerprint() {
    try {
      return await this.page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        const text = rows.map(row => row.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join('|');
        return `${location.href}::${text}`;
      });
    } catch {
      return this.page.url();
    }
  }
}

if (require.main === module) {
  new CpppScraper().run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = CpppScraper;
