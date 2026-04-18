// ============================================================
// JARVIS TRADE — Price oracle (DexScreener)
// ============================================================
//
// Fetches real-time prices for tokens via DexScreener.
// Free, no API key, supports all major chains.
// ============================================================

const _cache = new Map(); // key: `${chain}_${tokenAddr}` → { priceUsd, liquidityUsd, volume24h, symbol, ts }
const CACHE_TTL = 30_000; // 30s

const CHAIN_MAP = {
  base: 'base',
  ethereum: 'ethereum',
};

/**
 * Get price for a single token
 */
async function getTokenPrice(chain, tokenAddress) {
  const key = `${chain}_${tokenAddress.toLowerCase()}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;

    // Filter by chain
    const chainPairs = pairs.filter(p => p.chainId === CHAIN_MAP[chain]);
    if (chainPairs.length === 0) return null;

    // Pick pair with highest liquidity
    chainPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = chainPairs[0];

    const result = {
      priceUsd: parseFloat(best.priceUsd || 0),
      priceNative: parseFloat(best.priceNative || 0),
      liquidityUsd: best.liquidity?.usd || 0,
      volume24h: best.volume?.h24 || 0,
      priceChange24h: best.priceChange?.h24 || 0,
      symbol: best.baseToken?.symbol || 'UNKNOWN',
      name: best.baseToken?.name || '',
      dex: best.dexId || '',
      pairAddress: best.pairAddress,
      ts: Date.now(),
    };
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.error(`⚠️  DexScreener fetch failed for ${tokenAddress}:`, err.message);
    return cached || null;
  }
}

/**
 * Get ETH price in USD (via DexScreener, using WETH pair)
 */
async function getEthPrice() {
  // Use WETH on Base as canonical ETH price source (highly liquid)
  const wethBase = '0x4200000000000000000000000000000000000006';
  const r = await getTokenPrice('base', wethBase);
  return r?.priceUsd || 0;
}

/**
 * Batch fetch multiple tokens
 */
async function getTokenPrices(chain, tokenAddresses) {
  const results = {};
  await Promise.all(tokenAddresses.map(async (addr) => {
    results[addr.toLowerCase()] = await getTokenPrice(chain, addr);
  }));
  return results;
}

module.exports = {
  getTokenPrice,
  getEthPrice,
  getTokenPrices,
};
