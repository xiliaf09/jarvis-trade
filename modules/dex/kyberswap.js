// ============================================================
// JARVIS TRADE — KyberSwap aggregator (fallback, covers V4 + all DEXs)
// No API key needed, free.
// Used when native DEX routing fails (e.g. Uniswap V4 with hooks).
// ============================================================

const { ethers } = require('ethers');

const CHAIN_SLUG = { base: 'base', ethereum: 'ethereum', bsc: 'bsc' };
// KyberSwap uses this pseudo-address for native currency (ETH/BNB)
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

async function getRoute(chain, tokenIn, tokenOut, amountIn) {
  const slug = CHAIN_SLUG[chain];
  if (!slug) throw new Error('Unsupported chain');
  const url = `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn.toString()}&gasInclude=true`;
  const res = await fetch(url, { headers: { 'x-client-id': 'jarvis-trade' } });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Kyber route error: ${data.message || data.code}`);
  return data.data;
}

async function buildRoute(chain, routeSummary, sender, recipient, slippageBps = 100) {
  const slug = CHAIN_SLUG[chain];
  const url = `https://aggregator-api.kyberswap.com/${slug}/api/v1/route/build`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': 'jarvis-trade' },
    body: JSON.stringify({
      routeSummary,
      sender,
      recipient,
      slippageTolerance: slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 600,
      source: 'jarvis-trade',
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Kyber build error: ${data.message || data.code}`);
  return data.data;
}

async function quote(chain, tokenIn, tokenOut, amountIn) {
  const route = await getRoute(chain, tokenIn, tokenOut, amountIn);
  return BigInt(route.routeSummary.amountOut);
}

async function buyWithEth(chain, tokenOut, amountInEth, slippageBps, signer) {
  const amountIn = ethers.parseEther(amountInEth.toString());
  const userAddr = await signer.getAddress();

  const route = await getRoute(chain, NATIVE, tokenOut, amountIn);
  const build = await buildRoute(chain, route.routeSummary, userAddr, userAddr, slippageBps);

  const { runWithFallback } = require('../trading');
  const tx = await runWithFallback(chain, (provider) => {
    const signerWithProvider = signer.connect(provider);
    return signerWithProvider.sendTransaction({
      to: build.routerAddress,
      data: build.data,
      value: amountIn,
    });
  });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return {
    txHash: receipt.hash,
    amountIn,
    amountOutExpected: BigInt(route.routeSummary.amountOut),
    amountOutMin: BigInt(build.amountOut || route.routeSummary.amountOut),
    gasUsed: receipt.gasUsed,
  };
}

async function sellToEth(chain, tokenIn, amountIn, slippageBps, signer) {
  const userAddr = await signer.getAddress();

  // Use NATIVE pseudo-address for ETH output (receive native, not WETH)
  const route = await getRoute(chain, tokenIn, NATIVE, amountIn);
  const build = await buildRoute(chain, route.routeSummary, userAddr, userAddr, slippageBps);

  const { runWithFallback, waitForReceiptResilient } = require('../trading');

  // Approve Kyber router to spend the token (with RPC fallback)
  const allowance = await runWithFallback(chain, async (provider) => {
    const t = new ethers.Contract(tokenIn, ERC20_ABI, provider);
    return t.allowance(userAddr, build.routerAddress);
  });
  if (allowance < amountIn) {
    const approveTx = await runWithFallback(chain, (provider) => {
      const s = signer.connect(provider);
      const t = new ethers.Contract(tokenIn, ERC20_ABI, s);
      return t.approve(build.routerAddress, ethers.MaxUint256);
    });
    try { await approveTx.wait(); }
    catch (_) { await waitForReceiptResilient(chain, approveTx.hash); }
  }

  const tx = await runWithFallback(chain, (provider) => {
    const signerWithProvider = signer.connect(provider);
    return signerWithProvider.sendTransaction({
      to: build.routerAddress,
      data: build.data,
    });
  });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return {
    txHash: receipt.hash,
    amountIn,
    amountOutExpected: BigInt(route.routeSummary.amountOut),
    amountOutMin: BigInt(build.amountOut || route.routeSummary.amountOut),
    gasUsed: receipt.gasUsed,
  };
}

module.exports = { getRoute, buildRoute, quote, buyWithEth, sellToEth };
