/**
 * Talabat Brand Directory Scraper
 *
 * Fetches all brands from talabat.com/uae/restaurants paginated directory
 * and POSTs each page's data to a Google Apps Script web app endpoint
 * that writes to a Google Sheet.
 *
 * Designed to run as a GitHub Action.
 */

const TALABAT_BASE = 'https://www.talabat.com';
const DIRECTORY_URL = `${TALABAT_BASE}/uae/restaurants`;
const BRANDS_PER_PAGE = 30;

// Config from environment
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const START_PAGE = parseInt(process.env.START_PAGE || '1', 10);
const END_PAGE = parseInt(process.env.END_PAGE || '0', 10); // 0 = auto-detect
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);

// Retry and timing config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const PAGE_DELAY_MS = 1500;       // delay between fetching pages
const POST_DELAY_MS = 500;        // delay between POSTing to Apps Script
const BATCH_PAUSE_MS = 10000;     // pause between batches

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a single directory page and extract brand data from __NEXT_DATA__
 */
async function fetchPage(pageNum) {
  const url = `${DIRECTORY_URL}?page=${pageNum}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for page ${pageNum}`);
      }

      const html = await response.text();

      // Extract __NEXT_DATA__ JSON
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
      if (!match) {
        throw new Error(`No __NEXT_DATA__ found on page ${pageNum}`);
      }

      const nextData = JSON.parse(match[1]);
      const pageProps = nextData?.props?.pageProps;

      if (!pageProps) {
        throw new Error(`No pageProps found on page ${pageNum}`);
      }

      // Extract brand list - the restaurants array
      const restaurants = pageProps.restaurants || pageProps.initialRestaurants || [];
      const hasNextPage = pageProps.hasNextPage ?? false;

      // Map to our schema
      const brands = restaurants.map(r => ({
        id: r.id || r.brn || '',
        name: r.nam || r.name || '',
        slug: r.slg || r.slug || '',
        cuisines: (r.csi || r.cuisines || []).map(c => c.nam || c.name || c).join(', '),
        logo: r.lgo || r.logo || '',
        brandPageUrl: r.slg ? `${TALABAT_BASE}/uae/${r.slg}` : (r.slug ? `${TALABAT_BASE}/uae/${r.slug}` : ''),
      }));

      return { brands, hasNextPage, pageNum };

    } catch (err) {
      console.error(`  Attempt ${attempt}/${MAX_RETRIES} failed for page ${pageNum}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

/**
 * POST a page's brands to the Apps Script web app
 */
async function postToSheet(pageNum, brands) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNum, brands }),
        redirect: 'follow',
      });

      // Apps Script redirects on success, follow it
      const text = await response.text();

      // Try to parse response
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = { raw: text };
      }

      if (result.error) {
        throw new Error(`Apps Script error: ${result.error}`);
      }

      return result;

    } catch (err) {
      console.error(`  POST attempt ${attempt}/${MAX_RETRIES} failed for page ${pageNum}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Main scraping loop
 */
async function main() {
  if (!APPS_SCRIPT_URL) {
    console.error('ERROR: APPS_SCRIPT_URL secret is not set.');
    console.error('Add it as a repository secret in GitHub Settings > Secrets > Actions.');
    process.exit(1);
  }

  console.log('=== Talabat Brand Directory Scraper ===');
  console.log(`Start page: ${START_PAGE}`);
  console.log(`End page: ${END_PAGE === 0 ? 'auto-detect' : END_PAGE}`);
  console.log(`Batch size: ${BATCH_SIZE} pages`);
  console.log(`Apps Script URL: ${APPS_SCRIPT_URL.substring(0, 50)}...`);
  console.log('');

  let currentPage = START_PAGE;
  let totalBrands = 0;
  let totalPages = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  while (true) {
    // Check end condition
    if (END_PAGE > 0 && currentPage > END_PAGE) {
      console.log(`\nReached end page ${END_PAGE}. Stopping.`);
      break;
    }

    try {
      console.log(`Fetching page ${currentPage}...`);
      const { brands, hasNextPage } = await fetchPage(currentPage);

      if (brands.length === 0) {
        console.log(`  Page ${currentPage}: No brands found. End of directory.`);
        break;
      }

      console.log(`  Found ${brands.length} brands. Posting to sheet...`);

      // POST to Apps Script
      const result = await postToSheet(currentPage, brands);
      console.log(`  Page ${currentPage}: ${brands.length} brands written to sheet. ${result.rowsWritten ? `(${result.rowsWritten} rows)` : ''}`);

      totalBrands += brands.length;
      totalPages++;
      consecutiveErrors = 0;

      // Check if there are more pages
      if (!hasNextPage) {
        console.log(`\nNo more pages after page ${currentPage}. Directory complete.`);
        break;
      }

      currentPage++;

      // Batch pause
      if (totalPages % BATCH_SIZE === 0) {
        console.log(`\n--- Batch pause after ${totalPages} pages (${totalBrands} brands so far) ---\n`);
        await sleep(BATCH_PAUSE_MS);
      } else {
        await sleep(PAGE_DELAY_MS);
      }

    } catch (err) {
      consecutiveErrors++;
      console.error(`ERROR on page ${currentPage}: ${err.message}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`\n${MAX_CONSECUTIVE_ERRORS} consecutive errors. Aborting.`);
        console.error(`Last successful: page ${currentPage - 1}`);
        console.error(`To resume, set START_PAGE=${currentPage}`);
        process.exit(1);
      }

      // Skip this page and continue
      console.log(`  Skipping page ${currentPage}, moving to next...`);
      currentPage++;
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.log('\n=== Scraping Complete ===');
  console.log(`Total pages processed: ${totalPages}`);
  console.log(`Total brands collected: ${totalBrands}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
