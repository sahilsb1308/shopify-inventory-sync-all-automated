#!/usr/bin/env node
/**
 * shopify_orders.js
 *
 * Replicates two Shopify Analytics reports and writes results to Google Sheets:
 *
 *   "Total Sales by Product"       (last 30 days)
 *     Column J  ←  Net Items Sold   (qty sold − qty refunded)
 *     Column M  ←  Gross Sales      (price × qty, before discounts)
 *
 *   "Month End Inventory Snapshot"
 *     Column F  ←  Ending Inventory Units  (current stock from variants)
 *
 * SKUs matched from Column B of "Inventory Dashboard" tab, row 2 onward.
 *
 * Usage (PowerShell):
 *   $env:SHOPIFY_STORE="swiss-beauty-dev.myshopify.com"
 *   $env:SHOPIFY_ACCESS_TOKEN="shpat_xxx"
 *   node shopify_orders.js
 *
 *   --dry-run   compute and print results without writing to Sheets
 */

"use strict";

const https  = require("https");
const fs     = require("fs");
const crypto = require("crypto");

// ─── Shopify config ──────────────────────────────────────────────────────────
const SHOPIFY_STORE        = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION          = "2023-10";
const PAGE_LIMIT           = 250;

// ─── Google Sheets config ────────────────────────────────────────────────────
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "service_account.json";
const SHEET_ID             = process.env.GOOGLE_SHEET_ID || "1Y2EaDjGfMwscmpn9h7oR_mTOSVxErqWHeowftX01KdI";
const SHEET_TAB            = "Inventory Dashboard";
// SHEET_GID looked up dynamically in appendNewProductRows — do not hardcode
const NPD_FLAG_COL         = "AE";  // Column in Inventory Dashboard to mark NPD = 1

// ─── D2C all-automated sheet (Mother WH stock column AF) ─────────────────────
const D2C_SHEET_ID         = "1ILrx79KdCV1-RDdwQPrrGsGyKe4s2698r3Mwcu9L18M";
const D2C_TAB              = "Inventory Dashboard";
const D2C_TAB_GID          = 599219316;
const D2C_KITS_TAB         = "Kits - Child SKUs";
const MOTHER_WH_SRC_ID     = "1daV5kSvAf19z0LqZ9PKT2Vbae5rhULmi8qcNUEqAL4I";
const MOTHER_WH_SRC_TAB    = "Inventory Dashboard";
const MOTHER_WH_SRC_START  = 5;   // source data starts at row 5
const MOTHER_WH_COL        = "AF";

// ─── NPD Allocation sheet (separate spreadsheet) ─────────────────────────────
const NPD_SHEET_ID  = "1Ubwo5ElTn4AH1zIWqZUOsjhvo-SZ_t_i2dZkCLOaKHw";
const NPD_TABS      = [
  { name: "SB",                   skuCol: "D" },
  { name: "Select ",               skuCol: "C" },
  { name: "Craze",                skuCol: "D" },
  { name: "Skincare & Fragrance", skuCol: "D" },
];

const SKU_COL              = "B";
const RTO_STOCK_COL        = "I";   // RTO Stock
const INWARD_STOCK_COL     = "J";   // Inward Stock
const UNITS_COL            = "K";   // Net Items Sold
const OOS_DAYS_COL         = "L";   // OOS Days (priority-based: P0/P1 ≤5, P2 ≤1, P3 =0)
const MULTIPLIER_COL       = "M";   // Revenue Multiplier
const REVENUE_COL          = "N";   // Gross Sales
const BESTSELLER_COL       = "R";   // Bestseller flag (1 if N ≥ median N)
const LAST_MONTH_PROJ_COL  = "S";   // Last Month's Projection
const TOTAL_STOCK_COL      = "T";   // Total Available Stock = G + I + J
const DRR_COL              = "U";   // Daily Run Rate = K / (30 − OOS Days)
const DOI_COL              = "V";   // Days of Inventory = G / U
const DEMAND_7D_COL        = "W";   // Projected Demand 7d
const DEMAND_COL           = "X";   // Projected Demand 30d
const PROJ_REV_COL         = "Y";   // Projected Revenue 30d
const STOCK_STATUS_COL     = "Z";   // Stock Status (output)
const PRIORITY_COL         = "AA";  // Priority P0–P3 (output)
const REV_CONTRIB_COL      = "AB";  // Revenue Contribution %
const FILL_RATE_COL        = "AC";  // Fill Rate = (K + G) / S
const UNITS_TO_FILL_COL    = "AD";  // Units to be Filled = MAX(0, X − G)
const STOCK_COL            = "G";   // Ending Inventory Units
const DATA_START_ROW       = 2;

// ─── Date range ──────────────────────────────────────────────────────────────
const D30_AGO_ISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

// ─── Robust SKU matching ─────────────────────────────────────────────────────
// Splits SKU into parts by dash/space/brackets and matches part-by-part.
// e.g. "SB-CB153-V" matches "SB-CB153" (sheet has extra -V suffix)
// e.g. "SB-CB14-PHY" matches "SB-CB14"
// Picks the LONGEST (most specific) Shopify SKU that is a part-prefix of the sheet SKU.

function skuParts(sku) {
  return sku
    .toUpperCase()
    .replace(/[\(\)\[\]\/\+\.,:;]/g, "")  // strip special chars (incl. comma, colon, semicolon)
    .replace(/\s*-\s*/g, "-")              // normalise spaces around dashes before splitting
    .split(/[-\s]+/)
    .map(p => p.replace(/[^A-Z0-9]/g, "")) // strip any leftover non-alphanumeric per part
    .filter(Boolean);
}

/**
 * Given a sheet SKU and a Set of all Shopify SKUs,
 * returns the best matching Shopify SKU or null if none found.
 *
 * Matching rules (in priority order):
 *  1. Exact match (normalized)
 *  2. All parts of Shopify SKU match the leading parts of sheet SKU
 *     e.g. sheet=["SB","CB153","V"] shopify=["SB","CB153"] → match
 *  3. Among multiple candidates, prefer the longest (most specific) match
 */
function findBestSkuMatch(sheetSku, shopifySkuArray) {
  const sheetParts = skuParts(sheetSku);

  let bestMatch     = null;
  let bestPartCount = 0;

  for (const shopifySku of shopifySkuArray) {
    const shopifyParts = skuParts(shopifySku);

    // Shopify SKU can't have more parts than sheet SKU
    if (shopifyParts.length > sheetParts.length) continue;

    // Every shopify part must equal the corresponding sheet part
    const isPrefix = shopifyParts.every((p, i) => p === sheetParts[i]);
    if (!isPrefix) continue;

    // Prefer longer (more specific) match
    if (shopifyParts.length > bestPartCount) {
      bestMatch     = shopifySku;
      bestPartCount = shopifyParts.length;
    }
  }

  return bestMatch;
}

/**
 * Builds a translation map: sheet SKU → best matching Shopify SKU (or null).
 * Runs once after both stockMap and salesMap are fetched.
 */
function buildSkuTranslationMap(sheetSkus, stockMap, salesMap) {
  const allShopifySkus = [...new Set([...Object.keys(stockMap), ...Object.keys(salesMap)])];
  const translationMap = {};

  let matched   = 0;
  let unmatched = 0;

  for (const sheetSku of sheetSkus) {
    // Exact match first
    if (stockMap[sheetSku] !== undefined || salesMap[sheetSku] !== undefined) {
      translationMap[sheetSku] = sheetSku;
      matched++;
      continue;
    }
    // Fuzzy match
    const best = findBestSkuMatch(sheetSku, allShopifySkus);
    translationMap[sheetSku] = best;
    if (best) matched++; else unmatched++;
  }

  console.log(`  ✓ SKU translation built — ${matched} matched, ${unmatched} unmatched (written as 0)`);
  return translationMap;
}

const DRY_RUN   = process.argv.includes("--dry-run");
const FIND_KITS = process.argv.includes("--find-kits");

