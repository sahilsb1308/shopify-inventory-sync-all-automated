#!/usr/bin/env python3
"""
projected_demand.py

Calculates and writes all derived columns to the Inventory Dashboard sheet:

  U  – DRR (Daily Run Rate)         = K / (30 − L)
  V  – Days of Inventory            = G / U
  W  – Projected Demand 7d          = (DRR*7 + kit_contrib) × multiplier
  X  – Projected Demand 30d         = (DRR*30 + kit_contrib) × multiplier
  Y  – Projected Revenue 30d        = X × ASP  (ASP = N/K)
  M  – Revenue Multiplier           = MAX(AE=1→6, O=NPD→1.8, Q=1→1.5, R=1→1.2, AA score)
  R  – Bestseller flag              = 1 if N ≥ median(N), else 0
  T  – Total Available Stock        = G + I + J
  AA – Priority                     = derived from AE, Q, AB
  AB – Revenue Contribution %       = (N / SUM(N)) × 100
  AC – Fill Rate                    = (K + G) / S
  AD – Units to be Filled           = MAX(0, X − G)

Column indices (0-based):
  B=1  G=6  I=8  J=9  K=10  L=11  M=12  N=13  O=14  Q=16
  R=17 S=18 T=19 U=20 V=21  W=22  X=23  Y=24  AA=26 AB=27
  AC=28 AD=29 AE=30

Usage:
  pip install gspread google-auth
  python projected_demand.py
"""

import os
import statistics
import gspread
from google.oauth2.service_account import Credentials

# ─── Config ──────────────────────────────────────────────────────────────────
SERVICE_ACCOUNT_FILE = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "service_account.json")
SHEET_ID      = "1ILrx79KdCV1-RDdwQPrrGsGyKe4s2698r3Mwcu9L18M"
DASHBOARD_TAB = "Inventory Dashboard"
KITS_TAB      = "Kits - Child SKUs"
DATA_START_ROW = 2

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# ─── Column indices (0-based) ─────────────────────────────────────────────────
COL_SKU         = 1   # B
COL_STOCK       = 6   # G – Current Stock
COL_I           = 8   # I – RTO Stock
COL_J           = 9   # J – Inward Stock
COL_K           = 10  # K – Total Sold 30d
COL_OOS         = 11  # L – OOS Days
COL_MULTIPLIER  = 12  # M – Revenue Multiplier (output)
COL_REVENUE     = 13  # N – Gross Sales 30d
COL_NPD_TEXT    = 14  # O – NPD text flag
COL_PROMO_Q     = 16  # Q – Promo flag
COL_BESTSELLER  = 17  # R – Bestseller flag (output)
COL_S           = 18  # S – Last Month's Projection
COL_T           = 19  # T – Total Available Stock (output)
COL_DRR         = 20  # U – Daily Run Rate (output)
COL_DOI         = 21  # V – Days of Inventory (output)
COL_DEMAND_7D   = 22  # W – Projected Demand 7d (output)
COL_DEMAND      = 23  # X – Projected Demand 30d (output)
COL_PROJ_REV    = 24  # Y – Projected Revenue 30d (output)
COL_STOCK_STATUS = 25 # Z – Stock Status (output)
COL_PRIORITY    = 26  # AA – Priority (output)
COL_REV_CONTRIB = 27  # AB – Revenue Contribution % (output)
COL_FILL_RATE   = 28  # AC – Fill Rate (output)
COL_UNITS_FILL  = 29  # AD – Units to be Filled (output)
COL_NPD_FLAG    = 30  # AE – NPD numeric flag


# ─── Helpers ─────────────────────────────────────────────────────────────────

def sku_prefix(sku: str) -> str:
    parts = sku.split("-")
    return "-".join(parts[:2]) if len(parts) >= 2 else sku


def to_float(value, default=None):
    try:
        v = str(value).replace(",", "").strip()
        return float(v) if v else default
    except (ValueError, AttributeError):
        return default


def safe_col(row: list, idx: int) -> str:
    return row[idx].strip() if len(row) > idx else ""


def calc_drr(k_val: float, oos_days: float):
    available = 30 - oos_days
    if available <= 0:
        return None
    return round(k_val / available, 4)


