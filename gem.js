require('dotenv').config();

const BaseScraper = require('./base');
const { upsertTenders, logScraperRun } = require('./supabase');
const logger = require('./logger');

const PORTAL = 'gem';
process.env.PORTAL = process.env.PORTAL || PORTAL;
const HOME_URL = 'https://bidplus.gem.gov.in/all-bids';
const MAX_PAGES = Number.parseInt(process.env.GEM_MAX_PAGES, 10) || 50;
const NAVIGATION_RETRIES = Math.max(1, Number.parseInt(process.env.GEM_NAVIGATION_RETRIES, 10) || 5);
const CARD_SELECTOR = '#bidCard .card';

function parseDate(raw) {
  if (!raw) return null;
  // GeM displays bid end dates in India Standard Time.
  const match = String(raw).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM))?$/i);
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const [, dayText, monthText, yearText, hourText, minuteText, secondText, meridiem] = match;
  const day = Number(dayText);
  const month = Number(monthText) - 1;
  const year = Number(yearText);
  let hour = Number(hourText || 0);
  const minute = Number(minuteText || 0);
  const second = Number(secondText || 0);
  if (meridiem) hour = hour % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

  const hasTime = Boolean(hourText);
  const utc = Date.UTC(year, month, day, hour, minute, second) - (hasTime ? 330 * 60 * 1000 : 0);
  const parsed = new Date(utc);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return null;
  return parsed.toISOString();
}

function makeTenderId(raw) {
  return `GEM-${String(raw).replace(/\s+/g, '').substring(0, 100)}`;
}

class GemScraper extends BaseScraper {
  constructor() { super(PORTAL); }

  async run() {
    const startTime = Date.now();
    const seenIds = new Set();
    let tendersFetched = 0;

    try {
      await this.launchBrowser();
      const ok = await this.navigateTo(HOME_URL, NAVIGATION_RETRIES, {
        initialDelayMs: 5000,
        maxDelayMs: 30000,
      });
      if (!ok) {
        const reason = this.lastNavigationError?.message;
        throw new Error(`Failed to load GeM bid listing after ${NAVIGATION_RETRIES} attempts${reason ? `; last error: ${reason}` : ''}`);
      }
      await this.page.waitForSelector(CARD_SELECTOR, { timeout: 20000 });

      const totalText = await this.page.textContent('#bidCard .totalRecord').catch(() => '');
      const totalMatch = totalText?.match(/of\s+([\d,]+)\s+records/i);
      const totalRecords = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
      const firstPageCards = await this.page.$$(CARD_SELECTOR);
      const pageSize = firstPageCards.length || 10;
      const totalPages = totalRecords ? Math.ceil(totalRecords / pageSize) : MAX_PAGES;
      const pagesToRead = Math.min(MAX_PAGES, totalPages);

      logger.info(`[GeM] Listing reports ${totalRecords ?? 'an unknown number of'} bids; reading up to ${pagesToRead} pages`);

      for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
        const tenders = await this._readCurrentPage();
        const fresh = tenders.filter(t => t && !seenIds.has(t.tender_id));
        fresh.forEach(t => seenIds.add(t.tender_id));

        if (fresh.length) {
          await upsertTenders(fresh);
          tendersFetched += fresh.length;
        }
        logger.info(`[GeM] Page ${pageNumber}/${pagesToRead}: ${tenders.length} cards, ${fresh.length} new tenders`);

        if (tenders.length === 0 || pageNumber >= pagesToRead) break;
        const next = await this.page.$('.pagination2 a.page-link.next');
        if (!next || !(await next.isVisible().catch(() => false)) || !(await next.isEnabled().catch(() => false))) break;
        const nextDisabled = await next.evaluate(el => el.closest('li')?.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true').catch(() => false);
        if (nextDisabled) break;

        const before = await this._pageFingerprint();
        await next.click();
        try {
          await this.page.waitForFunction((previous) => {
            const cards = Array.from(document.querySelectorAll('#bidCard .card .bid_no_hover'));
            const current = cards.map(a => a.textContent.trim()).join('|');
            return current && current !== previous;
          }, before, { timeout: 15000 });
        } catch (err) {
          logger.warn(`[GeM] Stopping pagination because the listing did not change: ${err.message}`);
          break;
        }
        await this.randomDelay(500, 1200);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      await logScraperRun({ portal: PORTAL, status: 'success', count: tendersFetched });
      logger.info(`[GeM] Done: ${tendersFetched} tenders in ${duration}s`);
    } catch (err) {
      logger.error(`[GeM] Fatal: ${err.message}`);
      await logScraperRun({ portal: PORTAL, status: 'error', message: err.message, count: tendersFetched });
      process.exitCode = 1;
    } finally {
      await this.cleanup();
    }
  }

  async _readCurrentPage() {
    return await this.page.$$eval(CARD_SELECTOR, cards => cards.map(card => {
      const bidLink = card.querySelector('a.bid_no_hover[href]');
      const itemColumn = card.querySelector('.card-body .col-md-4');
      const itemLink = itemColumn?.querySelector('a[data-content]') || itemColumn?.querySelector('a');
      const itemRow = itemColumn?.querySelector('.row');
      const department = card.querySelector('.card-body .col-md-5 .row:nth-child(2)');
      const endDate = card.querySelector('.card-body .end_date');
      const bidNumber = bidLink?.textContent?.trim() || '';
      const href = bidLink?.getAttribute('href') || '';
      const title = itemLink?.getAttribute('data-content')?.trim()
        || itemLink?.textContent?.trim()
        || itemRow?.innerText?.replace(/^Items:\s*/i, '').trim()
        || '';
      const organization = department?.innerText?.trim().replace(/\s+/g, ' ') || '';
      const detailUrl = href ? new URL(href, window.location.href).href : '';
      if (!bidNumber || !title) return null;
      return { bidNumber, title, organization, endDate: endDate?.textContent?.trim() || '', detailUrl };
    })).then(cards => cards.filter(Boolean).map(card => ({
      portal: PORTAL,
      tender_id: makeTenderId(card.bidNumber),
      title: card.title.substring(0, 500),
      organization: card.organization.substring(0, 300),
      bid_end_date: parseDate(card.endDate),
      detail_url: card.detailUrl.substring(0, 1000),
      url: card.detailUrl.substring(0, 1000),
      scraped_at: new Date().toISOString(),
    })));
  }

  async _pageFingerprint() {
    return await this.page.$$eval('#bidCard .card .bid_no_hover', links => links.map(a => a.textContent.trim()).join('|'));
  }
}

if (require.main === module) {
  new GemScraper().run().catch((err) => {
    logger.error(`[GeM] Unhandled error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { GemScraper, parseDate, makeTenderId };
