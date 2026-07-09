"use strict";

/**
 * write_7d.js
 * Standalone script — fetches last 7 days of Shopify orders and writes:
 *   AG = Total Sold (7d)
 *   AH = DRR (7d) = AG / 7
 * to the D2C All Automated sheet (Inventory Dashboard tab).
 *
 * Usage:
 *   $env:SHOPIFY_STORE="swiss-beauty-dev.myshopify.com"
 *   $env:SHOPIFY_ACCESS_TOKEN="shpat_xxx"
 *   $env:GOOGLE_SERVICE_ACCOUNT_FILE="service_account.json"   # optional, default = service_account.json
 *   node write_7d.js
 */

const https  = require("https");
const fs     = require("fs");
const crypto = require("crypto");

const SHOPIFY_STORE        = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "service_account.json";
const API_VERSION          = "2023-10";
const PAGE_LIMIT           = 250;

const D2C_SHEET_ID = "1ILrx79KdCV1-RDdwQPrrGsGyKe4s2698r3Mwcu9L18M";
const D2C_TAB      = "Inventory Dashboard";

const D7_AGO       = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const D7_AGO_ISO   = D7_AGO.toISOString();
const D7_AGO_DATE  = D7_AGO_ISO.slice(0, 10);

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.error("ERROR: Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN env vars.");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSKU(sku) {
  return (sku ?? "").trim().toUpperCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").replace(/\.$/, "");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = { hostname: u.hostname, path: u.pathname + u.search, headers };
    https.get(options, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

function httpsRequest(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = { hostname: u.hostname, path: u.pathname + u.search, method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) } };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? m[1] : null;
}

// ─── Google auth ──────────────────────────────────────────────────────────────

async function getGoogleToken() {
  const sa = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE));
  const b64 = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const header = b64(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const now    = Math.floor(Date.now() / 1000);
  const claim  = b64(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })));
  const sig = b64(crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(sa.private_key));
  const jwt = `${header}.${claim}.${sig}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res  = await httpsRequest("POST", "https://oauth2.googleapis.com/token", body, { "Content-Type": "application/x-www-form-urlencoded" });
  const parsed = JSON.parse(res.body);
  if (!parsed.access_token) throw new Error(`Google auth failed: ${res.body}`);
  return parsed.access_token;
}

// ─── Shopify fetch ────────────────────────────────────────────────────────────

async function fetch7dSales() {
  const salesMap = {}; // normSku → qty sold (7d)
  let pageInfo = null, batch = 0, total = 0;

  console.log(`  Fetching orders since ${D7_AGO_DATE}...`);
  do {
    batch++;
    const params = pageInfo
      ? `?limit=${PAGE_LIMIT}&page_info=${pageInfo}`
      : `?limit=${PAGE_LIMIT}&status=any&created_at_min=${encodeURIComponent(D7_AGO_ISO)}`;

    const res = await httpsGet(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json${params}`,
      { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" }
    );
    if (res.statusCode !== 200) throw new Error(`Shopify ${res.statusCode}: ${res.body.slice(0, 200)}`);

    const orders = JSON.parse(res.body).orders ?? [];
    total += orders.length;

    for (const order of orders) {
      const refundedQty = {};
      for (const ref of order.refunds ?? [])
        for (const rli of ref.refund_line_items ?? [])
          refundedQty[rli.line_item_id] = (refundedQty[rli.line_item_id] || 0) + (rli.quantity || 0);

      for (const item of order.line_items ?? []) {
        if (!item.sku) continue;
        const sku    = normalizeSKU(item.sku);
        const netQty = (Number(item.quantity) || 0) - (refundedQty[item.id] || 0);
        salesMap[sku] = (salesMap[sku] || 0) + netQty;
      }
    }

    console.log(`    Batch ${batch}: ${orders.length} orders (total: ${total})`);
    pageInfo = extractNextPageInfo(res.headers["link"]);
    if (pageInfo) await sleep(500);
  } while (pageInfo);

  console.log(`  ✓ ${total} orders → ${Object.keys(salesMap).length} SKUs with sales`);
  return salesMap;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("─".repeat(50));
  console.log("  write_7d.js — 7d Sold + DRR → D2C sheet AG/AH");
  console.log("─".repeat(50));

  const token = await getGoogleToken();
  console.log("✓ Google auth OK");

  // Read D2C sheet SKUs from col B
  const skuRes = await httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values/${encodeURIComponent(`${D2C_TAB}!B2:B2000`)}`,
    { Authorization: `Bearer ${token}` }
  );
  const d2cSkus = (JSON.parse(skuRes.body).values ?? []).map(r => (r[0] ?? "").trim());
  console.log(`✓ ${d2cSkus.filter(Boolean).length} SKUs read from D2C sheet col B`);

  // Fetch 7d Shopify orders
  const salesMap = await fetch7dSales();

  // Build AG / AH values
  const agValues = [];
  const ahValues = [];
  let matched = 0;

  for (const sku of d2cSkus) {
    if (!sku) { agValues.push([""]); ahValues.push([""]); continue; }
    const norm    = normalizeSKU(sku);
    const sold7d  = salesMap[norm] ?? 0;
    const drr7d   = sold7d > 0 ? parseFloat((sold7d / 7).toFixed(4)) : 0;
    agValues.push([sold7d]);
    ahValues.push([drr7d]);
    if (sold7d > 0) matched++;
  }

  const lastRow = d2cSkus.length + 1;
  console.log(`  ${matched} SKUs had 7d sales`);

  // Expand sheet to at least 34 columns (AH) if needed
  const metaRes = await httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}?fields=sheets(properties(sheetId,gridProperties))`,
    { Authorization: `Bearer ${token}` }
  );
  const D2C_TAB_GID = 599219316;
  const d2cSheet = (JSON.parse(metaRes.body).sheets ?? []).find(s => s.properties.sheetId === D2C_TAB_GID);
  const colCount = d2cSheet?.properties?.gridProperties?.columnCount ?? 0;
  const NEEDED = 34;
  if (colCount < NEEDED) {
    await httpsRequest("POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}:batchUpdate`,
      JSON.stringify({ requests: [{ appendDimension: { sheetId: D2C_TAB_GID, dimension: "COLUMNS", length: NEEDED - colCount } }] }),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    );
    console.log(`  Expanded sheet from ${colCount} to ${NEEDED} columns`);
  }

  // Write to sheet
  const writeRes = await httpsRequest(
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${D2C_SHEET_ID}/values:batchUpdate`,
    JSON.stringify({ valueInputOption: "USER_ENTERED", data: [
      { range: `${D2C_TAB}!AG1`, values: [["Total Sold (7d)"]] },
      { range: `${D2C_TAB}!AH1`, values: [["DRR (7d)"]] },
      { range: `${D2C_TAB}!AG2:AG${lastRow}`, values: agValues },
      { range: `${D2C_TAB}!AH2:AH${lastRow}`, values: ahValues },
    ]}),
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  );

  const result = JSON.parse(writeRes.body);
  if (result.error) throw new Error(`Sheet write failed: ${writeRes.body}`);

  console.log(`\n✓ Done — AG (Total Sold 7d) + AH (DRR 7d) written for ${d2cSkus.filter(Boolean).length} rows`);
  console.log(`  Window: ${D7_AGO_DATE} → today`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