// ─── Validation ──────────────────────────────────────────────────────────────
if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.error("ERROR: Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN.");
  process.exit(1);
}
if (!DRY_RUN && !fs.existsSync(SERVICE_ACCOUNT_FILE)) {
  console.error(`ERROR: ${SERVICE_ACCOUNT_FILE} not found.`);
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP helpers
// ═════════════════════════════════════════════════════════════════════════════

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve, reject);
      }
      const buf = [];
      res.on("data", (c) => buf.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers:    res.headers,
        body:       Buffer.concat(buf).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Request timed out")));
  });
}

function httpsRequest(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = Buffer.from(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method,
        headers: { ...headers, "Content-Length": buf.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          statusCode: res.statusCode,
          body:       Buffer.concat(chunks).toString("utf8"),
        }));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withRetry(fn, maxAttempts = 5, baseMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fn();
      if (res?.statusCode === 429) {
        const wait = parseInt(res.headers?.["retry-after"] || "3", 10) * 1000;
        console.warn(`  [rate-limit] 429 — waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (res?.statusCode >= 500) throw new Error(`Server error ${res.statusCode}`);
      return res;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseMs * 2 ** (attempt - 1);
      console.warn(`  [retry] ${err.message} — retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(delay);
    }
  }
}

// ─── Shopify pagination cursor ───────────────────────────────────────────────
function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    if (part.includes('rel="next"')) {
      const m = part.match(/[?&]page_info=([^&>]+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Searches all Shopify variants for SKUs that partially match the kit SKU patterns.
 * Run with --find-kits flag to debug SKU mismatches.
 */
async function findKitSKUsInShopify() {
  console.log("\n🔍 Searching Shopify for kit SKU matches...\n");

  // Extract core patterns from kit SKUs
  const patterns = Object.keys(KIT_SKU_MAP_NORMALIZED).map(sku =>
    sku.replace(/^SB-/, "").replace(/-V$/, "").replace(/-PHY.*$/, "")
  );

  const allVariants = [];
  let pageInfo = null;

  do {
    const params = pageInfo
      ? `?limit=${PAGE_LIMIT}&page_info=${pageInfo}`
      : `?limit=${PAGE_LIMIT}&fields=id,sku,title`;

    const res = await shopifyGet("/variants.json", params);
    if (res.statusCode !== 200) break;

    const variants = JSON.parse(res.body).variants ?? [];
    allVariants.push(...variants.filter(v => v.sku?.trim()));
    pageInfo = extractNextPageInfo(res.headers["link"]);
    if (pageInfo) await sleep(500);
  } while (pageInfo !== null);

  // For each kit SKU, find closest matches in Shopify
  for (const kitSku of Object.keys(KIT_SKU_MAP_NORMALIZED)) {
    const pattern = kitSku.replace(/^SB-/, "").replace(/-V$/, "");
    const matches = allVariants.filter(v =>
      v.sku.toUpperCase().includes(pattern) || pattern.includes(v.sku.replace(/^SB-/i,"").toUpperCase())
    );
    if (matches.length > 0) {
      console.log(`Sheet SKU: ${kitSku}`);
      matches.forEach(m => console.log(`  → Shopify SKU: "${m.sku}"`));
    } else {
      console.log(`Sheet SKU: ${kitSku} → ❌ No match found in Shopify`);
    }
  }
  process.exit(0);
}

function shopifyGet(path, params = "") {
  const base = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;
  return withRetry(() =>
    httpsGet(`${base}${path}${params}`, { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN })
  );
}

// Normalize SKU for consistent matching.
// Handles: trailing/leading spaces, spaces around dashes ("SB- PERF" → "SB-PERF"),
//          trailing dots ("SB-142-GWP." → "SB-142-GWP"), collapsed internal spaces.
function normalizeSKU(sku) {
  return (sku ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s*-\s*/g, "-")   // "SB- PERF" → "SB-PERF", "SB -CB153" → "SB-CB153"
    .replace(/\s+/g, " ")        // collapse any remaining multi-spaces
    .replace(/\.+$/, "")         // strip trailing dots: "SB-142-GWP." → "SB-142-GWP"
    .trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// Report 1 — "Total Sales by Product"
// Gross Sales  = price × quantity  (before discounts, matches Shopify definition)
// Net Items Sold = quantity sold − quantity refunded
// ═════════════════════════════════════════════════════════════════════════════

async function fetchSalesReport() {
  // salesMap[sku] = { gross_sales, net_items_sold, dailyUnits: { "YYYY-MM-DD": qty } }
  const salesMap  = {};
  let pageInfo    = null;
  let batch       = 0;
  let totalOrders = 0;

  do {
    batch++;
    const params = pageInfo
      ? `?limit=${PAGE_LIMIT}&page_info=${pageInfo}`
      : `?limit=${PAGE_LIMIT}&status=any&created_at_min=${encodeURIComponent(D30_AGO_ISO)}`;

    const res = await shopifyGet("/orders.json", params);
    if (res.statusCode !== 200) {
      throw new Error(`Orders API error ${res.statusCode}: ${res.body.slice(0, 300)}`);
    }

    const orders = JSON.parse(res.body).orders ?? [];
    totalOrders += orders.length;

    for (const order of orders) {
      // Date string of the order e.g. "2026-03-25"
      const orderDate = order.created_at.slice(0, 10);

      // Build refunded-qty map: line_item_id → total qty refunded
      const refundedQty = {};
      for (const refund of order.refunds ?? []) {
        for (const rli of refund.refund_line_items ?? []) {
          refundedQty[rli.line_item_id] = (refundedQty[rli.line_item_id] || 0) + (rli.quantity || 0);
        }
      }

      for (const item of order.line_items ?? []) {
        const sku        = item.sku ? normalizeSKU(item.sku) : `NO_SKU__variant_${item.variant_id ?? "unknown"}`;
        const qty        = Number(item.quantity) || 0;
        const grossSales = (parseFloat(item.price) || 0) * qty;
        const netQty     = qty - (refundedQty[item.id] || 0);

        if (!salesMap[sku]) salesMap[sku] = { gross_sales: 0, net_items_sold: 0, dailyUnits: {}, productTitle: "" };
        // Capture product name from line item (only once per SKU)
        if (!salesMap[sku].productTitle && item.title) {
          const vt = (item.variant_title || "").trim();
          salesMap[sku].productTitle = (vt && vt.toLowerCase() !== "default title")
            ? `${item.title} - ${vt}` : item.title;
        }
        salesMap[sku].gross_sales    += grossSales;
        salesMap[sku].net_items_sold += netQty;

        // Accumulate daily units for OOS days calculation (gross qty ordered, not net — matches
        // Shopify Analytics "Quantity Ordered" metric so refunds on later dates don't unfairly
        // make a day look OOS)
        salesMap[sku].dailyUnits[orderDate] = (salesMap[sku].dailyUnits[orderDate] || 0) + qty;
      }
    }

    console.log(`  Batch ${String(batch).padStart(3)}: ${String(orders.length).padStart(3)} orders  (total: ${totalOrders})`);
    pageInfo = extractNextPageInfo(res.headers["link"]);
    if (pageInfo) await sleep(500);
  } while (pageInfo !== null);

  // OOS days are computed later in writeToSheet() using per-SKU priority thresholds.
  // dailyUnits is kept in salesMap for that calculation.

  console.log(`  ✓ ${totalOrders} orders processed → ${Object.keys(salesMap).length} unique SKUs`);
  return salesMap;
}

// ═════════════════════════════════════════════════════════════════════════════
// Report 2 — "Month End Inventory Snapshot"
// Fetches ALL products across active + archived + draft statuses so no SKU
// is missed. Ending Inventory Units = variant.inventory_quantity.
// ═════════════════════════════════════════════════════════════════════════════

async function fetchProductsByStatus(status, stockMap, productNameMap) {
  let pageInfo      = null;
  let batch         = 0;
  let totalProducts = 0;

  do {
    batch++;
    const params = pageInfo
      ? `?limit=${PAGE_LIMIT}&page_info=${pageInfo}`
      : `?limit=${PAGE_LIMIT}&status=${status}&fields=id,status,title,variants`;

    const res = await shopifyGet("/products.json", params);
    if (res.statusCode !== 200) {
      throw new Error(`Products API [${status}] error ${res.statusCode}: ${res.body.slice(0, 300)}`);
    }

    const products = JSON.parse(res.body).products ?? [];
    totalProducts += products.length;

    for (const product of products) {
      for (const variant of product.variants ?? []) {
        if (!variant.sku?.trim()) continue;
        const sku = normalizeSKU(variant.sku);
        stockMap[sku] = (stockMap[sku] || 0) + (Number(variant.inventory_quantity) || 0);
        // Capture product name from inventory (more reliable than order line items)
        if (!productNameMap[sku]) {
          const vt = (variant.title || "").trim();
          productNameMap[sku] = (vt && vt.toLowerCase() !== "default title")
            ? `${product.title} - ${vt}` : product.title;
        }
      }
    }

    console.log(`  [${status}] Batch ${String(batch).padStart(3)}: ${String(products.length).padStart(3)} products  (total: ${totalProducts})`);
    pageInfo = extractNextPageInfo(res.headers["link"]);
    if (pageInfo) await sleep(500);
  } while (pageInfo !== null);

  return totalProducts;
}

async function fetchInventoryReport() {
  const stockMap      = {};
  const productNameMap = {};

  // Fetch all three statuses — Shopify only returns active by default
  const active   = await fetchProductsByStatus("active",   stockMap, productNameMap);
  const archived = await fetchProductsByStatus("archived", stockMap, productNameMap);
  const draft    = await fetchProductsByStatus("draft",    stockMap, productNameMap);

  const total = active + archived + draft;
  console.log(`  ✓ ${total} total products (${active} active, ${archived} archived, ${draft} draft) → ${Object.keys(stockMap).length} unique SKUs`);
  return { stockMap, productNameMap };
}

// ─── New-product detection ───────────────────────────────────────────────────
/**
 * Finds every Shopify SKU that:
 *  1. Appears in salesMap  →  meaning it sold at least once in the last 30 days
 *     (salesMap is built entirely from orders in the 30-day fetch window,
 *      so every key in it had sales by definition — no date re-check needed)
 *  2. Is NOT already covered by any sheet row (exact or fuzzy match)
 *
 * These are the products we want to append as new rows so they get
 * updated on every future run.
 */
function findNewUnmatchedSkus(salesMap, skuTranslation) {
  // Build the set of Shopify SKUs already mapped to a sheet row
  const coveredShopifySkus = new Set(Object.values(skuTranslation).filter(Boolean));

  const newSkus    = [];
  const skippedLog = [];

  for (const sku of Object.keys(salesMap)) {
    if (sku.startsWith("NO_SKU__")) continue;            // variant had no SKU in Shopify
    if (coveredShopifySkus.has(sku)) {
      skippedLog.push(sku);
      continue;                                          // already in sheet
    }
    newSkus.push(sku);
  }

  console.log(`  Total sold SKUs in last 30D : ${Object.keys(salesMap).length}`);
  console.log(`  Already matched to sheet    : ${skippedLog.length}`);
  console.log(`  New (not in sheet)          : ${newSkus.length}`);
  return newSkus;
}

/**
 * Appends one new row per unmatched SKU directly after the last existing data row.
 *
 * Uses an explicit range (e.g. "Inventory Dashboard!B1209:N1215") so there is
 * zero ambiguity about which column the data lands in — no table-detection
 * guesswork from the Sheets API.
 *
 * Column layout written (0-based index inside the B…N window):
 *   B=0  C=1  D=2  E=3  F=4  G=5  H=6  I=7  J=8  K=9  L=10  M=11  N=12
 *   SKU  Name  -    -    -   Stock  -    -    -  Sold  OOS   -    Revenue
 */
async function appendNewProductRows(token, newSkus, salesMap, stockMap, productNameMap, lastExistingRow) {
  if (newSkus.length === 0) return;

  const startRow = lastExistingRow + 1;

  // Build one data array per column (same pattern as writeToSheet which works reliably)
  // We write only the columns we own: B, C, G, K, L, N, U
  // Each column gets its own range + values array in the batchUpdate call.
  const colB = [], colC = [], colG = [], colK = [], colL = [], colN = [], colU = [];

  newSkus.forEach((sku) => {
    const sales = salesMap[sku];
    const stock = stockMap[sku] ?? 0;
    const name  = productNameMap[sku] || sales?.productTitle || "";
    colB.push([sku]);
    colC.push([name]);
    colG.push([stock]);
    // New products have no priority yet → use P3 threshold (sold > 0)
    const newOosDays  = sales?.dailyUnits ? calcOosDays(sales.dailyUnits, 0) : 30;
    const netSold     = sales?.net_items_sold ?? 0;
    colK.push([netSold]);
    colL.push([newOosDays]);
    colN.push([parseFloat((sales?.gross_sales ?? 0).toFixed(2))]);
    colU.push([calcDrr(netSold, newOosDays) ?? ""]);
  });

  const endRow = startRow + newSkus.length - 1;

  // Validate: catch any non-string/number values that would cause a 400
  colB.forEach(([v], i) => { if (typeof v !== "string") console.warn(`  ⚠ colB[${i}] not a string:`, v); });
  colG.forEach(([v], i) => { if (typeof v !== "number") console.warn(`  ⚠ colG[${i}] not a number:`, v); });
  colK.forEach(([v], i) => { if (typeof v !== "number") console.warn(`  ⚠ colK[${i}] not a number:`, v); });
  colL.forEach(([v], i) => { if (typeof v !== "number") console.warn(`  ⚠ colL[${i}] not a number:`, v); });
  colN.forEach(([v], i) => { if (typeof v !== "number") console.warn(`  ⚠ colN[${i}] not a number:`, v); });

  // Log exactly what is being written and where
  console.log(`\n  Writing ${newSkus.length} new rows:`);
  console.log(`    B${startRow}:B${endRow}  → SKU`);
  console.log(`    C${startRow}:C${endRow}  → Product Name`);
  console.log(`    G${startRow}:G${endRow}  → Current Stock`);
  console.log(`    K${startRow}:K${endRow}  → Net Items Sold`);
  console.log(`    L${startRow}:L${endRow}  → OOS Days`);
  console.log(`    N${startRow}:N${endRow}  → Revenue`);
  console.log(`    U${startRow}:U${endRow}  → DRR`);

  // Look up the real numeric sheetId for SHEET_TAB (can't hardcode — differs per file)
  const metaRes = await httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,
    { Authorization: `Bearer ${token}` }
  );
  if (metaRes.statusCode !== 200) throw new Error(`Sheets metadata error ${metaRes.statusCode}`);
  const sheets   = JSON.parse(metaRes.body).sheets ?? [];
  const sheetMeta = sheets.find(s => s.properties?.title === SHEET_TAB);
  if (!sheetMeta) throw new Error(`Tab "${SHEET_TAB}" not found in spreadsheet`);
  const sheetGid = sheetMeta.properties.sheetId;
  console.log(`  Tab "${SHEET_TAB}" has sheetId: ${sheetGid}`);

  // Extend the sheet grid so rows startRow–endRow exist
  const rowsToAdd = newSkus.length + 100;
  console.log(`  Extending sheet: adding ${rowsToAdd} rows...`);
  const extRes = await httpsRequest(
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    JSON.stringify({
      requests: [{
        appendDimension: {
          sheetId:   sheetGid,
          dimension: "ROWS",
          length:    rowsToAdd
        }
      }]
    }),
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  );
  if (extRes.statusCode !== 200) {
    throw new Error(`appendDimension failed ${extRes.statusCode}: ${extRes.body.replace(/\s+/g, " ")}`);
  }
  console.log(`  ✓ Sheet extended by ${rowsToAdd} rows`);

  const res = await withRetry(() =>
    httpsRequest(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      JSON.stringify({
        valueInputOption: "RAW",
        data: [
          { range: `${SHEET_TAB}!B${startRow}:B${endRow}`, values: colB },
          { range: `${SHEET_TAB}!C${startRow}:C${endRow}`, values: colC },
          { range: `${SHEET_TAB}!G${startRow}:G${endRow}`, values: colG },
          { range: `${SHEET_TAB}!K${startRow}:K${endRow}`, values: colK },
          { range: `${SHEET_TAB}!L${startRow}:L${endRow}`, values: colL },
          { range: `${SHEET_TAB}!N${startRow}:N${endRow}`, values: colN },
          { range: `${SHEET_TAB}!U${startRow}:U${endRow}`, values: colU },
        ]
      }),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    )
  );

  if (res.statusCode !== 200) throw new Error(`Sheets append error ${res.statusCode}: ${res.body.replace(/\s+/g, " ")}`);

  console.log(`\n✓ Appended ${newSkus.length} new product row(s) starting at row ${startRow}:`);
  newSkus.forEach((sku) => {
    const name = productNameMap[sku] || salesMap[sku]?.productTitle || "";
    console.log(`  + ${sku}${name ? `  →  ${name}` : ""}`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Google Sheets
// ═════════════════════════════════════════════════════════════════════════════

async function getGoogleAccessToken() {
  const sa  = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const pay = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })).toString("base64url");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${hdr}.${pay}`);
  const jwt = `${hdr}.${pay}.${signer.sign(sa.private_key, "base64url")}`;

  const res  = await httpsRequest(
    "POST", "https://oauth2.googleapis.com/token",
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error(`Google auth failed: ${res.body}`);
  return data.access_token;
}

async function readSheetSKUs(token) {
  // Read col B (SKU) and col AA (Priority) in parallel
  const urlB  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${SHEET_TAB}!${SKU_COL}${DATA_START_ROW}:${SKU_COL}`)}`;
  const urlAA = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${SHEET_TAB}!AA${DATA_START_ROW}:AA`)}`;

  const [resB, resAA] = await Promise.all([
    withRetry(() => httpsGet(urlB,  { Authorization: `Bearer ${token}` })),
    withRetry(() => httpsGet(urlAA, { Authorization: `Bearer ${token}` })),
  ]);

  if (resB.statusCode !== 200) throw new Error(`Sheets read error ${resB.statusCode}: ${resB.body}`);

  const skuValues = JSON.parse(resB.body).values ?? [];
  const aaValues  = resAA.statusCode === 200 ? (JSON.parse(resAA.body).values ?? []) : [];

  return skuValues
    .map((row, i) => ({
      sku:      normalizeSKU(row[0] ?? ""),
      row:      DATA_START_ROW + i,
      priority: (aaValues[i]?.[0] ?? "").toString().trim().toUpperCase(),
    }))
    .filter((r) => r.sku !== "");
}

// ─── OOS days helpers ─────────────────────────────────────────────────────────
// Threshold = minimum daily units needed to NOT count as an OOS day.
// A day is OOS if sold <= threshold.
//   P0 / P1 → threshold 5  (need > 5 sold to be "in stock")
//   P2      → threshold 1  (need > 1 sold)
//   P3 / ?  → threshold 0  (any non-zero sale is enough)
function oosThreshold(priority) {
  if (priority === "P0" || priority === "P1") return 5;
  if (priority === "P2")                      return 1;
  return 0; // P3 or unknown
}

function calcOosDays(dailyUnits, threshold) {
  const startDate = new Date(D30_AGO_ISO);
  let oosDays = 0;
  for (let i = 0; i < 30; i++) {
    const d   = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key  = d.toISOString().slice(0, 10);
    const sold = dailyUnits[key] || 0;
    if (sold <= threshold) oosDays++;
  }
  return oosDays;
}

// DRR = Net Sold / (30 − OOS Days).  Returns null when always-OOS (no available days).
function calcDrr(netSold, oosDays) {
  const available = 30 - oosDays;
  if (available <= 0) return null;
  return Math.round((netSold / available) * 10000) / 10000;
}

function calcStockStatus(doi) {
  if (doi === null || doi === "") return "";
  const v = Number(doi);
  if (v <= 10)  return "Critical";
  if (v <= 40)  return "Low";
  if (v <= 70)  return "Healthy";
  if (v <= 100) return "Overstocked";
  return "Excess";
}

// 50th-percentile median matching Google Sheets PERCENTILE(..., 0.5).
function calcMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function writeToSheet(token, skuRows, salesMap, stockMap, skuTranslation = {}) {
  const lastRow   = skuRows[skuRows.length - 1].row;
  const totalRows = lastRow - DATA_START_ROW + 1;

  const colG = Array.from({ length: totalRows }, () => [""]);
  const colK = Array.from({ length: totalRows }, () => [""]);
  const colL = Array.from({ length: totalRows }, () => [""]);
  const colN = Array.from({ length: totalRows }, () => [""]);
  const colU = Array.from({ length: totalRows }, () => [""]);

  let matchedSales = 0;
  let matchedStock = 0;
  const unmatchedSales = [];
  const unmatchedStock = [];

  for (const { sku, row, priority } of skuRows) {
    const idx        = row - DATA_START_ROW;
    // Use translated Shopify SKU for lookup, fall back to sheet SKU
    const lookupSku  = skuTranslation[sku] ?? sku;
    const sales      = salesMap[lookupSku];
    const stock      = stockMap[lookupSku];

    if (sales !== undefined) {
      const threshold = oosThreshold(priority ?? "");
      const oosDays   = calcOosDays(sales.dailyUnits, threshold);
      colK[idx] = [sales.net_items_sold];
      colL[idx] = [oosDays];
      colN[idx] = [parseFloat(sales.gross_sales.toFixed(2))];
      colU[idx] = [calcDrr(sales.net_items_sold, oosDays) ?? ""];
      matchedSales++;
    } else {
      // No sales in last 30 days → all 30 days are OOS regardless of priority
      colK[idx] = [0];
      colL[idx] = [30];
      colN[idx] = [0];
      colU[idx] = [""];   // always OOS — no DRR
      unmatchedSales.push(sku);
    }

    if (stock !== undefined) {
      colG[idx] = [stock];
      matchedStock++;
    } else {
      colG[idx] = [0];
      unmatchedStock.push(sku);
    }
  }

  const rangeG = `${SHEET_TAB}!${STOCK_COL}${DATA_START_ROW}:${STOCK_COL}${lastRow}`;
  const rangeK = `${SHEET_TAB}!${UNITS_COL}${DATA_START_ROW}:${UNITS_COL}${lastRow}`;
  const rangeL = `${SHEET_TAB}!${OOS_DAYS_COL}${DATA_START_ROW}:${OOS_DAYS_COL}${lastRow}`;
  const rangeN = `${SHEET_TAB}!${REVENUE_COL}${DATA_START_ROW}:${REVENUE_COL}${lastRow}`;
  const rangeU = `${SHEET_TAB}!${DRR_COL}${DATA_START_ROW}:${DRR_COL}${lastRow}`;

  const res = await withRetry(() =>
    httpsRequest(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      JSON.stringify({ valueInputOption: "RAW", data: [
        { range: rangeG, values: colG },
        { range: rangeK, values: colK },
        { range: rangeL, values: colL },
        { range: rangeN, values: colN },
        { range: rangeU, values: colU },
      ]}),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    )
  );

  if (res.statusCode !== 200) throw new Error(`Sheets write error ${res.statusCode}: ${res.body}`);

  const result = JSON.parse(res.body);
  console.log(`\n✓ Sheet updated`);
  console.log(`  Col G (Current Stock)    → ${matchedStock}/${skuRows.length} SKUs matched`);
  console.log(`  Col K (Net Items Sold)   → ${matchedSales}/${skuRows.length} SKUs matched`);
  console.log(`  Col L (OOS Days)         → ${matchedSales}/${skuRows.length} SKUs matched`);
  console.log(`  Col N (Gross Sales)      → ${matchedSales}/${skuRows.length} SKUs matched`);
  console.log(`  Col U (DRR)              → ${matchedSales}/${skuRows.length} SKUs matched`);

  if (unmatchedStock.length > 0) {
    console.log(`\n  ⚠ SKUs not found in Shopify inventory (written as 0):`);
    unmatchedStock.forEach((s) => console.log(`    - ${s}`));
  }
  if (unmatchedSales.length > 0) {
    console.log(`\n  ⚠ SKUs with no sales in last 30 days — OOS days set to 30:`);
    unmatchedSales.forEach((s) => console.log(`    - ${s}`));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NPD Flag — read NPD allocation sheet and mark column AE = 1 in dashboard
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns the NPD matching key for a SKU — everything up to (but not including)
 * the second hyphen.  This lets "SB-B02" in the NPD sheet match "SB-B02-01",
 * "SB-B02-02", etc. in the Inventory Dashboard.
 *
 * Examples:
 *   "SB-B02"      → "SB-B02"   (no second hyphen → keep as-is)
 *   "SB-B02-01"   → "SB-B02"
 *   "SB-CB153-V"  → "SB-CB153"
 */
function npdPrefix(sku) {
  const s          = normalizeSKU(sku);
  const firstDash  = s.indexOf("-");
  if (firstDash === -1) return s;
  const secondDash = s.indexOf("-", firstDash + 1);
  return secondDash === -1 ? s : s.slice(0, secondDash);
}

/**
 * Reads product codes from all NPD allocation tabs and returns a Set of
 * normalised SKU prefixes (up to second hyphen) that are in the NPD pipeline.
 */
async function fetchNpdSkus(token) {
  const npdSkus = new Set();
  for (const { name, skuCol } of NPD_TABS) {
    const range    = encodeURIComponent(`${name}!${skuCol}:${skuCol}`);
    const url      = `https://sheets.googleapis.com/v4/spreadsheets/${NPD_SHEET_ID}/values/${range}`;
    const res      = await withRetry(() => httpsGet(url, { Authorization: `Bearer ${token}` }));
    if (res.statusCode !== 200) {
      console.warn(`  ⚠ Could not read NPD tab "${name}" (${res.statusCode}) — skipping`);
      continue;
    }
    const values = JSON.parse(res.body).values ?? [];
    let added = 0;
    for (const [cell] of values) {
      if (!cell || cell.trim() === "" || cell.trim().toUpperCase() === "NA" ||
          cell.trim().toUpperCase() === "PRODUCT CODE") continue;
      npdSkus.add(npdPrefix(cell));
      added++;
    }
    console.log(`  Tab "${name}" (col ${skuCol}): ${added} SKUs`);
  }
  return npdSkus;
}

