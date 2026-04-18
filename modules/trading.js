// ============================================================
// JARVIS TRADE — Trade execution orchestrator
// ============================================================
//
// Tries Uniswap V3 first (best liquidity for most pairs), falls back
// to Aerodrome on Base if no V3 pool exists.
// ============================================================

const { ethers } = require('ethers');
const uniswap = require('./dex/uniswap');
const aerodrome = require('./dex/aerodrome');

let _providers = {};

function init(rpcs) {
  _providers.base = new ethers.JsonRpcProvider(rpcs.base, { chainId: 8453, name: 'base' });
  _providers.ethereum = new ethers.JsonRpcProvider(rpcs.ethereum, { chainId: 1, name: 'ethereum' });
  console.log('💱 Trading module initialized (DEX direct: Uniswap V3 + Aerodrome)');
}

function getProvider(chain) {
  const p = _providers[chain];
  if (!p) throw new Error(`No provider for chain ${chain}`);
  return p;
}

/**
 * Get a quote across all DEXs, return the best one
 */
async function getBestQuote(chain, tokenIn, tokenOut, amountIn) {
  const provider = getProvider(chain);
  const quotes = [];

  // Try Uniswap V3
  try {
    const { fee } = await uniswap.findBestPool(chain, tokenIn, tokenOut, provider);
    const { amountOut } = await uniswap.quoteExactInput(chain, tokenIn, tokenOut, amountIn, fee, provider);
    quotes.push({ dex: 'uniswap_v3', fee, amountOut });
  } catch (_) {}

  // Try Aerodrome (Base only)
  if (chain === 'base') {
    try {
      const { stable } = await aerodrome.findPool(tokenIn, tokenOut, provider);
      const amountOut = await aerodrome.quote(tokenIn, tokenOut, amountIn, stable, provider);
      quotes.push({ dex: 'aerodrome', stable, amountOut });
    } catch (_) {}
  }

  if (quotes.length === 0) throw new Error('No route found on any DEX');

  // Sort by amountOut desc, return best
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  return quotes[0];
}

/**
 * BUY: ETH → Token. Auto-routes to best DEX.
 */
async function buy(chain, tokenOut, amountInEth, slippageBps, signer) {
  const provider = getProvider(chain);
  const amountIn = ethers.parseEther(amountInEth.toString());
  const wethAddr = chain === 'base' ? uniswap.ADDRESSES.base.weth : uniswap.ADDRESSES.ethereum.weth;

  // Determine best DEX
  const best = await getBestQuote(chain, wethAddr, tokenOut, amountIn);

  if (best.dex === 'uniswap_v3') {
    return { ...(await uniswap.buyWithEth(chain, tokenOut, amountInEth, slippageBps, signer)), dex: 'uniswap_v3' };
  } else if (best.dex === 'aerodrome') {
    return { ...(await aerodrome.buyWithEth(tokenOut, amountInEth, slippageBps, signer)), dex: 'aerodrome' };
  }
  throw new Error('Unknown DEX');
}

/**
 * SELL: Token → ETH. Auto-routes to best DEX.
 */
async function sell(chain, tokenIn, amountIn, slippageBps, signer) {
  const provider = getProvider(chain);
  const wethAddr = chain === 'base' ? uniswap.ADDRESSES.base.weth : uniswap.ADDRESSES.ethereum.weth;

  const best = await getBestQuote(chain, tokenIn, wethAddr, amountIn);

  if (best.dex === 'uniswap_v3') {
    return { ...(await uniswap.sellToEth(chain, tokenIn, amountIn, slippageBps, signer)), dex: 'uniswap_v3' };
  } else if (best.dex === 'aerodrome') {
    return { ...(await aerodrome.sellToEth(tokenIn, amountIn, slippageBps, signer)), dex: 'aerodrome' };
  }
  throw new Error('Unknown DEX');
}

/**
 * Get token metadata + balance
 */
async function getTokenInfo(chain, tokenAddress, walletAddress) {
  return uniswap.getTokenInfo(chain, tokenAddress, walletAddress, getProvider(chain));
}

/**
 * Get ETH balance for a wallet
 */
async function getEthBalance(chain, walletAddress) {
  const provider = getProvider(chain);
  const balance = await provider.getBalance(walletAddress);
  return balance;
}

module.exports = {
  init,
  getProvider,
  getBestQuote,
  buy,
  sell,
  getTokenInfo,
  getEthBalance,
};