def calc_priority(npd_flag: str, promo_q: str, ab_val: float) -> str:
    if to_float(npd_flag) == 1:
        return "P0"
    if to_float(promo_q) == 1:
        return "P0"
    if ab_val > 1:
        return "P0"
    if ab_val >= 0.44:
        return "P1"
    if ab_val >= 0.2:
        return "P2"
    return "P3"


def calc_stock_status(doi) -> str:
    if doi == "" or doi is None:
        return ""
    v = float(doi)
    if v <= 10:  return "Critical"
    if v <= 40:  return "Low"
    if v <= 70:  return "Healthy"
    if v <= 100: return "Overstocked"
    return "Excess"


def calc_multiplier(npd_flag: str, npd_text: str, promo_q: str, is_bestseller: int, priority: str) -> float:
    priority_scores = {"P0": 1.5, "P1": 1.3, "P2": 1.2, "P3": 1.1}
    candidates = [
        6   if to_float(npd_flag) == 1          else 0,
        1.8 if npd_text.upper() == "NPD"         else 0,
        1.5 if to_float(promo_q) == 1            else 0,
        1.2 if is_bestseller == 1                else 0,
        priority_scores.get(priority.upper(), 1),
    ]
    return max(candidates)


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
    child_to_kits: dict[str, list[str]] = {}
    kit_parent_prefixes: set[str] = set()

    for row in kits_rows[1:]:
        kit_sku   = safe_col(row, 1)  # col B
        child_sku = safe_col(row, 3)  # col D
        if kit_sku:
            kit_parent_prefixes.add(sku_prefix(kit_sku))
        if kit_sku and child_sku:
            child_to_kits.setdefault(child_sku, []).append(kit_sku)

    # ── Build prefix → total-sold-30d lookup ─────────────────────────────────
    prefix_to_k: dict[str, float] = {}
    for row in dash_rows[1:]:
        sku = safe_col(row, COL_SKU)
        if not sku:
            continue
        k_val = to_float(safe_col(row, COL_K), default=0) or 0
        prefix = sku_prefix(sku)
        if prefix not in prefix_to_k:
            prefix_to_k[prefix] = k_val

    # ── Pre-pass: total N and median N for AB and R ───────────────────────────
    total_n = 0.0
    n_nonblank = []
    for row in dash_rows[1:]:
        sku = safe_col(row, COL_SKU)
        if not sku:
            continue
        n_val = to_float(safe_col(row, COL_REVENUE))
        if n_val is not None:
            total_n += n_val
            n_nonblank.append(n_val)
    n_median = statistics.median(n_nonblank) if n_nonblank else 0

    # ── Per-row calculations ──────────────────────────────────────────────────
    multiplier_results = []
    bestseller_results = []
    total_stock_results = []
    drr_results        = []
    doi_results        = []
    demand_7d_results  = []
    demand_results     = []
    proj_rev_results   = []
    stock_status_results = []
    priority_results   = []
    rev_contrib_results = []
    fill_rate_results  = []
    units_fill_results = []

    blank = [""]

    for row in dash_rows[1:]:
        sku = safe_col(row, COL_SKU)
        if not sku:
            for lst in (multiplier_results, bestseller_results, total_stock_results,
                        drr_results, doi_results, demand_7d_results, demand_results,
                        proj_rev_results, stock_status_results, priority_results,
                        rev_contrib_results, fill_rate_results, units_fill_results):
                lst.append(blank)
            continue

        # Raw values
        g_val    = to_float(safe_col(row, COL_STOCK),   default=0) or 0
        i_val    = to_float(safe_col(row, COL_I),        default=0) or 0
        j_val    = to_float(safe_col(row, COL_J),        default=0) or 0
        k_val    = to_float(safe_col(row, COL_K),        default=0) or 0
        oos_days = to_float(safe_col(row, COL_OOS),      default=0) or 0
        n_val    = to_float(safe_col(row, COL_REVENUE),  default=0) or 0
        s_val    = to_float(safe_col(row, COL_S),        default=0) or 0
        npd_flag = safe_col(row, COL_NPD_FLAG)
        npd_text = safe_col(row, COL_NPD_TEXT)
        promo_q  = safe_col(row, COL_PROMO_Q)

        # T – Total Available Stock
        t_val = g_val + i_val + j_val
        total_stock_results.append([t_val])

        # U – DRR
        drr = calc_drr(k_val, oos_days)
        drr_results.append([drr if drr is not None else ""])

        # R – Bestseller
        n_raw = to_float(safe_col(row, COL_REVENUE))
        is_bestseller = 1 if (n_raw is not None and n_raw >= n_median) else 0
        bestseller_results.append([is_bestseller])

        # AB – Revenue Contribution %
        ab_val = round((n_val / total_n) * 100, 4) if total_n > 0 else 0
        rev_contrib_results.append([ab_val])

        # AA – Priority (depends on AB)
        computed_priority = calc_priority(npd_flag, promo_q, ab_val)
        priority_results.append([computed_priority])

        # M – Revenue Multiplier (depends on AA and R)
        multiplier = calc_multiplier(npd_flag, npd_text, promo_q, is_bestseller, computed_priority)
        multiplier_results.append([multiplier])

        # AC – Fill Rate
        fill_rate = round((k_val + g_val) / s_val, 4) if s_val != 0 else 0
        fill_rate_results.append([fill_rate])

        is_child = sku in child_to_kits

        # Rule 1: no DRR and not a kit child → blank derived columns
        if drr is None and not is_child:
            doi_results.append(blank)
            stock_status_results.append(blank)
            demand_7d_results.append(blank)
            demand_results.append(blank)
            proj_rev_results.append(blank)
            units_fill_results.append(blank)
            continue

        # Rule 2: kit parent → 0 demand
        if sku_prefix(sku) in kit_parent_prefixes:
            doi_results.append(blank)
            stock_status_results.append(blank)
            demand_7d_results.append([0])
            demand_results.append([0])
            proj_rev_results.append([0])
            units_fill_results.append([0])
            continue

        # V – Days of Inventory
        if drr and drr > 0:
            doi_val = round(g_val / drr, 2)
        else:
            doi_val = 0
        doi_results.append([doi_val])

        # Z – Stock Status
        stock_status_results.append([calc_stock_status(doi_val)])

        # Kit contribution (uses K from sheet)
        kit_contrib = sum(
            prefix_to_k.get(sku_prefix(kit_sku), 0)
            for kit_sku in child_to_kits.get(sku, [])
        )

        base_drr = drr or 0

        # W – Projected Demand 7d
        demand_7d = round((base_drr * 7 + kit_contrib) * multiplier, 2)
        demand_7d_results.append([demand_7d])

        # X – Projected Demand 30d
        demand_30d = round((base_drr * 30 + kit_contrib) * multiplier, 2)
        demand_results.append([demand_30d])

        # Y – Projected Revenue 30d  (ASP = N/K)
        asp = round(n_val / k_val, 4) if k_val > 0 else 0
        proj_rev = round(demand_30d * asp, 2)
        proj_rev_results.append([proj_rev])

        # AD – Units to be Filled
        units_fill = max(0, demand_30d - g_val)
        units_fill_results.append([round(units_fill, 2)])

    # ── Batch write all output columns ────────────────────────────────────────
    n_rows   = len(drr_results)
    last_row = DATA_START_ROW + n_rows - 1

    ranges = {
        "M": multiplier_results,
        "R": bestseller_results,
        "T": total_stock_results,
        "U": drr_results,
        "V": doi_results,
        "W": demand_7d_results,
        "X": demand_results,
        "Y": proj_rev_results,
        "Z": stock_status_results,
        "AA": priority_results,
        "AB": rev_contrib_results,
        "AC": fill_rate_results,
        "AD": units_fill_results,
    }

    updates = []
    for col, values in ranges.items():
        r = f"{col}{DATA_START_ROW}:{col}{last_row}"
        print(f"  Queuing {r} ({len(values)} rows)...")
        updates.append({"range": r, "values": values})

    print(f"Writing {len(updates)} columns to {DASHBOARD_TAB}...")
    dashboard.batch_update(updates, value_input_option="RAW")

    print(f"✓ Done — all columns written for {n_rows} rows.")


if __name__ == "__main__":
    main()
