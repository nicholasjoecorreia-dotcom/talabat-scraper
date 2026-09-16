/**
 * Talabat Brand Page Scraper (Phase 2)
 *
 * Fetches detailed brand information from individual brand pages on talabat.com.
 *
 * Flow:
 *  1. GET brand slugs from Apps Script (reads the "List of Brand Directory" sheet)
 *  2. GET already-processed brand IDs (from the "Brand Information" sheet)
 *  3. For each unprocessed brand, fetch its page and extract __NEXT_DATA__
 *  4. POST brand details to Apps Script in batches of 10
 *
 * Supports resumption: re-running picks up where the previous run left off.
 * Designed to run as a GitHub Action (workflow_dispatch).
 */

// ── Configuration ────────────────────────────────────────────────────
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CONCURRENCY    = parseInt(process.env.CONCURRENCY   || '5', 10);
const BATCH_SIZE     = 10;   // brands per POST to Apps Script
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 5000;
const FETCH_DELAY_MS = 1000; // ms between concurrency groups
const POST_DELAY_MS  = 500;  // ms between POSTs to Apps Script

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

// ── Step 1: Fetch brand slugs from directory sheet via Apps Script ───
async function getAllBrandSlugs() {
  const allBrands = [];
  let offset = 0;
  const limit = 5000;

  while (true) {
    const url = `${APPS_SCRIPT_URL}?action=getBrandSlugs&offset=${offset}&limit=${limit}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { redirect: 'follow' });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        allBrands.push(...data.brands);
        console.log(`  [${timestamp()}] offset=${offset}  got=${data.brands.length}  cumulative=${allBrands.length}  total=${data.total}`);

        if (!data.hasMore) return allBrands;
        offset += limit;
        break;                       // success – exit retry loop
      } catch (err) {
        console.error(`  Attempt ${attempt}/${MAX_RETRIES} to fetch slugs failed: ${err.message}`);
        if (attempt === MAX_RETRIES) throw err;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
}

// ── Step 2: Fetch already-processed IDs ──────────────────────────────
async function getProcessedIds() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${APPS_SCRIPT_URL}?action=getProcessedIds`;
      const resp = await fetch(url, { redirect: 'follow' });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      return new Set(data.ids.map(id => String(id)));
    } catch (err) {
      console.error(`  Attempt ${attempt}/${MAX_RETRIES} to fetch processed IDs: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

// ── Step 3: Fetch a single brand page and extract data ──────────────
async function fetchBrandPage(slug) {
  const url = `https://www.talabat.com/uae/${slug}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = await resp.text();
      const match = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s
      );
      if (!match) throw new Error('No __NEXT_DATA__');

      const nextData = JSON.parse(match[1]);
      const pd       = nextData?.props?.pageProps?.data;
      const gtm      = nextData?.props?.pageProps?.gtmEventData;
      const selling   = nextData?.props?.pageProps?.mostSellingItems || [];

      if (!pd) throw new Error('No pageProps.data');

      return {
        id:               pd.id ?? '',
        name:             pd.name || '',
        slug:             pd.branchSlug || pd.restaurantSlug || slug,
        cuisines:         pd.cuisineString || '',
        rating:           pd.rate ?? '',
        totalRatings:     pd.totalRatings ?? 0,
        latitude:         pd.latitude || '',
        longitude:        pd.longitude || '',
        acceptCash:       pd.acceptCash ?? false,
        acceptCreditCard: pd.acceptCreditCard ?? false,
        acceptDebitCard:  pd.acceptDebitCard ?? false,
        paymentMethods:   (pd.availablePaymentMethods || [])
                            .map(p => (p.text || '').replace('common:', '').replace('.translation', ''))
                            .join(', '),
        verticalType:     pd.verticalType ?? '',
        vendorId:         pd.vendorId ?? '',
        groupId:          pd.groupId ?? '',
        countryId:        pd.countryId ?? '',
        chainShops:       gtm?.chainShops ?? '',
        isMigratedToDh:   pd.IsMigratedToDh ?? false,
        logo:             pd.logo || '',
        bestSellingItems: selling.map(i => i.name).join(', '),
        brandPageUrl:     `https://www.talabat.com/uae/${slug}`,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw new Error(`${slug}: ${err.message}`);
      }
    }
  }
}

