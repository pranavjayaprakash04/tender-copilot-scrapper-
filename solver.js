const { execFileSync } = require('child_process');
const path   = require('path');
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
  // Added #captchaImage (NIC/TN portal), img[id*="captcha"], img[class*="captcha"]
  image:  '#captchaImage, img[id*="captcha"], img[src*="captcha-img"], img[src*="captcha"], img[class*="captcha"], .captcha-image, .cap-mage, .captchaImgDiv img',
  input:  '#captchaText, input[name*="captcha"], input[id*="captcha"]',
  submit: '#submitCaptcha, input[type="submit"], button[type="submit"]',
};

async function getCaptchaBase64(page) {
  const imgEl = await page.$(CAPTCHA_SELECTORS.image);
  if (!imgEl) {
    // Log all img elements to help debug
    const imgs = await page.$$eval('img', els => els.map(e => ({ id: e.id, src: e.src?.substring(0,80), cls: e.className })));
    throw new Error(`CAPTCHA element not found. Images on page: ${JSON.stringify(imgs)}`);
  }
  const src = await imgEl.getAttribute('src');
  if (src && src.startsWith('data:image')) {
    return src.split(',')[1];
  }
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
