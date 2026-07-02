STATE OF LENDING ON SUI — JUNE 2026 DATA EXPORT
Generated: 2026-07-02T18:58:14.608Z  |  Window: 2026-06-01 .. 2026-06-30
Protocols: NAVI, Suilend, Scallop, AlphaLend, Bucket

FILES
  01_markets_daily.csv       Per protocol/market/day: APY (base, excl. incentives), utilization, close supply/borrow/liquidity USD, price. Source: PoolDaily.
  02_tvl_daily.csv           Per protocol/day TVL (USD). Source: DefiLlama (report-canonical).
  03_liquidation_events.csv  Every June liquidation >= $1 (debt OR collateral). anomaly_over_2m flags suspect-price events.
  04_composition_jun30.csv   Latest supply/borrow USD per market in the Jun 28-30 window (month-end snapshot).
  05_risk_params.csv         Current risk parameters per protocol/market (RateModelParams), raw.
  06_tvl_summary.csv         Per protocol Jun 1 vs Jun 30 TVL + % change.
  07_jun30_shares.csv        Jun 30 TVL share per protocol.
  08_liquidations_summary.csv Per protocol event counts, debt, seized, unique liquidators.
  09_liquidations_weekly.csv Weekly liquidation events + debt.
  10_liquidations_daily.csv  Daily liquidation events/debt/seized per protocol.
  11_top_liquidators.csv     Top liquidator per protocol + share.
  12_coverage.csv            Per protocol day-coverage + any missing PoolDaily dates.

KNOWN DATA-QUALITY FLAGS (do not publish without handling — surfaced by june-audit.ts):
  1. AlphaLend DefiLlama TVL reads $0 on Jun 30 (02/06 CSVs) — a DefiLlama gap, not a real collapse;
     04_composition shows AlphaLend alive (~$108M supply). This distorts the sector -30% figure (real ~ -17%).
  2. NAVI liquidation on 2026-06-24 (wUSDT priced ~$60,481) = $401.87M phantom collateral (flagged
     anomaly_over_2m=true in 03). Inflates NAVI seized in 08/10; real NAVI seized is ~$0.75M.
  3. Bucket liquidationThreshold in 05 is stored as a percent (e.g. 90.91) while other protocols store a
     fraction (0.90) — a units inconsistency, not a real 9091% threshold.

METHODOLOGY: liquidations use the $1 OR filter (debtUsd>=1 OR collateralUsd>=1); TVL is DefiLlama-canonical;
composition is a month-end (Jun 28-30) latest-snapshot read; APYs are base rates (exclude token incentives).
