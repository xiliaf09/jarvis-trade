// ============================================================
// JARVIS TRADE — Aerodrome DEX integration (Base only)
// ============================================================
//
// Aerodrome is a Velodrome-style DEX on Base (ve(3,3) model).
// Uses a classic Router (similar to Uniswap V2) with stable/volatile pools.
// ============================================================

const { ethers } = require('ethers');

const ADDRESSES = {
  router:   '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', // Aerodrome Router
  factory:  '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // Aerodrome Pool Factory
  weth:     '0x4200000000000000000000000000000000000006',
};

const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[])',
];

const FACTORY_ABI = [
  'function getPool(address,address,bool) view returns (address)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

/**
 * Check if a pool exists (either stable or volatile)
 */
async function findPool(tokenIn, tokenOut, provider) {
  const factory = new ethers.Contract(ADDRESSES.factory, FACTORY_ABI, provider);
  // Try volatile first (most common for new tokens)
  const volatile = await factory.getPool(tokenIn, tokenOut, false).catch(() => ethers.ZeroAddress);
  if (volatile !== ethers.ZeroAddress) return { pool: volatile, stable: false };
  const stable = await factory.getPool(tokenIn, tokenOut, true).catch(() => ethers.ZeroAddress);
  if (stable !== ethers.ZeroAddress) return { pool: stable, stable: true };
  throw new Error('No Aerodrome pool found');
}

/**
 * Quote via getAmountsOut
 */
async function quote(tokenIn, tokenOut, amountIn, stable, provider) {
  const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, provider);
  const routes = [{ from: tokenIn, to: tokenOut, stable, factory: ADDRESSES.factory }];
  const amounts = await router.getAmountsOut(amountIn, routes);
  return amounts[amounts.length - 1];
}

/**
 * BUY: ETH → Token
 */
async function buyWithEth(tokenOut, amountInEth, slippageBps, signer, deadlineSec = 300) {
  const provider = signer.provider;
  const amountIn = ethers.parseEther(amountInEth.toString());

  const { stable } = await findPool(ADDRESSES.weth, tokenOut, provider);
  const amountOut = await quote(ADDRESSES.weth, tokenOut, amountIn, stable, provider);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, signer);
  const routes = [{ from: ADDRESSES.weth, to: tokenOut, stable, factory: ADDRESSES.factory }];
  const deadline = Math.floor(Date.now() / 1000) + deadlineSec;

  const tx = await router.swapExactETHForTokens(minOut, routes, await signer.getAddress(), deadline, {
    value: amountIn,
  });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient('base', tx.hash);
  }
  return {
    txHash: receipt.hash,
    amountIn,
    amountOutExpected: amountOut,
    amountOutMin: minOut,
    stable,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * SELL: Token → ETH
 */
async function sellToEth(tokenIn, amountIn, slippageBps, signer, deadlineSec = 300) {
  const provider = signer.provider;
  const userAddr = await signer.getAddress();

  const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const allowance = await token.allowance(userAddr, ADDRESSES.router);
  if (allowance < amountIn) {
    const approveTx = await token.approve(ADDRESSES.router, ethers.MaxUint256);
    try { await approveTx.wait(); }
    catch (_) {
      const { waitForReceiptResilient } = require('../trading');
      await waitForReceiptResilient('base', approveTx.hash);
    }
  }

  const { stable } = await findPool(tokenIn, ADDRESSES.weth, provider);
  const amountOut = await quote(tokenIn, ADDRESSES.weth, amountIn, stable, provider);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, signer);
  const routes = [{ from: tokenIn, to: ADDRESSES.weth, stable, factory: ADDRESSES.factory }];
  const deadline = Math.floor(Date.now() / 1000) + deadlineSec;

  const tx = await router.swapExactTokensForETH(amountIn, minOut, routes, userAddr, deadline);
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient('base', tx.hash);
  }
  return {
    txHash: receipt.hash,
    amountIn,
    amountOutExpected: amountOut,
    amountOutMin: minOut,
    stable,
    gasUsed: receipt.gasUsed,
  };
}

module.exports = {
  ADDRESSES,
  findPool,
  quote,
  buyWithEth,
  sellToEth,
};
