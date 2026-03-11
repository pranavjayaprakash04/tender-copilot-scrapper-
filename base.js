require('dotenv').config();

const { chromium } = require('playwright');
const logger = require('./logger');
const { solveCaptchaLoop } = require('./solver');

const DELAY_MIN = parseInt(process.env.REQUEST_DELAY_MIN) || 2000;
const DELAY_MAX = parseInt(process.env.REQUEST_DELAY_MAX) || 5000;

class BaseScraper {
  constructor(portal) {
    this.portal   = portal;
    this.browser  = null;
    this.page     = null;
    this.session  = null;
    this.results  = [];
  }

  // ── Browser setup ────────────────────────────────────────────────────────

  async launchBrowser() {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768',
      ],
    });

    const context = await this.browser.newContext({
      userAgent: this._randomUserAgent(),
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en;q=0.9,ta;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    // Mask navigator.webdriver and other automation signals
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en', 'ta'] });
      window.chrome = { runtime: {} };
    });

    this.page = await context.newPage();

    // Block heavy media to speed up scraping (allow captcha resources through)
    await this.page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf}', (route) => {
      if (route.request().url().toLowerCase().includes('captcha')) {
        route.continue();
      } else {
        route.abort();
      }
    });

    logger.info('Browser launched in stealth mode', { portal: this.portal });
  }

  // ── Captcha ───────────────────────────────────────────────────────────────

  async solveCaptcha(captchaPage) {
    return await solveCaptchaLoop(this.page, captchaPage, this.portal);
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /**
   * Navigate to a URL with retry logic.
   * @param {string} url
   * @param {number} retries
   * @returns {boolean} true on success, false after all retries exhausted
   */
  async navigateTo(url, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return true;
      } catch (err) {
        logger.warn(
          `Navigation failed (attempt ${attempt + 1}): ${err.message}`,
          { portal: this.portal }
        );
        await this.randomDelay();
      }
    }
    return false;
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  /**
   * Return the trimmed inner text of the first matching element, or '' on failure.
   */
  async getText(selector, fallback = '') {
    try {
      return await this.page.textContent(selector, { timeout: 3000 }) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Return an attribute value, or fallback on failure.
   */
  async getAttribute(selector, attribute, fallback = '') {
    try {
      return await this.page.getAttribute(selector, attribute, { timeout: 3000 }) || fallback;
    } catch {
      return fallback;
    }
  }

  // ── Timing ────────────────────────────────────────────────────────────────

  /**
   * Wait for a random delay between DELAY_MIN and DELAY_MAX ms.
   */
  async randomDelay(min = DELAY_MIN, max = DELAY_MAX) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.page.waitForTimeout(ms);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page    = null;
    }
  }

  // ── User-agent rotation ──────────────────────────────────────────────────

  _randomUserAgent() {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }

  // ── Abstract ──────────────────────────────────────────────────────────────

  /**
   * Subclasses must override this method with their scraping logic.
   */
  async run() {
    throw new Error('run() must be implemented by each portal scraper subclass.');
  }
}

module.exports = BaseScraper;
