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
const SHEET_ID             = "1Y2EaDjGfMwscmpn9h7oR_mTOSVxErqWHeowftX01KdI";
const SHEET_TAB            = "Inventory Dashboard";
// SHEET_GID looked up dynamically in appendNewProductRows — do not hardcode
const NPD_FLAG_COL         = "AE";  // Column in Inventory Dashboard to mark NPD = 1

// ─── NPD Allocation sheet (separate spreadsheet) ─────────────────────────────
const NPD_SHEET_ID  = "1Ubwo5ElTn4AH1zIWqZUOsjhvo-SZ_t_i2dZkCLOaKHw";
const NPD_TABS      = [
  { name: "SB",                   skuCol: "D" },
  { name: "Select ",               skuCol: "C" },
  { name: "Craze",                skuCol: "D" },
  { name: "Skincare & Fragrance", skuCol: "D" },
];

const SKU_COL              = "B";
const STOCK_COL            = "G";   // Ending Inventory Units
const UNITS_COL            = "K";   // Net Items Sold
const OOS_DAYS_COL         = "L";   // OOS Days (days where daily units sold < 5)
const REVENUE_COL          = "N";   // Gross Sales
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

        // Accumulate daily units for OOS days calculation
        salesMap[sku].dailyUnits[orderDate] = (salesMap[sku].dailyUnits[orderDate] || 0) + netQty;
      }
    }

    console.log(`  Batch ${String(batch).padStart(3)}: ${String(orders.length).padStart(3)} orders  (total: ${totalOrders})`);
    pageInfo = extractNextPageInfo(res.headers["link"]);
    if (pageInfo) await sleep(500);
  } while (pageInfo !== null);

  // Calculate OOS days per SKU:
  // For each of the 30 days, if units sold on that day < 5 → OOS day
  const startDate = new Date(D30_AGO_ISO);
  for (const sku of Object.keys(salesMap)) {
    let oosDays = 0;
    for (let i = 0; i < 30; i++) {
      const d    = new Date(startDate);
      d.setDate(d.getDate() + i);
      const key  = d.toISOString().slice(0, 10);
      const sold = salesMap[sku].dailyUnits[key] || 0;
      if (sold < 5) oosDays++;
    }
    salesMap[sku].oos_days = oosDays;
  }

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
  // We write only the columns we own: B, C, G, K, L, N
  // Each column gets its own range + values array in the batchUpdate call.
  const colB = [], colC = [], colG = [], colK = [], colL = [], colN = [];

  newSkus.forEach((sku) => {
    const sales = salesMap[sku];
    const stock = stockMap[sku] ?? 0;
    const name  = productNameMap[sku] || sales?.productTitle || "";
    colB.push([sku]);
    colC.push([name]);
    colG.push([stock]);
    colK.push([sales?.net_items_sold ?? 0]);
    colL.push([sales?.oos_days        ?? 30]);
    colN.push([parseFloat((sales?.gross_sales ?? 0).toFixed(2))]);
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
  const range = `${SHEET_TAB}!${SKU_COL}${DATA_START_ROW}:${SKU_COL}`;
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res   = await withRetry(() => httpsGet(url, { Authorization: `Bearer ${token}` }));

  if (res.statusCode !== 200) throw new Error(`Sheets read error ${res.statusCode}: ${res.body}`);

  return (JSON.parse(res.body).values ?? [])
    .map((row, i) => ({ sku: normalizeSKU(row[0] ?? ""), row: DATA_START_ROW + i }))
    .filter((r) => r.sku !== "");
}

async function writeToSheet(token, skuRows, salesMap, stockMap, skuTranslation = {}) {
  const lastRow   = skuRows[skuRows.length - 1].row;
  const totalRows = lastRow - DATA_START_ROW + 1;

  const colG = Array.from({ length: totalRows }, () => [""]);
  const colK = Array.from({ length: totalRows }, () => [""]);
  const colL = Array.from({ length: totalRows }, () => [""]);
  const colN = Array.from({ length: totalRows }, () => [""]);

  let matchedSales = 0;
  let matchedStock = 0;
  const unmatchedSales = [];
  const unmatchedStock = [];

  for (const { sku, row } of skuRows) {
    const idx        = row - DATA_START_ROW;
    // Use translated Shopify SKU for lookup, fall back to sheet SKU
    const lookupSku  = skuTranslation[sku] ?? sku;
    const sales      = salesMap[lookupSku];
    const stock      = stockMap[lookupSku];

    if (sales !== undefined) {
      colK[idx] = [sales.net_items_sold];
      colL[idx] = [sales.oos_days];
      colN[idx] = [parseFloat(sales.gross_sales.toFixed(2))];
      matchedSales++;
    } else {
      // No sales in last 30 days → all 30 days are OOS days
      colK[idx] = [0];
      colL[idx] = [30];
      colN[idx] = [0];
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

  const res = await withRetry(() =>
    httpsRequest(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      JSON.stringify({ valueInputOption: "RAW", data: [
        { range: rangeG, values: colG },
        { range: rangeK, values: colK },
        { range: rangeL, values: colL },
        { range: rangeN, values: colN },
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
 * Reads product codes from all NPD allocation tabs and returns a Set of
 * normalised SKUs that are in the NPD pipeline.
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
      npdSkus.add(normalizeSKU(cell));
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
    const isNpd      = npdSkus.has(normalizeSKU(sku));

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
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═".repeat(58));
  console.log("  Shopify Reports → Google Sheets");
  console.log("═".repeat(58));
  console.log(`Store     : ${SHOPIFY_STORE}`);
  console.log(`30D start : ${D30_AGO_ISO}`);
  console.log(`Sheet     : ${SHEET_TAB}  |  SKU col: ${SKU_COL}  |  Start row: ${DATA_START_ROW}`);
  console.log(`Writes    : G=Stock  K=Net Sold  L=OOS Days  N=Gross Sales`);
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
  console.log("\n[7/7] Syncing NPD flags from allocation sheet...");
  const npdSkus = await fetchNpdSkus(token);
  console.log(`  Total NPD SKUs across all tabs: ${npdSkus.size}`);
  const latestSkuRows = await readSheetSKUs(token);
  await markNpdFlags(token, latestSkuRows, npdSkus);

  console.log("\n" + "═".repeat(58));
  console.log("  Done. Columns G/K/L/N updated; new SKUs appended; NPD flags set.");
  console.log("═".repeat(58) + "\n");
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err.message);
  process.exit(1);
});
