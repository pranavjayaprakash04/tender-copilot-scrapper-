const { execFileSync } = require('child_process');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const logger = require('./logger');

const RETRY_LIMIT = parseInt(process.env.CAPTCHA_RETRY_LIMIT) || 10;
const SOLVER_PY   = path.join(__dirname, 'captcha_solver.py');

function solveWithPython(base64Image) {
  try {
    const output = execFileSync('python3', [SOLVER_PY, base64Image], {
      timeout: 30000,
      encoding: 'utf8',
    }).trim();
    const result = JSON.parse(output);
    if (!result.success) throw new Error(result.error || 'Unknown solver error');
    return result.answer;
  } catch (err) {
    throw new Error(`parse solver output: ${err.message}`);
  }
}

const CAPTCHA_SELECTORS = {
  image:  '#captchaImage, img[id*="captcha"], img[src*="captcha-img"], img[src*="captcha"], img[class*="captcha"], .captchaImgDiv img',
  input:  '#captchaText, input[name*="captcha"], input[id*="captcha"]',
  submit: '#submitCaptcha, input[type="submit"], button[type="submit"]',
};

function fetchUrlAsBase64(url, referer) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer || url,
      }
    };
    client.get(url, options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getCaptchaBase64(page) {
  const imgEl = await page.$(CAPTCHA_SELECTORS.image);
  if (!imgEl) {
    const imgs = await page.$$eval('img', els =>
      els.map(e => ({ id: e.id, src: e.src?.substring(0, 100), cls: e.className }))
    );
    throw new Error(`CAPTCHA element not found. Images: ${JSON.stringify(imgs)}`);
  }

  const src = await imgEl.getAttribute('src');
  logger.info(`[captcha] Image src: ${src?.substring(0, 100)}`);

  // data URI — use directly
  if (src && src.startsWith('data:image')) {
    return src.split(',')[1];
  }

  // Absolute URL — fetch directly via HTTP (bypasses Playwright image blocking)
  if (src && src.startsWith('http')) {
    const pageUrl = page.url();
    return await fetchUrlAsBase64(src, pageUrl);
  }

  // Relative URL — make absolute
  if (src) {
    const base = new URL(page.url());
    const absoluteUrl = new URL(src, base.origin).href;
    logger.info(`[captcha] Resolved URL: ${absoluteUrl}`);
    return await fetchUrlAsBase64(absoluteUrl, page.url());
  }

  // Last resort — screenshot (may be blank if image was blocked)
  logger.warn('[captcha] No src found, falling back to screenshot');
  const buf = await imgEl.screenshot();
  return buf.toString('base64');
}

async function solveCaptchaLoop(page, _unused, portal) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    logger.info(`CAPTCHA attempt ${attempt} of ${RETRY_LIMIT}`, { portal });
    try {
      const b64 = await getCaptchaBase64(page);
      const answer = solveWithPython(b64);
      logger.info(`CAPTCHA solved: "${answer}"`, { portal });

      if (!answer || answer.trim() === '') {
        logger.warn('Empty answer from solver, refreshing captcha', { portal });
        // Try clicking refresh if available
        try {
          await page.click('a[onclick*="refresh"], a[onclick*="captcha"], #refreshCaptcha, a:has-text("Refresh")', { timeout: 2000 });
          await page.waitForTimeout(1000);
        } catch {}
        continue;
      }

      const inputEl = await page.$(CAPTCHA_SELECTORS.input);
      if (!inputEl) throw new Error('CAPTCHA input not found');
      await inputEl.fill(answer);

      const submitEl = await page.$(CAPTCHA_SELECTORS.submit);
      if (!submitEl) throw new Error('CAPTCHA submit button not found');
      await submitEl.click();

      await page.waitForTimeout(2000);

      const stillVisible = await page.isVisible(CAPTCHA_SELECTORS.image, { timeout: 2000 }).catch(() => false);
      if (!stillVisible) {
        logger.info(`CAPTCHA solved on attempt ${attempt}`, { portal });
        return true;
      }
      logger.warn(`CAPTCHA answer "${answer}" rejected, retrying`, { portal });
    } catch (err) {
      logger.warn(`CAPTCHA attempt ${attempt} failed: ${err.message}`, { portal });
    }
  }
  logger.error(`CAPTCHA solve failed after ${RETRY_LIMIT} attempts`, { portal });
  return false;
}

module.exports = { solveCaptchaLoop };
