# TenderPilot Scraper

This repository scrapes public tender listings from GeM, CPPP, Tamil Nadu Tenders, and selected NIC GePNIC portals. Results are written to Supabase.

## Supported portal jobs

The GitHub Actions workflow runs each selected portal in its own job. Scheduled runs retain the two-hour cadence.

| Workflow portal | Source |
|---|---|
| `gem` | Government e-Marketplace |
| `cppp` | Central Public Procurement Portal |
| `tn` | Tamil Nadu GePNIC |
| `nic-mp` | Madhya Pradesh GePNIC |
| `nic-odisha` | Odisha GePNIC |
| `nic-chandigarh` | Chandigarh GePNIC |
| `nic-delhi` | Delhi GePNIC |
| `nic-coal` | Coal India GePNIC |
| `nic-iocl` | Indian Oil GePNIC |
| `nic-ntpc` | NTPC GePNIC |
| `nic-cpcl` | CPCL GePNIC |
| `nic-bhel` | BHEL GePNIC |

The `nic-*` jobs use the existing GePNIC extraction flow with a portal-specific base URL and database portal ID. They are not enabled for sites with different platforms such as Bihar e-Procurement 2.0 or Telangana's state portal.

GeM is read from its public bid-listing page using the rendered bid cards and the page's own pagination. It reads at most 50 pages by default; set `GEM_MAX_PAGES` to change that limit. The GePNIC and CPPP scrapers use their own per-tab page limits (`TN_MAX_PAGES_PER_TAB` and `CPPP_MAX_PAGES_PER_TAB`), each defaulting to 100.

## Requirements

- Node.js 22.x
- Chromium (installed by Playwright)
- A Supabase project with the schema in `schema.sql`

Install from the repository root:

```sh
npm ci
npx playwright install chromium
```

Python packages in `requirements.txt` are only needed if CAPTCHA-solving support is deliberately integrated. The current scrapers stop and report an error when they encounter a CAPTCHA; they do not invoke the OCR helper.

## Configure Supabase

Run the updated `schema.sql` in the Supabase SQL Editor before enabling the new portal jobs. It adds the fields the current scrapers write and updates the closing-soon view; the `ALTER TABLE ... IF NOT EXISTS` statements support databases created from the earlier schema. Add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | A Supabase key allowed to write scraper records |

For local runs, create a `.env` file in the repository root with the same variable names. Do not commit `.env` or secret keys.

## Run locally

Run one scraper from the repository root:

```sh
node gem.js
node cppp.js
node tn.js
node gepnic.js nic-mp
node gepnic.js nic-odisha
```

The remaining `nic-*` IDs in the table above can be passed to `gepnic.js` the same way. In GitHub Actions, choose one portal or `all` from **Actions → TenderPilot Autonomous Scraper → Run workflow**.

## Check results

Inspect tender rows in Supabase's `tenders` table and recent run status with:

```sql
SELECT * FROM scraper_health;
SELECT * FROM scraper_logs ORDER BY ran_at DESC LIMIT 20;
```

Logs are written under `logs/` and uploaded as a GitHub Actions artifact after each run.
