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
