# Talabat Brand Directory Scraper

Scrapes all ~30,000 brand entries from [talabat.com/uae/restaurants](https://www.talabat.com/uae/restaurants) and populates a Google Sheet via Google Apps Script.

## Architecture

```
GitHub Actions (scraper) → POST per page → Apps Script (web app) → Google Sheet
```

- **GitHub Actions** fetches each page of the Talabat brand directory (30 brands/page, ~1,007 pages)
- After fetching each page, it POSTs the extracted brands to a **Google Apps Script** web app
- The Apps Script endpoint appends the brands as rows to the Google Sheet
- Processing is page-by-page — no bulk handoff, no manual intervention

## Setup

### 1. Apps Script
1. Open the Google Sheet
2. Go to **Extensions > Apps Script**
3. Replace the default code with the contents of `AppsScript.js`
4. Deploy as web app:
   - Click **Deploy > New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the deployment URL

### 2. GitHub Secret
1. In this repo, go to **Settings > Secrets and variables > Actions**
2. Add a new secret: `APPS_SCRIPT_URL` = the deployment URL from step 1

### 3. Run
1. Go to **Actions > Scrape Talabat Brand Directory**
2. Click **Run workflow**
3. Optionally set start/end page and batch size
4. Monitor progress in the Actions log

## Fields Collected

| Column | Description |
|--------|-------------|
| id | Brand ID on Talabat |
| name | Brand display name |
| slug | URL slug (used in brand page URL) |
| cuisines | Comma-separated cuisine types |
| logo | Logo image URL |
| brandPageUrl | Full URL to brand page |

## Configuration

| Input | Default | Description |
|-------|---------|-------------|
| start_page | 1 | First page to scrape |
| end_page | 0 | Last page (0 = auto-detect) |
| batch_size | 50 | Pages per batch before pausing |
