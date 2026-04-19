// ============================================================
// JARVIS TRADE — Trade execution orchestrator (multi-chain EVM)
// ============================================================

const { ethers } = require('ethers');
const uniswap = require('./dex/uniswap');
const uniswapV2 = require('./dex/uniswap_v2');
const aerodrome = require('./dex/aerodrome');
const pancake = require('./dex/pancakeswap');
const kyber = require('./dex/kyberswap');

let _providers = {};
let _config = null;

const ALT_RPCS = {
  base: ['https://base.llamarpc.com', 'https://mainnet.base.org', 'https://base.publicnode.com'],
  ethereum: ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth'],
  bsc: ['https://binance.llamarpc.com', 'https://bsc.publicnode.com', 'https://bsc-dataseed.binance.org'],
};

// All providers per chain (primary + alts), used for manual retry
const _allProviders = {};

function init(config) {
  _config = config;
  const makeProvider = (url, chainId, name) => new ethers.JsonRpcProvider(url, { chainId, name }, { staticNetwork: true, batchMaxCount: 1 });
  const chainSpec = { base: [8453, 'base'], ethereum: [1, 'ethereum'], bsc: [56, 'bsc'] };

  for (const [chain, [chainId, name]] of Object.entries(chainSpec)) {
    const urls = [config.rpcs[chain], ...(ALT_RPCS[chain] || [])];
    _allProviders[chain] = urls.map(url => makeProvider(url, chainId, name));
    _providers[chain] = _allProviders[chain][0]; // primary
  }
  console.log('💱 Trading module ready — multi-RPC resilience (primary + ' + (ALT_RPCS.base.length) + ' fallbacks)');
}

/**
 * Run an action across RPC providers until one succeeds.
 * Used for tx broadcast when primary RPC is rate-limited or down.
 */
