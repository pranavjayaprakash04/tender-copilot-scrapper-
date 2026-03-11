# TenderPilot Scraper — GitHub Actions Setup
## Zero cost. Zero credit card. Runs forever.

---

## How It Works

```
GitHub (free)
  └── Every 2 hours: spins up Ubuntu VM automatically
  └── Installs Node, Python, Playwright, ddddocr
  └── Runs all 3 scrapers IN PARALLEL
  └── Uploads tenders to Supabase
  └── Shuts down VM (you pay nothing)
  └── Repeats in 2 hours
```

---

## STEP 1: Create a GitHub Account
Go to https://github.com and sign up (free).

---

## STEP 2: Create a New Repository

1. Click **New Repository**
2. Name it: `tenderpilot-scraper`
3. Set it to **Public** (unlimited free minutes)
4. Click **Create Repository**

---

## STEP 3: Upload Your Code

Upload all files maintaining this structure:
```
tenderpilot-scraper/
├── .github/
│   └── workflows/
│       └── scraper.yml
├── scrapers/
│   ├── base.js
│   ├── gem.js
│   ├── cppp.js
│   └── tn.js
├── captcha/
│   ├── captcha_solver.py
│   └── solver.js
├── db/
│   ├── schema.sql
│   └── supabase.js
├── config/
│   └── logger.js
└── package.json
```

---

## STEP 4: Add Supabase Secrets

1. In your GitHub repo → click **Settings**
2. Left sidebar → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add:

| Secret Name | Value |
|-------------|-------|
| `SUPABASE_URL` | https://xxxxx.supabase.co |
| `SUPABASE_KEY` | your anon/service key |

---

## STEP 5: Set Up Supabase Database

1. Supabase project → **SQL Editor**
2. Paste and run full contents of `db/schema.sql`
3. Confirm `tenders` and `scraper_logs` tables appear

---

## STEP 6: Test It Right Now

1. Go to **Actions** tab in your repo
2. Click **TenderPilot Autonomous Scraper**
3. Click **Run workflow** → **Run workflow**
4. Watch all 3 portals run in parallel live

---

## STEP 7: Verify Data

Supabase → Table Editor → `tenders` — rows should appear after first run.

```sql
SELECT * FROM scraper_health;
SELECT * FROM scraper_logs ORDER BY ran_at DESC LIMIT 20;
```

---

## Schedule

```
Every 2 hours, 24/7:
  GeM + CPPP + TN all run simultaneously
  Each run takes ~20-40 minutes
  Data uploads to Supabase automatically
```

---

## Free Tier Limits

| Resource | GitHub Free | Your Usage |
|----------|------------|------------|
| Minutes/month | Unlimited (public repo) | ~360 min |
| Concurrent jobs | 20 | 3 |

## Total Cost: ₹0/month ✅
