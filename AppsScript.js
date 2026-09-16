/**
 * Google Apps Script - Talabat Brand Directory Sheet Writer
 * 
 * Deploy as web app (Execute as: Me, Access: Anyone)
 * Set the deployed URL as APPS_SCRIPT_URL secret in the GitHub repo.
 * 
 * Receives POST requests with brand data from the GitHub Actions scraper
 * and appends rows to the "List of Brand Directory" sheet.
 * 
 * Expected POST body:
 * {
 *   "pageNum": 1,
 *   "brands": [
 *     { "id": "123", "name": "Brand Name", "slug": "brand-name", "cuisines": "Pizza, Burgers", "logo": "https://...", "brandPageUrl": "https://..." }
 *   ]
 * }
 */

// Sheet configuration
const SHEET_NAME = 'List of Brand Directory';
const HEADERS = ['id', 'name', 'slug', 'cuisines', 'logo', 'brandPageUrl'];

/**
 * Handle POST requests from the GitHub Actions scraper
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const pageNum = data.pageNum;
    const brands = data.brands;

    if (!brands || !Array.isArray(brands) || brands.length === 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'No brands data provided' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: `Sheet "${SHEET_NAME}" not found` }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Build rows array
    const rows = brands.map(brand => [
      brand.id || '',
      brand.name || '',
      brand.slug || '',
      brand.cuisines || '',
      brand.logo || '',
      brand.brandPageUrl || ''
    ]);

    // Append all rows from this page at once
    const lastRow = sheet.getLastRow();
    const startRow = lastRow + 1;
    sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);

    // Log for debugging
    console.log(`Page ${pageNum}: Wrote ${rows.length} brands (rows ${startRow}-${startRow + rows.length - 1})`);

    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        pageNum: pageNum,
        rowsWritten: rows.length,
        startRow: startRow,
        endRow: startRow + rows.length - 1
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error('doPost error:', err.toString());
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handle GET requests (for testing the deployment)
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'ok',
      message: 'Talabat Brand Directory Sheet Writer is running',
      sheet: SHEET_NAME,
      headers: HEADERS
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Utility: Clear all data rows (keep headers) - run manually if needed
 */
function clearData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
    console.log(`Cleared ${lastRow - 1} data rows`);
  }
  }
