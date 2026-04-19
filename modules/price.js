// ============================================================
// JARVIS TRADE — Price oracle (DexScreener + CoinGecko)
// ============================================================

const _cache = new Map();
const CACHE_TTL = 30_000;

const CHAIN_MAP = {
  base: 'base',
  ethereum: 'ethereum',
  bsc: 'bsc',
};

async function getTokenPrice(chain, tokenAddress) {
  const key = `${chain}_${tokenAddress.toLowerCase()}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pairs = (data.pairs || []).filter(p => p.chainId === CHAIN_MAP[chain]);
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = pairs[0];

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
      fdv: best.fdv || 0,
      ts: Date.now(),
    };
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.error(`⚠️  DexScreener fetch failed:`, err.message);
    return cached || null;
  }
}

/**
 * Get native coin price (ETH for base/ethereum, BNB for bsc)
 */
async function getNativePrice(chain) {
  const wethMap = {
    base: '0x4200000000000000000000000000000000000006',
    ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  };
  const addr = wethMap[chain];
  if (!addr) return 0;
  const r = await getTokenPrice(chain, addr);
  return r?.priceUsd || 0;
}

// Legacy: ETH on base
async function getEthPrice() {
  return getNativePrice('base');
}

async function getTokenPrices(chain, tokenAddresses) {
  const results = {};
  await Promise.all(tokenAddresses.map(async (addr) => {
    results[addr.toLowerCase()] = await getTokenPrice(chain, addr);
  }));
  return results;
}

module.exports = { getTokenPrice, getNativePrice, getEthPrice, getTokenPrices };