/**
 * Full two-way sync of NPD flags:
 * - SKU in npdSkus but AE != 1  → set 1
 * - SKU not in npdSkus but AE=1 → set 0 (product graduated out of NPD)
 */
async function markNpdFlags(token, skuRows, npdSkus) {
  if (npdSkus.size === 0) { console.log("  No NPD SKUs found — nothing to mark."); return; }

  // Read current AE values for all rows
  const lastRow   = skuRows[skuRows.length - 1].row;
  const readRange = encodeURIComponent(`${SHEET_TAB}!${NPD_FLAG_COL}${DATA_START_ROW}:${NPD_FLAG_COL}${lastRow}`);
  const readRes   = await withRetry(() =>
    httpsGet(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${readRange}`,
      { Authorization: `Bearer ${token}` })
  );
  const existing = JSON.parse(readRes.body).values ?? [];

  const writeData = [];
  let setTo1 = 0, setTo0 = 0, unchanged = 0;

  for (const { row, sku } of skuRows) {
    const idx        = row - DATA_START_ROW;
    const current    = parseFloat((existing[idx]?.[0] ?? "").toString().trim()) || 0;
    const isNpd      = npdSkus.has(npdPrefix(sku));

    if (isNpd && current !== 1) {
      writeData.push({ range: `${SHEET_TAB}!${NPD_FLAG_COL}${row}`, values: [[1]] });
      setTo1++;
    } else if (!isNpd && current === 1) {
      writeData.push({ range: `${SHEET_TAB}!${NPD_FLAG_COL}${row}`, values: [[""]] });
      setTo0++;
    } else {
      unchanged++;
    }
  }

  console.log(`  → Set to 1 (new NPD)     : ${setTo1}`);
  console.log(`  → Cleared (removed NPD)  : ${setTo0}`);
  console.log(`  → Unchanged              : ${unchanged}`);

  if (writeData.length === 0) { console.log("  ✓ All flags already in sync."); return; }

  const res = await withRetry(() =>
    httpsRequest(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      JSON.stringify({ valueInputOption: "USER_ENTERED", data: writeData }),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    )
  );
  if (res.statusCode !== 200) throw new Error(`NPD flag write error ${res.statusCode}: ${res.body.replace(/\s+/g, " ")}`);
  console.log(`  ✓ NPD flags synced — ${setTo1} set to 1, ${setTo0} cleared to blank`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Projected Demand  (Column X)
// Mirrors exactly:
//   =IF(AND(U="",COUNTIF(Kits!D:D,B)=0), "",
//      (U*30 + MMULT(child_match, INDEX(K,MATCH(kit_prefix,dashboard_prefix,0)))) *
//      MAX(IF(O="NPD",1.8,0), IF(Q=1,1.5,0), IF(R=1,1.2,0),
//          IF(P0,1.5, IF(P1,1.3, IF(P2,1.2, IF(P3,1.1, 1)))))
//   )
// ═════════════════════════════════════════════════════════════════════════════

function skuPrefix(sku) {
  // "SB-K01-01" → "SB-K01"  (first two hyphen-segments, mirrors FIND second-dash logic)
  const parts = sku.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : sku;
}

function demandMultiplier(priority, npd, npdFlag, promoQ, promoR) {
  const candidates = [];
  if (Number(npdFlag) === 1) candidates.push(6);                          // col AE = 1 → NPD flag
  if ((npd ?? "").trim().toUpperCase() === "NPD") candidates.push(1.8);  // col O = "NPD" text
  if (Number(promoQ) === 1) candidates.push(1.5);
  if (Number(promoR) === 1) candidates.push(1.2);
  // Priority — default 1 when none of P0/P1/P2/P3 match (mirrors formula's final IF(...,1))
  const pMap = { P0: 1.5, P1: 1.3, P2: 1.2, P3: 1.1 };
  candidates.push(pMap[(priority ?? "").trim().toUpperCase()] ?? 1);
  return Math.max(...candidates);
}

async function readKitsSheet(token) {
  // Read col B (parent kit SKU) and col D (child SKU) from Kits sheet in one batchGet
  const rangeB = encodeURIComponent(`'Kits - Child SKUs'!B2:B500`);
  const rangeD = encodeURIComponent(`'Kits - Child SKUs'!D2:D500`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?ranges=${rangeB}&ranges=${rangeD}`;

  const res = await withRetry(() => httpsGet(url, { Authorization: `Bearer ${token}` }));
  if (res.statusCode !== 200) throw new Error(`Kits sheet read error ${res.statusCode}: ${res.body}`);

  const [bRange, dRange] = JSON.parse(res.body).valueRanges ?? [];
  const kitSkus   = (bRange?.values ?? []).map(r => normalizeSKU(r[0] ?? ""));
  const childSkus = (dRange?.values ?? []).map(r => normalizeSKU(r[0] ?? ""));

  const childToKits   = {};         // childSku → [parentKitSku, ...]
  const kitParentSkus = new Set();  // exact normalized col-B values from kits sheet
  const len = Math.max(kitSkus.length, childSkus.length);

  let lastKitSku = "";
  for (let i = 0; i < len; i++) {
    // Carry forward last non-empty kit SKU to handle merged cells in col B
    if (kitSkus[i]) lastKitSku = kitSkus[i];
    const kitSku   = lastKitSku;
    const childSku = childSkus[i] ?? "";
    if (kitSku)             kitParentSkus.add(kitSku);
    if (kitSku && childSku) (childToKits[childSku] ??= []).push(kitSku);
  }

  return { childToKits, kitParentSkus };
}

async function writeProjectedDemand(token, skuRows, childToKits, kitParentSkus) {
  const lastRow  = skuRows[skuRows.length - 1].row;

  // Batch-read all columns needed for derived calculations
  const ranges = [
    `${SHEET_TAB}!O${DATA_START_ROW}:O${lastRow}`,   // NPD text
    `${SHEET_TAB}!Q${DATA_START_ROW}:Q${lastRow}`,   // Promo Q
    `${SHEET_TAB}!U${DATA_START_ROW}:U${lastRow}`,   // DRR (just written)
    `${SHEET_TAB}!K${DATA_START_ROW}:K${lastRow}`,   // Net Sold (just written)
    `${SHEET_TAB}!AE${DATA_START_ROW}:AE${lastRow}`, // NPD flag
    `${SHEET_TAB}!N${DATA_START_ROW}:N${lastRow}`,   // Gross Sales (just written)
    `${SHEET_TAB}!G${DATA_START_ROW}:G${lastRow}`,   // Current Stock (just written)
    `${SHEET_TAB}!I${DATA_START_ROW}:I${lastRow}`,   // RTO Stock
    `${SHEET_TAB}!J${DATA_START_ROW}:J${lastRow}`,   // Inward Stock
    `${SHEET_TAB}!S${DATA_START_ROW}:S${lastRow}`,   // Last Month's Projection
  ];
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${ranges.map(r => `ranges=${encodeURIComponent(r)}`).join("&")}`;
  const batchRes = await withRetry(() => httpsGet(batchUrl, { Authorization: `Bearer ${token}` }));
  if (batchRes.statusCode !== 200) throw new Error(`Demand cols read error ${batchRes.statusCode}: ${batchRes.body}`);

  const [oVals, qVals, uVals, kVals, aeVals, nVals, gVals, iVals, jVals, sVals] =
    (JSON.parse(batchRes.body).valueRanges ?? []).map(vr => vr.values ?? []);

  // Build SKU → K and prefix → K lookups for kit contribution
  const skuToK    = {};
  const prefixToK = {};
  for (const { sku, row } of skuRows) {
    const i = row - DATA_START_ROW;
    const k = parseFloat((kVals[i]?.[0] ?? "0").replace(/,/g, "")) || 0;
    skuToK[sku] = k;
    const prefix = skuPrefix(sku);
    if (!(prefix in prefixToK)) prefixToK[prefix] = k;
  }

  // Pre-compute total N and median N for bestseller + revenue contribution
  const nNonBlank = skuRows
    .map(({ row }) => { const raw = (nVals[row - DATA_START_ROW]?.[0] ?? "").trim(); return raw !== "" ? parseFloat(raw) || 0 : null; })
    .filter(v => v !== null);
  const totalN  = nNonBlank.reduce((s, v) => s + v, 0);
  const nMedian = calcMedian(nNonBlank);

  const totalRows = lastRow - DATA_START_ROW + 1;
  const colM  = Array.from({ length: totalRows }, () => [0]);
  const colR  = Array.from({ length: totalRows }, () => [0]);
  const colT  = Array.from({ length: totalRows }, () => [0]);
  const colV  = Array.from({ length: totalRows }, () => [0]);
  const colW  = Array.from({ length: totalRows }, () => [""]);
  const colX  = Array.from({ length: totalRows }, () => [""]);
  const colY  = Array.from({ length: totalRows }, () => [0]);
  const colZ  = Array.from({ length: totalRows }, () => [""]);
  const colAA = Array.from({ length: totalRows }, () => ["P3"]);
  const colAB = Array.from({ length: totalRows }, () => [0]);
  const colAC = Array.from({ length: totalRows }, () => [0]);
  const colAD = Array.from({ length: totalRows }, () => [""]);
  const rowState = new Map(); // i → {npdFlag, npd, promoQ, isBestseller} for second pass

  for (const { sku, row, priority } of skuRows) {
    const i       = row - DATA_START_ROW;
    const drrRaw  = (uVals[i]?.[0] ?? "").trim();
    const drr     = drrRaw === "" ? null : (parseFloat(drrRaw) || 0);
    const npd     = (oVals[i]?.[0] ?? "").trim();
    const npdFlag = (aeVals[i]?.[0] ?? "").trim();
    const promoQ  = (qVals[i]?.[0] ?? "").trim();
    const nRaw    = (nVals[i]?.[0] ?? "").trim();
    const gRaw    = (gVals[i]?.[0] ?? "").trim();
    const iRaw    = (iVals[i]?.[0] ?? "").trim();
    const jRaw    = (jVals[i]?.[0] ?? "").trim();
    const sRaw    = (sVals[i]?.[0] ?? "").trim();
    const kVal    = parseFloat((kVals[i]?.[0] ?? "0").replace(/,/g, "")) || 0;
    const nVal    = nRaw !== "" ? parseFloat(nRaw) || 0 : 0;
    const gVal    = gRaw !== "" ? parseFloat(gRaw) || 0 : 0;
    const sVal    = sRaw !== "" ? parseFloat(sRaw) || 0 : 0;
    const isChild = sku in childToKits;

    // Col R — Bestseller: 1 if N ≥ median of all non-blank N values
    const isBestseller = nRaw !== "" && nVal >= nMedian ? 1 : 0;
    colR[i] = [isBestseller];
    rowState.set(i, { npdFlag, npd, promoQ, isBestseller });

    // Col T — Total Available Stock = G + I + J (0 if any blank)
    if (gRaw === "" || iRaw === "" || jRaw === "") {
      colT[i] = [0];
    } else {
      colT[i] = [(parseFloat(gRaw) || 0) + (parseFloat(iRaw) || 0) + (parseFloat(jRaw) || 0)];
    }

    // Col AB — Revenue Contribution %
    const abVal = nRaw !== "" && totalN > 0 ? parseFloat(((nVal / totalN) * 100).toFixed(4)) : 0;
    colAB[i] = [abVal];

    // Col AA — Priority (computed from AE, Q, AB — in that order)
    let computedPriority;
    try {
      if      (abVal > 1)    computedPriority = "P0";
      else if (abVal >= 0.44) computedPriority = "P1";
      else if (abVal >= 0.2)  computedPriority = "P2";
      else                    computedPriority = "P3";
    } catch (_) { computedPriority = "P3"; }
    colAA[i] = [computedPriority];

    // Col M — Revenue Multiplier (uses computedPriority, not stale sheet AA)
    const pMap = { P0: 1.5, P1: 1.3, P2: 1.2, P3: 1.1 };
    const mScore = Math.max(
      Number(npdFlag) === 1           ? 6   : 0,
      npd.toUpperCase() === "NPD"     ? 1.8 : 0,
      Number(promoQ) === 1            ? 1.5 : 0,
      isBestseller === 1              ? 1.2 : 0,
      pMap[computedPriority] ?? 1,
    );
    colM[i] = [mScore];

    // Col AC — Fill Rate = (K + G) / S
    colAC[i] = [sVal > 0 ? parseFloat(((kVal + gVal) / sVal).toFixed(4)) : 0];

    // Col V — Days of Inventory = G / DRR
    const doiVal = drr && drr > 0 && gVal > 0 ? parseFloat((gVal / drr).toFixed(2)) : 0;
    colV[i] = drr !== null ? [doiVal] : [""];

    // Col Z — Stock Status
    colZ[i] = [drr !== null ? calcStockStatus(doiVal) : ""];

    // No DRR and not a kit child → blank demand columns
    if (drr === null && !isChild) { colW[i] = [""]; colX[i] = [""]; colAD[i] = [""]; continue; }

    // Kit parent → only W and X are 0; all other columns already computed above
    const isKitParent = kitParentSkus.has(skuPrefix(sku)) || kitParentSkus.has(sku);
    if (isKitParent) {
      colW[i] = [0]; colX[i] = [0];
      colY[i] = [0]; colAD[i] = [0];
      continue;
    }

    const kitContrib = (childToKits[sku] ?? []).reduce((sum, kitSku) => {
      return sum + (skuToK[kitSku] ?? prefixToK[skuPrefix(kitSku)] ?? 0);
    }, 0);
    const multiplier = mScore;

    const demand7d  = parseFloat((((drr ?? 0) *  7 + kitContrib * 7 / 30) * multiplier).toFixed(2));
    const demand30d = parseFloat((((drr ?? 0) * 30 + kitContrib          ) * multiplier).toFixed(2));
    const asp       = kVal > 0 ? nVal / kVal : 0;

    colW[i]  = [demand7d];
    colX[i]  = [demand30d];
    colY[i]  = [parseFloat((demand30d * asp).toFixed(2))];
    colAD[i] = [Math.max(0, parseFloat((demand30d - gVal).toFixed(2)))];
  }

  // Second pass: promote child SKUs to P0 if any of their parent kits are P0
  {
    const skuPriorityMap = new Map();
    for (const { sku, row } of skuRows) skuPriorityMap.set(sku, colAA[row - DATA_START_ROW][0]);

    const pMap = { P0: 1.5, P1: 1.3, P2: 1.2, P3: 1.1 };
    let promoted = 0;
    for (const { sku, row } of skuRows) {
      const i = row - DATA_START_ROW;
      if (!(sku in childToKits)) continue;
      if (colAA[i][0] === "P0") continue;

      const anyParentP0 = (childToKits[sku] ?? []).some(kitSku => {
        if (skuPriorityMap.get(kitSku) === "P0") return true;
        const pfx = skuPrefix(kitSku);
        for (const [s, pri] of skuPriorityMap) if (skuPrefix(s) === pfx && pri === "P0") return true;
        return false;
      });
      if (!anyParentP0) continue;

      colAA[i] = ["P0"];
      promoted++;

      const { npdFlag, npd, promoQ, isBestseller } = rowState.get(i) ?? {};
      const newM = Math.max(
        Number(npdFlag) === 1               ? 6   : 0,
        (npd ?? "").toUpperCase() === "NPD" ? 1.8 : 0,
        Number(promoQ) === 1                ? 1.5 : 0,
        isBestseller === 1                  ? 1.2 : 0,
        pMap["P0"],
      );
      colM[i] = [newM];

      // Recalculate demand columns with the new multiplier
      const drrRaw2   = (uVals[i]?.[0] ?? "").trim();
      const drr2      = drrRaw2 === "" ? null : (parseFloat(drrRaw2) || 0);
      const gVal2     = parseFloat((gVals[i]?.[0] ?? "0")) || 0;
      const nVal2     = parseFloat((nVals[i]?.[0] ?? "0")) || 0;
      const kVal2     = parseFloat((kVals[i]?.[0] ?? "0").replace(/,/g, "")) || 0;
      const kitContrib2 = (childToKits[sku] ?? []).reduce((sum, kitSku) =>
        sum + (skuToK[kitSku] ?? prefixToK[skuPrefix(kitSku)] ?? 0), 0);
      const demand7d2  = parseFloat((((drr2 ?? 0) *  7 + kitContrib2 * 7 / 30) * newM).toFixed(2));
      const demand30d2 = parseFloat((((drr2 ?? 0) * 30 + kitContrib2          ) * newM).toFixed(2));
      const asp2       = kVal2 > 0 ? nVal2 / kVal2 : 0;
      colW[i]  = [demand7d2];
      colX[i]  = [demand30d2];
      colY[i]  = [parseFloat((demand30d2 * asp2).toFixed(2))];
      colAD[i] = [Math.max(0, parseFloat((demand30d2 - gVal2).toFixed(2)))];
    }
    if (promoted > 0) console.log(`  ✓ Promoted ${promoted} child SKU(s) to P0 via kit parent (demand recalculated)`);
  }

  const make = col => `${SHEET_TAB}!${col}${DATA_START_ROW}:${col}${lastRow}`;
  const res = await withRetry(() =>
    httpsRequest(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      JSON.stringify({ valueInputOption: "RAW", data: [
        { range: make(MULTIPLIER_COL),    values: colM  },
        { range: make(BESTSELLER_COL),    values: colR  },
        { range: make(TOTAL_STOCK_COL),   values: colT  },
        { range: make(DOI_COL),           values: colV  },
        { range: make(DEMAND_7D_COL),     values: colW  },
        { range: make(DEMAND_COL),        values: colX  },
        { range: make(PROJ_REV_COL),      values: colY  },
        { range: make(STOCK_STATUS_COL),  values: colZ  },
        { range: make(PRIORITY_COL),      values: colAA },
        { range: make(REV_CONTRIB_COL),   values: colAB },
        { range: make(FILL_RATE_COL),     values: colAC },
        { range: make(UNITS_TO_FILL_COL), values: colAD },
      ]}),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    )
  );
  if (res.statusCode !== 200) throw new Error(`Derived cols write error ${res.statusCode}: ${res.body}`);
  console.log(`  ✓ Cols M/R/T/V/W/X/Y/Z/AA/AB/AC/AD written for ${skuRows.length} rows`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

// ─── Mother WH stock → D2C sheet AF column ───────────────────────────────────
// Reads source sheet col A (variant SKU) and col V (stock) — one row per variant.
// Exact SKU match only; no prefix/shade-index summing.
// Kit parents get MIN(children stocks). Non-kit rows get their own individual value.
async function writeMotherWHStock(token) {
  const normSku = s => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // 1. Read source sheet A:V (SKU in col A, stock in col V; data starts at MOTHER_WH_SRC_START)
  const srcRes = await withRetry(() => httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${MOTHER_WH_SRC_ID}/values/${encodeURIComponent(`${MOTHER_WH_SRC_TAB}!A${MOTHER_WH_SRC_START}:V`)}`,
    { Authorization: `Bearer ${token}` }
  ));
  if (srcRes.statusCode !== 200) throw new Error(`Source sheet read failed: ${srcRes.statusCode}`);
  const srcRows = JSON.parse(srcRes.body).values ?? [];

  // A=col 0, V=col 21 in the sliced range (A through V = 21 apart)
  const SRC_SKU_IDX = 0, SRC_STK_IDX = 21;

  // Build: normalizedSku → stock (col A has variant-level SKUs, one row per variant)
  const sourceRows = new Map();
  for (const row of srcRows) {
    const sku   = (row[SRC_SKU_IDX] ?? "").trim();
    const stock = Number(row[SRC_STK_IDX] ?? 0) || 0;
    if (!sku) continue;
    const n = normSku(sku);
    if (!n) continue;
    // Keep first occurrence — source has one row per variant SKU
    if (!sourceRows.has(n)) sourceRows.set(n, stock);
  }
  console.log(`  Source: ${srcRows.length} rows → ${sourceRows.size} unique variant SKUs`);

  // Exact normalized match only — col A has variant-level SKUs so no fuzzy logic needed.
  // Returns stock number, or null if SKU not found in source.
  function findStock(querySku) {
    if (!querySku) return null;
    const q = normSku(querySku);
    if (!q) return null;
    return sourceRows.has(q) ? sourceRows.get(q) : null;
  }

  // 2. Read D2C SKUs and kits tab in parallel
  const [d2cRes, kitsRes] = await Promise.all([
    withRetry(() => httpsGet(`https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values/${encodeURIComponent(`${D2C_TAB}!B2:B2000`)}`, { Authorization: `Bearer ${token}` })),
    withRetry(() => httpsGet(`https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values/${encodeURIComponent(`${D2C_KITS_TAB}!B2:D300`)}`, { Authorization: `Bearer ${token}` })),
  ]);
  const d2cSkus = (JSON.parse(d2cRes.body).values ?? []).map(r => (r[0] ?? "").trim());

  // Build kitChildren map: parentSku → [childSku, ...]
  const kitChildren = new Map();
  let curKit = "";
  for (const r of (JSON.parse(kitsRes.body).values ?? [])) {
    const kp = (r[0] ?? "").trim(), ch = (r[2] ?? "").trim();
    if (kp) curKit = kp;
    if (curKit && ch) {
      if (!kitChildren.has(curKit)) kitChildren.set(curKit, []);
      kitChildren.get(curKit).push(ch);
    }
  }

  // Match a D2C SKU to a kit parent — exact normalized match only.
  // Product variants (SB-417-401) must NOT match the kit parent (SB-417).
  function matchKitParent(sku) {
    const u = sku.toUpperCase().trim();
    for (const kp of kitChildren.keys()) {
      if (u === kp.toUpperCase().trim()) return kp;
    }
    return null;
  }

  // 3. Compute AF value for every D2C row
  const afData = [];
  let kitRows = 0, nonKitFound = 0, notFound = 0;

  for (let i = 0; i < d2cSkus.length; i++) {
    const sku = d2cSkus[i];
    const row = i + 2;
    if (!sku) { afData.push({ range: `${D2C_TAB}!AF${row}`, values: [[""]] }); continue; }

    const kitParent = matchKitParent(sku);
    let value;

    if (kitParent) {
      // Kit row: MIN stock across child SKUs that are found in source.
      // Unmatched children are skipped — they may be tracked in a different warehouse.
      // This gives MIN of the scarcest *known* component.
      const children = kitChildren.get(kitParent) ?? [];
      const foundStocks = children.map(c => findStock(c)).filter(s => s !== null);
      value = foundStocks.length > 0 ? Math.min(...foundStocks) : 0;
      kitRows++;
    } else {
      const s = findStock(sku);
      value = s !== null ? s : 0;
      if (value > 0) nonKitFound++; else notFound++;
    }

    afData.push({ range: `${D2C_TAB}!AF${row}`, values: [[value]] });
  }

  // 4. Write AF header + values in chunks
  await withRetry(() => httpsRequest("POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values:batchUpdate`,
    JSON.stringify({ valueInputOption: "USER_ENTERED", data: [{ range: `${D2C_TAB}!AF1`, values: [["Mother Warehouse Total Inventory"]] }] }),
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  ));

  const CHUNK = 150;
  for (let i = 0; i < afData.length; i += CHUNK) {
    const res = await withRetry(() => httpsRequest("POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values:batchUpdate`,
      JSON.stringify({ valueInputOption: "USER_ENTERED", data: afData.slice(i, i + CHUNK) }),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    ));
    if (JSON.parse(res.body).error) throw new Error(`AF write chunk ${i} failed: ${res.body}`);
  }

  // 5. Clear old IMPORTRANGE helper cols AH–AK (no longer needed)
  await withRetry(() => httpsRequest("POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values:batchClear`,
    JSON.stringify({ ranges: [`${D2C_TAB}!AH1:AK2000`] }),
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  ));

  // 6. Trim sheet to exactly AF (col 32 = index 31); delete any extra columns beyond
  const sheetMeta = JSON.parse((await withRetry(() => httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}?fields=sheets(properties(sheetId,gridProperties))`,
    { Authorization: `Bearer ${token}` }
  ))).body);
  const d2cSheet = (sheetMeta.sheets ?? []).find(s => s.properties.sheetId === D2C_TAB_GID);
  const colCount = d2cSheet?.properties?.gridProperties?.columnCount ?? 0;
  const TARGET_COLS = 32; // through AF (col 32, 1-indexed)
  if (colCount > TARGET_COLS) {
    await withRetry(() => httpsRequest("POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}:batchUpdate`,
      JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: D2C_TAB_GID, dimension: "COLUMNS", startIndex: TARGET_COLS, endIndex: colCount } } }] }),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    ));
    console.log(`  ✓ Trimmed ${colCount - TARGET_COLS} extra columns (now exactly AF)`);
  }

  console.log(`  ✓ AF written: ${afData.length} rows — ${kitRows} kit rows (MIN child stock), ${nonKitFound} non-kit matched, ${notFound} not found in source`);
  console.log(`  ✓ Helper cols AH–AK cleared (direct API read replaces IMPORTRANGE)`);
}

