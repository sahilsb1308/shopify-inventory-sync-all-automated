# Shopify Stock Projection Filler

Pulls live inventory and sales data from Shopify and automatically fills the
`projection.xlsx` stock planning spreadsheet.

---

## Prerequisites

- Python 3.9 or later
- A Shopify Private App (or Custom App) access token with the following scopes:
  - `read_products`
  - `read_inventory`
  - `read_orders`

---

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` and fill in your real values:

```
SHOPIFY_STORE_URL=https://your-store-name.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> `.env` is gitignored. Never commit it.

### 3. Place your input file

Put your `projection.xlsx` file in the same directory as `fill_projection.py`.

The script expects the first sheet to have a header row containing at minimum:

| EAN | SKU | April Units | May Units | June Units | Actual Shopify Stock | Actual DRR | Actually Received | Days in Hand | Total Sold |
|-----|-----|-------------|-----------|------------|----------------------|------------|-------------------|--------------|------------|

Column order does not matter; the script matches by header name (case-insensitive).

---

## Running

```bash
# Use cached Shopify data if available (fast re-runs)
python fill_projection.py

# Force a fresh pull from Shopify API
python fill_projection.py --fresh
```

---

## Outputs

| File | Description |
|------|-------------|
| `projection_filled.xlsx` | Completed spreadsheet with all calculated columns |
| `shopify_raw_data.json` | Cache of all Shopify API responses |

### projection_filled.xlsx sheets

- **Main sheet** – all columns filled, Days in Hand colour-coded:
  - RED    = < 60 days (critical)
  - YELLOW = 60–90 days (watch)
  - GREEN  = > 90 days (healthy)
- **Summary** – overview stats, top 20 SKUs by sales, category health table
- **Unmatched** – any Excel rows that could not be matched to a Shopify variant

---

## Business Logic

| Field | Formula |
|-------|---------|
| Actual Shopify Stock | Live inventory from Shopify API (summed across all locations) |
| Actual DRR | Peak single-day units sold in the last 6 months |
| Total Sold | Sum of all units sold in the last 6 months |
| Actually Received | Current stock + Total sold (REST API approximation) |
| Days in Hand | Actual Shopify Stock ÷ Actual DRR (∞ if DRR = 0) |
| April / May / June Units | DRR × 30 × 1.20 (only fills blank/zero cells) |

---

## SKU Matching

1. **Primary** – Shopify variant `sku` field vs `SKU` column (case-insensitive)
2. **Fallback** – Shopify variant `barcode` field vs `EAN` column (case-insensitive)

Rows with no match are listed in the **Unmatched** sheet.

---

## Rate Limiting

- Waits 0.5 s between every API call
- Automatically retries on HTTP 429 (respects `Retry-After` header)
- Retries up to 5× on 5xx server errors with exponential back-off

---

## Caching / Resume

If the script is interrupted mid-way, re-run it **without** `--fresh` to resume
from the cached data and skip re-pulling the API.

Use `--fresh` only when you want up-to-date stock figures.

---

## Node.js Automation — `shopify_orders.js`

The project now includes a fully automated Node.js pipeline (`shopify_orders.js`) that replaces manual spreadsheet work. It writes directly to the D2C Google Sheet via the Sheets API.

### What it does (11 steps per run)

| Step | What happens |
|------|-------------|
| 1 | Authenticates with Google Sheets via service account |
| 2 | Reads existing SKU rows from the Inventory Dashboard |
| 3 | Fetches 30-day orders + refunds from Shopify |
| 4 | Fetches live inventory from Shopify (all locations) |
| 5 | Builds SKU translation map and writes it to the sheet |
| 6 | Appends new rows for SKUs sold in last 30 days (skips deleted Shopify products) |
| 7 | Syncs NPD flags from allocation sheet → col AE; stamps AK with activation date |
| 7b | Syncs Focus flags from focus allocation sheet → col Q |
| 7c | Writes Launch Type ARRAYFORMULA to col N (`NPD` if flag=1, else `EPD`) |
| 8 | Writes Projected Demand to col X |
| 9 | Pulls Mother Warehouse inventory from source sheet → col AF (forced NUMBER format) |
| 10 | Writes 7-day + 15-day sold and DRR to cols AG / AH / AI / AJ |

### Sheets written to

- **D2C Sheet** (`1ILrx79KdCV1-RDdwQPrrGsGyKe4s2698r3Mwcu9L18M`) — primary output
- **Source Sheet** (`1daV5kSvAf19z0LqZ9PKT2Vbae5rhULmi8qcNUEqAL4I`) — Mother WH stock (read-only)

### Key D2C column layout

| Col | Field |
|-----|-------|
| A | Product Name |
| B | SKU |
| C | Variant |
| J | Net Sold (30d) |
| M | Revenue |
| N | Launch Type (NPD / EPD — auto-formula) |
| Q | Focus Flag |
| AE | NPD Flag |
| AF | Mother WH Total Inventory |
| AG | Total Sold (7d) |
| AH | DRR (7d) |
| AI | Total Sold (15d) |
| AJ | DRR (15d) |
| AK | NPD Activation Date |

### Running

```bash
node shopify_orders.js
```

Requires a `service_account.json` (Google service account key) in the project directory and the following env vars (or `.env`):

```
SHOPIFY_STORE_URL=https://your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
```

> Never commit `service_account.json` or `.env` — both are gitignored.

### Snapshot Tab

The **Snapshot** tab in the D2C sheet is a live mirror of the Inventory Dashboard using `ARRAYFORMULA` column references (cols A B C J M N U V W Y AA AB AC AE AF). Conditional formatting is synced from the Dashboard. No manual refresh needed.