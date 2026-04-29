#!/usr/bin/env node
/**
 * sync_npd_flags.js
 *
 * Standalone script — reads product codes from the NPD Allocation sheet
 * (SB / Select / Craze / Skincare & Fragrance tabs) and writes 1 to
 * column AE (NPD flag) in the Inventory Dashboard for every matched SKU.
 *
 * Runs in ~5 seconds. No Shopify API calls needed.
 *
 * Usage (PowerShell):
 *   node sync_npd_flags.js
 *   node sync_npd_flags.js --dry-run   ← see what would change without writing
 */

"use strict";

const https  = require("https");
const fs     = require("fs");
const crypto = require("crypto");

// ─── Config ──────────────────────────────────────────────────────────────────
const SERVICE_ACCOUNT_FILE = "service_account.json";
const SHEET_ID             = "1Y2EaDjGfMwscmpn9h7oR_mTOSVxErqWHeowftX01KdI";
const SHEET_TAB            = "Inventory Dashboard";
const SKU_COL              = "B";
const NPD_FLAG_COL         = "AE";
const DATA_START_ROW       = 2;

const NPD_SHEET_ID = "1Ubwo5ElTn4AH1zIWqZUOsjhvo-SZ_t_i2dZkCLOaKHw";
const NPD_TABS     = [
  { name: "SB",                   skuCol: "D" },
  { name: "Select ",               skuCol: "C" },
  { name: "Craze",                skuCol: "D" },
  { name: "Skincare & Fragrance", skuCol: "D" },
];

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeSKU(sku) {
  return (sku ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim();
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location, headers).then(resolve, reject);
      const buf = [];
      res.on("data", c => buf.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(buf).toString("utf8") }));
    });
    req.on("error", reject);
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = Buffer.from(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { ...headers, "Content-Length": buf.length } },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

// ─── Google Auth ─────────────────────────────────────────────────────────────
async function getGoogleAccessToken() {
  const sa   = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, "utf8"));
  const now  = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })).toString("base64url");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key).toString("base64url");
  const jwt = `${header}.${payload}.${sig}`;
  const res = await httpsPost(
    "https://oauth2.googleapis.com/token",
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  return JSON.parse(res.body).access_token;
}

// ─── Main logic ──────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(54));
  console.log("  NPD Flag Sync → Inventory Dashboard col AE");
  if (DRY_RUN) console.log("  MODE: DRY RUN (no writes)");
  console.log("═".repeat(54));

  // 1. Auth
  console.log("\n[1/3] Authenticating...");
  const token = await getGoogleAccessToken();
  console.log("  ✓ Access token obtained");

  // 2. Read NPD allocation tabs
  console.log("\n[2/3] Reading NPD allocation sheet...");
  const npdSkus = new Set();
  for (const { name, skuCol } of NPD_TABS) {
    const range  = encodeURIComponent(`${name}!${skuCol}:${skuCol}`);
    const url    = `https://sheets.googleapis.com/v4/spreadsheets/${NPD_SHEET_ID}/values/${range}`;
    const res    = await httpsGet(url, { Authorization: `Bearer ${token}` });
    if (res.statusCode !== 200) {
      console.warn(`  ⚠ Tab "${name}" → ${res.statusCode} (check sheet is shared with service account)`);
      continue;
    }
    const values = JSON.parse(res.body).values ?? [];
    let added = 0;
    for (const [cell] of values) {
      if (!cell || !cell.trim() ||
          cell.trim().toUpperCase() === "NA" ||
          cell.trim().toUpperCase() === "PRODUCT CODE") continue;
      npdSkus.add(normalizeSKU(cell));
      added++;
    }
    console.log(`  Tab "${name}" (col ${skuCol}): ${added} SKUs`);
  }
  console.log(`  Total unique NPD SKUs: ${npdSkus.size}`);
  if (npdSkus.size === 0) { console.log("  Nothing to do."); return; }

  // 3. Read inventory dashboard columns B (SKU) and AE (current flag)
  console.log("\n[3/3] Syncing NPD flags in Inventory Dashboard...");
  const skuRange = encodeURIComponent(`${SHEET_TAB}!${SKU_COL}${DATA_START_ROW}:${SKU_COL}`);
  const skuRes   = await httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${skuRange}`,
    { Authorization: `Bearer ${token}` }
  );
  const skuValues = JSON.parse(skuRes.body).values ?? [];
  const skuRows   = skuValues
    .map(([sku], i) => ({ row: DATA_START_ROW + i, sku: sku ?? "" }))
    .filter(r => r.sku.trim() !== "");
  console.log(`  ${skuRows.length} SKU rows found in dashboard`);

  // Read current AE values for all rows
  const lastRow  = skuRows[skuRows.length - 1].row;
  const aeRange  = encodeURIComponent(`${SHEET_TAB}!${NPD_FLAG_COL}${DATA_START_ROW}:${NPD_FLAG_COL}${lastRow}`);
  const aeRes    = await httpsGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${aeRange}`,
    { Authorization: `Bearer ${token}` }
  );
  const aeValues = JSON.parse(aeRes.body).values ?? [];

  const toWrite = [];
  let setTo1 = 0, setTo0 = 0, unchanged = 0;

  for (const { row, sku } of skuRows) {
    const idx        = row - DATA_START_ROW;
    const currentRaw = (aeValues[idx]?.[0] ?? "").toString().trim();
    const current    = parseFloat(currentRaw) || 0;
    const isNpd      = npdSkus.has(normalizeSKU(sku));

    if (isNpd && current !== 1) {
      // In NPD sheet but not marked → set 1
      toWrite.push({ range: `${SHEET_TAB}!${NPD_FLAG_COL}${row}`, values: [[1]] });
      if (DRY_RUN) console.log(`  [DRY RUN] ${sku} → 1 (added to NPD)`);
      setTo1++;
    } else if (!isNpd && current === 1) {
      // Was NPD but no longer in sheet → set 0
      toWrite.push({ range: `${SHEET_TAB}!${NPD_FLAG_COL}${row}`, values: [[""]] });
      if (DRY_RUN) console.log(`  [DRY RUN] ${sku} → 0 (removed from NPD)`);
      setTo0++;
    } else {
      unchanged++;
    }
  }

  console.log(`  → Set to 1 (new NPD)     : ${setTo1}`);
  console.log(`  → Cleared (removed NPD)  : ${setTo0}`);
  console.log(`  → Unchanged              : ${unchanged}`);

  if (DRY_RUN) { console.log("\n  DRY RUN complete — no changes written."); return; }
  if (toWrite.length === 0) { console.log("  ✓ All flags already in sync."); return; }

  const writeRes = await httpsPost(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    JSON.stringify({ valueInputOption: "USER_ENTERED", data: toWrite }),
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  );
  if (writeRes.statusCode !== 200)
    throw new Error(`Write failed ${writeRes.statusCode}: ${writeRes.body.replace(/\s+/g, " ")}`);

  console.log(`\n✓ Done — ${setTo1} marked as 1, ${setTo0} reset to 0`);
  console.log("═".repeat(54) + "\n");
}

main().catch(err => { console.error("\nERROR:", err.message); process.exit(1); });
