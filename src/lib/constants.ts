// ─── NAVI Protocol Constants ────────────────────────────────────────────────

export const NAVI_LENDING_PACKAGE =
  '0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb';

export const NAVI_EVENT_TYPES = {
  DEPOSIT: `${NAVI_LENDING_PACKAGE}::event::DepositEvent`,
  WITHDRAW: `${NAVI_LENDING_PACKAGE}::event::WithdrawEvent`,
  BORROW: `${NAVI_LENDING_PACKAGE}::event::BorrowEvent`,
  REPAY: `${NAVI_LENDING_PACKAGE}::event::RepayEvent`,
  LIQUIDATION_CALL: `${NAVI_LENDING_PACKAGE}::event::LiquidationCallEvent`,
  LIQUIDATION: `${NAVI_LENDING_PACKAGE}::event::LiquidationEvent`,
  STATE_UPDATED: `${NAVI_LENDING_PACKAGE}::event::StateUpdated`,
} as const;

// ─── Pool Configurations ────────────────────────────────────────────────────

export interface PoolConfig {
  poolId: number;
  coinType: string;
  decimals: number;
  symbol: string;
  name: string;
  color: string;
}

export const POOL_CONFIGS: Record<string, PoolConfig> = {
  SUI: {
    poolId: 0,
    coinType: '0x2::sui::SUI',
    decimals: 9,
    symbol: 'SUI',
    name: 'Sui',
    color: '#4DA2FF',
  },
  USDC: {
    poolId: 1,
    coinType:
      '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
    color: '#2775CA',
  },
  USDT: {
    poolId: 2,
    coinType:
      '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether',
    color: '#26A17B',
  },
  WETH: {
    poolId: 3,
    coinType:
      '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN',
    decimals: 8,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    color: '#627EEA',
  },
  CETUS: {
    poolId: 4,
    coinType:
      '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
    decimals: 9,
    symbol: 'CETUS',
    name: 'Cetus',
    color: '#2E67F8',
  },
  vSUI: {
    poolId: 5,
    coinType:
      '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT',
    decimals: 9,
    symbol: 'vSUI',
    name: 'Volo Staked SUI',
    color: '#9945FF',
  },
  NAVX: {
    poolId: 6,
    coinType:
      '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX',
    decimals: 9,
    symbol: 'NAVX',
    name: 'NAVI Token',
    color: '#FF6B35',
  },
  haSUI: {
    poolId: 7,
    coinType:
      '0xbde4ba4c2e274a60ce15c1cfff9e5c42e136a8bc::hasui::HASUI',
    decimals: 9,
    symbol: 'haSUI',
    name: 'Haedal Staked SUI',
    color: '#00D4AA',
  },
};

export const POOL_ID_TO_SYMBOL: Record<number, string> = Object.fromEntries(
  Object.values(POOL_CONFIGS).map((c) => [c.poolId, c.symbol])
);

export const POOL_SYMBOLS = Object.keys(POOL_CONFIGS);

// ─── Rate Constants ─────────────────────────────────────────────────────────

export const RATE_SCALE = '1000000000000000000000000000'; // 1e27

// ─── Health Factor Colors ───────────────────────────────────────────────────

export function healthFactorColor(hf: number): string {
  if (hf < 1.0) return '#EF4444'; // red — liquidatable
  if (hf < 1.2) return '#F97316'; // orange — critical
  if (hf < 1.5) return '#EAB308'; // yellow — warning
  return '#22C55E'; // green — safe
}

export function healthFactorLabel(hf: number): string {
  if (hf < 1.0) return 'Liquidatable';
  if (hf < 1.2) return 'Critical';
  if (hf < 1.5) return 'Warning';
  return 'Safe';
}

// ─── Cron Auth ──────────────────────────────────────────────────────────────

// Fail closed. If CRON_SECRET is unset, every cron route rejects the request.
// The previous 'dev-secret' fallback meant an unconfigured deploy accepted a
// guessable bearer token. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
// only when the env var is set on the project, so this is safe in production.
export const CRON_SECRET: string | undefined = process.env.CRON_SECRET;

export function cronAuthorized(authHeader: string | null | undefined): boolean {
  return !!CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
}