async function runWithFallback(chain, fn) {
  const providers = _allProviders[chain] || [_providers[chain]];
  let lastErr = null;
  for (const p of providers) {
    try {
      return await fn(p);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All RPCs failed');
}

function getProvider(chain) {
  const p = _providers[chain];
  if (!p) throw new Error(`No provider for ${chain}`);
  return p;
}

function getNativeSymbol(chain) {
  return _config.chains[chain]?.symbol || 'ETH';
}

function getWethAddress(chain) {
  return _config.chains[chain].wethAddress;
}

/**
 * Get a quote across all DEXs available on the chain
 */
async function getBestQuote(chain, tokenIn, tokenOut, amountIn) {
  const provider = getProvider(chain);
  const quotes = [];

  // Uniswap V3 — Base + Ethereum
  if (chain === 'base' || chain === 'ethereum') {
    try {
      const { fee } = await uniswap.findBestPool(chain, tokenIn, tokenOut, provider);
      const { amountOut } = await uniswap.quoteExactInput(chain, tokenIn, tokenOut, amountIn, fee, provider);
      quotes.push({ dex: 'uniswap_v3', fee, amountOut });
    } catch (_) {}
  }

  // Aerodrome — Base only
  if (chain === 'base') {
    try {
      const { stable } = await aerodrome.findPool(tokenIn, tokenOut, provider);
      const amountOut = await aerodrome.quote(tokenIn, tokenOut, amountIn, stable, provider);
      quotes.push({ dex: 'aerodrome', stable, amountOut });
    } catch (_) {}
  }

  // PancakeSwap V3 — all supported EVM chains
  try {
    const { fee } = await pancake.findBestPool(tokenIn, tokenOut, provider, chain);
    const { amountOut } = await pancake.quoteExactInput(tokenIn, tokenOut, amountIn, fee, provider, chain);
    quotes.push({ dex: 'pancakeswap_v3', fee, amountOut });
  } catch (_) {}

  // Uniswap V2 — Base + Ethereum
  if (chain === 'base' || chain === 'ethereum') {
    try {
      await uniswapV2.findPool(chain, tokenIn, tokenOut, provider);
      const amountOut = await uniswapV2.quote(chain, tokenIn, tokenOut, amountIn, provider);
      quotes.push({ dex: 'uniswap_v2', amountOut });
    } catch (_) {}
  }

  // KyberSwap aggregator — fallback, covers V4 + hooks + all remaining DEXs
  if (quotes.length === 0) {
    try {
      // Kyber needs NATIVE pseudo-address (0xEeee...) for ETH, not WETH
      const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
      const wethAddr = getWethAddress(chain);
      const kIn = tokenIn.toLowerCase() === wethAddr.toLowerCase() ? KYBER_NATIVE : tokenIn;
      const kOut = tokenOut.toLowerCase() === wethAddr.toLowerCase() ? KYBER_NATIVE : tokenOut;
      const amountOut = await kyber.quote(chain, kIn, kOut, amountIn);
      if (amountOut > 0n) quotes.push({ dex: 'kyberswap', amountOut });
    } catch (_) {}
  }

  if (quotes.length === 0) throw new Error('No route found (Uniswap V3/V2, Aerodrome, PancakeSwap V3, KyberSwap aggregator)');
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  return quotes[0];
}

async function buy(chain, tokenOut, amountInNative, slippageBps, signer) {
  const wethAddr = getWethAddress(chain);
  const amountIn = ethers.parseEther(amountInNative.toString());
  const best = await getBestQuote(chain, wethAddr, tokenOut, amountIn);

  if (best.dex === 'uniswap_v3') {
    return { ...(await uniswap.buyWithEth(chain, tokenOut, amountInNative, slippageBps, signer)), dex: 'uniswap_v3' };
  }
  if (best.dex === 'aerodrome') {
    return { ...(await aerodrome.buyWithEth(tokenOut, amountInNative, slippageBps, signer)), dex: 'aerodrome' };
  }
  if (best.dex === 'pancakeswap_v3') {
    return { ...(await pancake.buyWithNative(tokenOut, amountInNative, slippageBps, signer, chain)), dex: 'pancakeswap_v3' };
  }
  if (best.dex === 'uniswap_v2') {
    return { ...(await uniswapV2.buyWithEth(chain, tokenOut, amountInNative, slippageBps, signer)), dex: 'uniswap_v2' };
  }
  if (best.dex === 'kyberswap') {
    return { ...(await kyber.buyWithEth(chain, tokenOut, amountInNative, slippageBps, signer)), dex: 'kyberswap' };
  }
  throw new Error('Unknown DEX');
}

async function sell(chain, tokenIn, amountIn, slippageBps, signer) {
  const wethAddr = getWethAddress(chain);
  const best = await getBestQuote(chain, tokenIn, wethAddr, amountIn);

  if (best.dex === 'uniswap_v3') {
    return { ...(await uniswap.sellToEth(chain, tokenIn, amountIn, slippageBps, signer)), dex: 'uniswap_v3' };
  }
  if (best.dex === 'aerodrome') {
    return { ...(await aerodrome.sellToEth(tokenIn, amountIn, slippageBps, signer)), dex: 'aerodrome' };
  }
  if (best.dex === 'pancakeswap_v3') {
    return { ...(await pancake.sellToNative(tokenIn, amountIn, slippageBps, signer, chain)), dex: 'pancakeswap_v3' };
  }
  if (best.dex === 'uniswap_v2') {
    return { ...(await uniswapV2.sellToEth(chain, tokenIn, amountIn, slippageBps, signer)), dex: 'uniswap_v2' };
  }
  if (best.dex === 'kyberswap') {
    return { ...(await kyber.sellToEth(chain, tokenIn, amountIn, slippageBps, signer)), dex: 'kyberswap' };
  }
  throw new Error('Unknown DEX');
}

async function getTokenInfo(chain, tokenAddress, walletAddress) {
  return uniswap.getTokenInfo(chain, tokenAddress, walletAddress, getProvider(chain));
}

async function getNativeBalance(chain, walletAddress) {
  return getProvider(chain).getBalance(walletAddress);
}

// Legacy alias
async function getEthBalance(chain, walletAddress) {
  return getNativeBalance(chain, walletAddress);
}

async function getGasPriceGwei(chain) {
  try {
    const feeData = await getProvider(chain).getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
    return parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
  } catch (_) { return 0; }
}

/**
 * Get on-chain token balance with multi-RPC retry.
 * Returns the first non-zero result, or 0 if all RPCs return 0.
 */
async function getOnChainTokenBalance(chain, tokenAddr, walletAddr) {
  const balanceAbi = ['function balanceOf(address) view returns (uint256)'];
  const providers = [_providers[chain], ...(ALT_RPCS[chain] || []).map(url => new ethers.JsonRpcProvider(url))];
  let lastResult = 0n;
  for (const p of providers) {
    try {
      const token = new ethers.Contract(tokenAddr, balanceAbi, p);
      const bal = await token.balanceOf(walletAddr);
      if (bal > 0n) return bal;
      lastResult = bal;
    } catch (_) {}
  }
  return lastResult;
}

/**
 * Wait for a tx receipt with RPC fallback — if primary RPC fails, try alt RPCs.
 * Used when tx.wait() fails due to flaky RPC (dRPC internal errors are common).
 */
async function waitForReceiptResilient(chain, txHash, timeoutMs = 60000) {
  const providers = [
    _providers[chain],
    ...(ALT_RPCS[chain] || []).map(url => new ethers.JsonRpcProvider(url)),
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const p of providers) {
      try {
        const receipt = await p.getTransactionReceipt(txHash);
        if (receipt) return receipt;
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Receipt timeout — tx may still be pending');
}

module.exports = {
  init,
  getProvider,
  getNativeSymbol,
  getWethAddress,
  getBestQuote,
  buy,
  sell,
  getTokenInfo,
  getNativeBalance,
  getEthBalance,
  getGasPriceGwei,
  waitForReceiptResilient,
  getOnChainTokenBalance,
  runWithFallback,
};
