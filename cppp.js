require('dotenv').config();

const BaseScraper                      = require('./base');
const { upsertTenders, logScraperRun, supabase } = require('./supabase');
const logger                           = require('./logger');

const BASE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndListTendersbyDate&service=page';
const PORTAL   = 'cppp';

const SEL = {
  tableRows: 'table tbody tr',
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
  } catch (err) {
    logger.warn('[CPPP] Detail page failed: ' + err.message);
    return { estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null };
  }
}



// ─── Core helpers ─────────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return null;
  const m1 = raw.match(/(\d{1,2})[-\s\/](\w{3})[-\s\/](\d{4})/);
  if (m1) { const d = new Date(`${m1[1]} ${m1[2]} ${m1[3]}`); if (!isNaN(d.getTime())) return d.toISOString(); }
  const m2 = raw.match(/(\d{1,2})[-\/](\d{2})[-\/](\d{4})/);
  if (m2) { const d = new Date(`${m2[3]}-${m2[2]}-${m2[1]}`); if (!isNaN(d.getTime())) return d.toISOString(); }
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
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
      const enrichedIds = await fetchEnrichedIds();

      const tabs = [
        { label: 'Closing within 14 days', selector: SEL.tab14days },
        { label: 'Closing within 7 days',  selector: SEL.tab7days },
        { label: 'Closing Today',          selector: SEL.tabToday },
      ];

      for (const { label, selector } of tabs) {
        try {
          const tabEl = await this.page.$(selector);
          if (!tabEl) { logger.warn(`[CPPP] Tab not found: ${label}`); continue; }
          await tabEl.click();
          await this.page.waitForTimeout(3000);
          logger.info(`[CPPP] Clicked tab: ${label}`);
        } catch (err) {
          logger.warn(`[CPPP] Tab click failed "${label}": ${err.message}`);
          continue;
        }

        let pageNum = 1;
        while (true) {
          const tenders = await this._scrapePage(enrichedIds);
          const newTenders = tenders.filter(t => !seenIds.has(t.tender_id) && !isNoise(t.title));
          newTenders.forEach(t => seenIds.add(t.tender_id));

          logger.info(`[CPPP] "${label}" page ${pageNum} — ${newTenders.length} valid (${tenders.length - newTenders.length} skipped)`);

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
      logger.info(`CPPP done. ${totalScraped} total tenders in ${duration}s`);
      await logScraperRun({ portal: PORTAL, status: 'success', count: totalScraped });

    } catch (err) {
      logger.error(`CPPP failed: ${err.message}`);
      await logScraperRun({ portal: PORTAL, status: 'error', count: totalScraped, message: err.message }).catch(() => {});
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  async _scrapePage(enrichedIds = new Set()) {
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
              detailUrl = rawHref.startsWith('http') ? rawHref : `https://eprocure.gov.in${rawHref}`;
            }
            linkIdx++;

            // Skip detail page if already enriched
            const tenderId = makeTenderId(refNo, title);
            if (enrichedIds.has(tenderId)) {
              tenders.push({ tender_id: tenderId, title: title.substring(0, 500), organization: orgClean.substring(0, 200), portal: PORTAL, bid_end_date: parseDate(closing), url: (detailUrl || BASE_URL).substring(0, 1000), scraped_at: new Date().toISOString() });
              linkIdx++;
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
            detailUrl = href?.startsWith('http') ? href : `https://eprocure.gov.in${href}`;
          }
        } catch {}

        const { estimatedValue, requiredDocuments, category, location, emdAmount, applyUrl, details } = await extractDetailPageData(this.page, detailUrl, BASE_URL).catch(() => ({ estimatedValue: null, requiredDocuments: [], category: null, location: null, emdAmount: null, applyUrl: null, details: null }));

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
  new CpppScraper().run().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = CpppScraper;
