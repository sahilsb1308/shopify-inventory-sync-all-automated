#!/usr/bin/env python3
"""
projected_demand.py

Writes projected demand (Column X, "Projected Demand 30d") to the
Inventory Dashboard sheet, replicating the Google Sheets formula logic:

  1. SKU has no DRR (col U blank) AND is not a kit child  →  0
  2. SKU is a kit parent (its prefix appears in Kits sheet col B)  →  0
  3. Otherwise:
       (DRR * 30  +  Σ kit_total_sold for kits that contain this SKU)
       × revenue_multiplier

     Revenue multiplier = MAX of:
       NPD  (col O = "NPD")  → 1.8
       Promo flag Q (col Q = 1)  → 1.5
       Promo flag R (col R = 1)  → 1.2
       Priority (col AA):  P0→1.5  P1→1.3  P2→1.2  P3→1.1  else→0

Kit columns ("Kits - Child SKUs" sheet):
  B = parent kit SKU
  D = child SKU

Inventory Dashboard columns:
  B  = SKU               (index  1)
  K  = Total Sold 30d    (index 10)
  O  = NPD flag          (index 14)
  Q  = Promo flag 1      (index 16)
  R  = Promo flag 2      (index 17)
  U  = DRR               (index 20)
  X  = Projected Demand  (index 23)  ← written by this script
  AA = Priority          (index 26)

Usage:
  pip install gspread google-auth
  python projected_demand.py
"""

import os
import gspread
from google.oauth2.service_account import Credentials

# ─── Config ──────────────────────────────────────────────────────────────────
SERVICE_ACCOUNT_FILE = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "service_account.json")
SHEET_ID      = "1Y2EaDjGfMwscmpn9h7oR_mTOSVxErqWHeowftX01KdI"
DASHBOARD_TAB = "Inventory Dashboard"
KITS_TAB      = "Kits - Child SKUs"
DATA_START_ROW = 2  # row 1 is header

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# ─── Column indices (0-based, matching get_all_values() rows) ────────────────
COL_SKU      = 1   # B
COL_K        = 10  # K  – Total Sold 30d
COL_NPD      = 14  # O  – NPD flag
COL_PROMO_Q  = 16  # Q
COL_PROMO_R  = 17  # R
COL_DRR      = 20  # U  – Daily Run Rate
COL_DEMAND   = 23  # X  – Projected Demand (output)
COL_PRIORITY = 26  # AA


# ─── Helpers ─────────────────────────────────────────────────────────────────

def sku_prefix(sku: str) -> str:
    """Return the first two hyphen-separated segments: 'SB-K01-01' → 'SB-K01'.
    Falls back to the full SKU if fewer than two hyphens."""
    parts = sku.split("-")
    return "-".join(parts[:2]) if len(parts) >= 2 else sku


def to_float(value: str, default=None):
    try:
        return float(value.replace(",", "").strip()) if value.strip() else default
    except (ValueError, AttributeError):
        return default


def revenue_multiplier(npd_flag: str, promo_q: str, promo_r: str, priority: str) -> float:
    candidates = []
    if npd_flag.strip().upper() == "NPD":
        candidates.append(1.8)
    if to_float(promo_q) == 1:
        candidates.append(1.5)
    if to_float(promo_r) == 1:
        candidates.append(1.2)
    priority_scores = {"P0": 1.5, "P1": 1.3, "P2": 1.2, "P3": 1.1}
    candidates.append(priority_scores.get(priority.strip().upper(), 0))
    return max(candidates) if candidates else 0


def safe_col(row: list, idx: int) -> str:
    return row[idx].strip() if len(row) > idx else ""


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
    gc    = gspread.authorize(creds)

    spreadsheet = gc.open_by_key(SHEET_ID)
    dashboard   = spreadsheet.worksheet(DASHBOARD_TAB)
    kits_sheet  = spreadsheet.worksheet(KITS_TAB)

    print("Reading Inventory Dashboard...")
    dash_rows = dashboard.get_all_values()

    print("Reading Kits - Child SKUs sheet...")
    kits_rows = kits_sheet.get_all_values()

    # ── Parse Kits sheet ──────────────────────────────────────────────────────
    # child_to_kits[child_sku] = [parent_kit_sku, ...]
    child_to_kits: dict[str, list[str]] = {}
    kit_parent_prefixes: set[str] = set()

    for row in kits_rows[1:]:  # skip header
        kit_sku   = safe_col(row, 1)  # col B
        child_sku = safe_col(row, 3)  # col D
        if kit_sku:
            kit_parent_prefixes.add(sku_prefix(kit_sku))
        if kit_sku and child_sku:
            child_to_kits.setdefault(child_sku, []).append(kit_sku)

    # ── Build prefix → total-sold-30d lookup from Dashboard ──────────────────
    # Mirrors the VLOOKUP against prefixes of column B, returning column K.
    # First match wins (same as VLOOKUP FALSE).
    prefix_to_k: dict[str, float] = {}
    for row in dash_rows[1:]:
        sku = safe_col(row, COL_SKU)
        if not sku:
            continue
        k_val = to_float(safe_col(row, COL_K), default=0)
        prefix = sku_prefix(sku)
        if prefix not in prefix_to_k:
            prefix_to_k[prefix] = k_val

    # ── Calculate projected demand ────────────────────────────────────────────
    results: list[list] = []

    for row in dash_rows[1:]:
        sku = safe_col(row, COL_SKU)
        if not sku:
            results.append([""])
            continue

        drr      = to_float(safe_col(row, COL_DRR))
        is_child = sku in child_to_kits

        # Rule 1: no DRR and not a kit child → 0
        if drr is None and not is_child:
            results.append([0])
            continue

        # Rule 2: kit parent → 0
        if sku_prefix(sku) in kit_parent_prefixes:
            results.append([0])
            continue

        # Rule 3: (DRR*30 + kit contribution) × multiplier
        base = (drr or 0) * 30

        kit_contrib = sum(
            prefix_to_k.get(sku_prefix(kit_sku), 0)
            for kit_sku in child_to_kits.get(sku, [])
        )

        multiplier = revenue_multiplier(
            safe_col(row, COL_NPD),
            safe_col(row, COL_PROMO_Q),
            safe_col(row, COL_PROMO_R),
            safe_col(row, COL_PRIORITY),
        )

        projected = round((base + kit_contrib) * multiplier, 2)
        results.append([projected])

    # ── Write column X ────────────────────────────────────────────────────────
    last_row  = DATA_START_ROW + len(results) - 1
    range_x   = f"X{DATA_START_ROW}:X{last_row}"

    print(f"  Writing {len(results)} rows to {DASHBOARD_TAB}!{range_x}...")
    dashboard.update(range_name=range_x, values=results, value_input_option="RAW")

    print(f"✓ Done — projected demand written for {len(results)} rows.")


if __name__ == "__main__":
    main()