// ── Step 4: POST a batch to Apps Script ──────────────────────────────
async function postBrandInfo(brands) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'brandInfo', brands }),
        redirect: 'follow',
      });

      const text = await resp.text();
      let result;
      try { result = JSON.parse(text); } catch { result = { raw: text }; }
      if (result.error) throw new Error(result.error);
      return result;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.error(`  POST attempt ${attempt}: ${err.message}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ── Main processing loop ─────────────────────────────────────────────
async function processBrands(brands) {
  let completed = 0;
  let errors    = 0;
  let posted    = 0;
  let batch     = [];

  for (let i = 0; i < brands.length; i += CONCURRENCY) {
    const chunk = brands.slice(i, i + CONCURRENCY);

    // Fetch pages concurrently (staggered slightly)
    const results = await Promise.allSettled(
      chunk.map((b, idx) =>
        sleep(idx * 200).then(() => fetchBrandPage(b.slug))
      )
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        batch.push(r.value);
        completed++;

        // Flush when batch is full
        if (batch.length >= BATCH_SIZE) {
          posted++;
          try {
            await postBrandInfo(batch);
            console.log(`  [${timestamp()}] Batch #${posted}: sent ${batch.length} brands  (${completed}/${brands.length} fetched, ${errors} errors)`);
          } catch (err) {
            console.error(`  Batch #${posted} FAILED: ${err.message}`);
            // Don't count these as errors – we lost them, but keep going
          }
          batch = [];
          await sleep(POST_DELAY_MS);
        }
      } else {
        errors++;
        console.error(`  SKIP: ${r.reason?.message}`);
      }
    }

    // Progress heartbeat every 100 brands
    if ((completed + errors) % 100 < CONCURRENCY) {
      const pct = (((completed + errors) / brands.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
      const rate = ((completed + errors) / (Date.now() - globalStart) * 60000).toFixed(0);
      console.log(`\n  ── Progress: ${completed + errors}/${brands.length} (${pct}%) │ ${elapsed} min │ ~${rate}/min │ ${errors} errors ──\n`);
    }

    await sleep(FETCH_DELAY_MS);
  }

  // Flush remaining
  if (batch.length > 0) {
    posted++;
    try {
      await postBrandInfo(batch);
      console.log(`  [${timestamp()}] Final batch #${posted}: sent ${batch.length} brands`);
    } catch (err) {
      console.error(`  Final batch FAILED: ${err.message}`);
    }
  }

  return { completed, errors, batches: posted };
}

// ── Entry point ──────────────────────────────────────────────────────
let globalStart;

async function main() {
  if (!APPS_SCRIPT_URL) {
    console.error('ERROR: APPS_SCRIPT_URL environment variable is not set.');
    process.exit(1);
  }

  globalStart = Date.now();
  console.log('=== Talabat Brand Page Scraper · Phase 2 ===');
  console.log(`Concurrency : ${CONCURRENCY}`);
  console.log(`Batch size  : ${BATCH_SIZE} brands per POST`);
  console.log(`Started at  : ${new Date().toISOString()}`);
  console.log('');

  // 1 ─ Get brand slugs
  console.log('Step 1 · Fetching brand slugs from directory sheet …');
  const allBrands = await getAllBrandSlugs();
  console.log(`  ✓ ${allBrands.length} brands with valid slugs\n`);

  // 2 ─ Get already-processed IDs (for resumption)
  console.log('Step 2 · Checking already-processed brands …');
  const processedIds = await getProcessedIds();
  console.log(`  ✓ ${processedIds.size} brands already done\n`);

  // 3 ─ Filter
  const remaining = allBrands.filter(b => !processedIds.has(String(b.id)));
  console.log(`  → ${remaining.length} brands remaining to process\n`);

  if (remaining.length === 0) {
    console.log('All brands already processed. Nothing to do.');
    return;
  }

  // 4 ─ Scrape & post
  console.log(`Step 3 · Scraping ${remaining.length} brand pages …\n`);
  const { completed, errors, batches } = await processBrands(remaining);

  const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log('\n=== Phase 2 Complete ===');
  console.log(`Brands fetched : ${completed}`);
  console.log(`Errors / skips : ${errors}`);
  console.log(`Batches posted : ${batches}`);
  console.log(`Wall time      : ${elapsed} minutes`);

  if (errors > 0) {
    console.log(`\nNote: ${errors} brands were skipped due to errors.`);
    console.log('Re-run this workflow to retry them (resumption is automatic).');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
