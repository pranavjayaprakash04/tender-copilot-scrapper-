const { execFileSync } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const logger = require('./logger');

const RETRY_LIMIT = parseInt(process.env.CAPTCHA_RETRY_LIMIT) || 10;
const SOLVER_PY   = path.join(__dirname, 'captcha_solver.py');

// ── Low-level solver ──────────────────────────────────────────────────────────

/**
 * Call the Python ddddocr solver with a base64 image string.
 * Returns the text answer, or throws on failure.
 */
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

// ── CAPTCHA element helpers ───────────────────────────────────────────────────

const CAPTCHA_SELECTORS = {
  image:  'img[src*="captcha-img"], img[src*="captcha"], .captcha-image, .cap-mage, img[src*="captcha"]',
  input:  'input[name*="captcha"], input[id*="captcha"], #captchaText',
  submit: '#submitCaptcha, button[type="submit"], input[type="submit"]',
};

/**
 * Grab the CAPTCHA image from the page as a base64 string.
 */
async function getCaptchaBase64(page) {
  const imgEl = await page.$(CAPTCHA_SELECTORS.image);
  if (!imgEl) throw new Error('CAPTCHA element not found');

  // Try src attribute first (data URI or URL)
  const src = await imgEl.getAttribute('src');
  if (src && src.startsWith('data:image')) {
    return src.split(',')[1]; // strip "data:image/png;base64,"
  }

  // Fall back to screenshot of the element
  const buf = await imgEl.screenshot();
  return buf.toString('base64');
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Solve a CAPTCHA on the given page, retrying up to RETRY_LIMIT times.
 * @param {import('playwright').Page} page
 * @param {*} _unused  - kept for API compatibility
 * @param {string} portal - for logging
 */
async function solveCaptchaLoop(page, _unused, portal) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    logger.info(`CAPTCHA attempt ${attempt} of ${RETRY_LIMIT}`, { portal });

    try {
      // 1. Get image
      const b64 = await getCaptchaBase64(page);

      // 2. Solve
      const answer = solveWithPython(b64);
      logger.info(`✅ CAPTCHA solved: "${answer}", retrying`, { portal });

      // 3. Fill input
      const inputEl = await page.$(CAPTCHA_SELECTORS.input);
      if (!inputEl) throw new Error('CAPTCHA input not found');
      await inputEl.fill(answer);

      // 4. Submit
      const submitEl = await page.$(CAPTCHA_SELECTORS.submit);
      if (!submitEl) throw new Error('CAPTCHA submit button not found');
      await submitEl.click();

      // 5. Wait briefly for page response
      await page.waitForTimeout(2000);

      // 6. Check if CAPTCHA is gone
      const stillVisible = await page.isVisible(CAPTCHA_SELECTORS.image, { timeout: 2000 }).catch(() => false);
      if (!stillVisible) {
        logger.info(`🔓 CAPTCHA solved on attempt ${attempt}`, { portal });
        return true;
      }

      logger.warn(`CAPTCHA solve failed attempt ${attempt} — answer "${answer}", retrying`, { portal });

    } catch (err) {
      logger.warn(`CAPTCHA attempt ${attempt} failed: ${err.message}`, { portal });
    }
  }

  logger.error(`CAPTCHA solve failed after ${RETRY_LIMIT} attempts`, { portal });
  return false;
}

module.exports = { solveCaptchaLoop };