async function main() {
  console.log("═".repeat(58));
  console.log("  Shopify Reports → Google Sheets");
  console.log("═".repeat(58));
  console.log(`Store     : ${SHOPIFY_STORE}`);
  console.log(`30D start : ${D30_AGO_ISO}`);
  console.log(`Sheet     : ${SHEET_TAB}  |  SKU col: ${SKU_COL}  |  Start row: ${DATA_START_ROW}`);
  console.log(`Writes    : G/K/L/N/U  →  M/R/T/V/W/X/Y/AB/AC/AD`);
  if (DRY_RUN) console.log(`Mode      : DRY RUN`);
  console.log("─".repeat(58));

  // Debug mode — find actual Shopify SKUs for kit products
  if (FIND_KITS) return await findKitSKUsInShopify();

  // Step 1 — authenticate with Google and read sheet SKUs first
  // (needed to build the SKU translation map before writing)
  console.log("\n[1/5] Authenticating with Google Sheets...");
  const token   = await getGoogleAccessToken();
  console.log("  ✓ Access token obtained");

  console.log("\n[2/5] Reading sheet SKUs...");
  const skuRows = await readSheetSKUs(token);
  console.log(`  ✓ ${skuRows.length} SKU rows found (rows ${DATA_START_ROW}–${skuRows[skuRows.length - 1]?.row})`);

  // Step 2 — fetch sales (orders + refunds)
  console.log("\n[3/5] Fetching orders (Total Sales by Product)...");
  const salesMap = await fetchSalesReport();

  // Step 3 — fetch inventory
  console.log("\n[4/5] Fetching inventory (Month End Inventory Snapshot)...");
  const { stockMap, productNameMap } = await fetchInventoryReport();

  // Step 4 — build universal SKU translation map for ALL sheet SKUs
  console.log("\n[5/5] Building SKU translation map and writing to sheet...");
  const sheetSkuList = skuRows.map(r => r.sku);
  const skuTranslation = buildSkuTranslationMap(sheetSkuList, stockMap, salesMap);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Translation map (not written to Sheets):\n");
    for (const [sheetSku, shopifySku] of Object.entries(skuTranslation)) {
      const data  = salesMap[shopifySku ?? sheetSku];
      const stock = stockMap[shopifySku ?? sheetSku];
      console.log(`  ${sheetSku.padEnd(25)} → ${(shopifySku ?? "NO MATCH").padEnd(25)} | stock: ${stock ?? 0} | sold: ${data?.net_items_sold ?? 0} | rev: ${data?.gross_sales?.toFixed(2) ?? 0}`);
    }
    return;
  }

  // Step 5 — write to existing sheet rows using translated SKUs
  await writeToSheet(token, skuRows, salesMap, stockMap, skuTranslation);

  // Step 6 — append new rows for SKUs sold in last 3 days but not yet in sheet
  console.log("\n[6/7] Checking for new products sold in last 30 days...");
  const newSkus = findNewUnmatchedSkus(salesMap, skuTranslation);
  console.log(`  ${newSkus.length === 0 ? "✓ No new unmatched products found." : `⚡ ${newSkus.length} new SKU(s) to append`}`);
  // Re-read the sheet to get the true last row right before appending —
  // guarantees we always append exactly after the last SKU in column B,
  // regardless of any changes made during this run.
  const freshSkuRows = await readSheetSKUs(token);
  const lastRow      = freshSkuRows[freshSkuRows.length - 1].row;
  console.log(`  Last occupied row in sheet  : ${lastRow}`);
  console.log(`  New rows will start at      : ${lastRow + 1}`);
  if (!DRY_RUN) await appendNewProductRows(token, newSkus, salesMap, stockMap, productNameMap, lastRow);

  // Step 7 — read NPD allocation sheet and mark column AE = 1 for matching SKUs
  console.log("\n[7/8] Syncing NPD flags from allocation sheet...");
  const npdSkus = await fetchNpdSkus(token);
  console.log(`  Total NPD SKUs across all tabs: ${npdSkus.size}`);
  const latestSkuRows = await readSheetSKUs(token);
  await markNpdFlags(token, latestSkuRows, npdSkus);

  // Step 8 — calculate and write projected demand (col X)
  console.log("\n[8/8] Writing projected demand (col X)...");
  const { childToKits, kitParentSkus } = await readKitsSheet(token);
  console.log(`  Kits sheet: ${kitParentSkus.size} kit parent SKUs, ${Object.keys(childToKits).length} child SKUs`);
  if (kitParentSkus.size > 0) console.log(`  Sample kit parents: ${[...kitParentSkus].slice(0, 5).join(", ")}`);
  const finalSkuRows = await readSheetSKUs(token);
  await writeProjectedDemand(token, finalSkuRows, childToKits, kitParentSkus);

  // Step 9 — write Mother WH inventory to D2C sheet AF column
  console.log("\n[9/9] Writing Mother WH inventory to D2C sheet (col AF)...");
  await writeMotherWHStock(token);

  console.log("\n" + "═".repeat(58));
  console.log("  Done. Cols G/K/L/N/U written from Shopify; M/R/T/V/W/X/Y/AB/AC/AD derived; NPD flags set; D2C AF = Mother WH stock.");
  console.log("═".repeat(58) + "\n");
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err.message);
  process.exit(1);
});
