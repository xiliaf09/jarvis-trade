// ============================================================
// JARVIS TRADE — PancakeSwap V3 (BSC)
// ============================================================
// Same structure as Uniswap V3 but with PancakeSwap-specific addresses
// and fee tiers (100, 500, 2500, 10000)
// ============================================================

const { ethers } = require('ethers');

// PancakeSwap V3 addresses per chain
const ADDRESSES_BY_CHAIN = {
  bsc: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter:  '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    router:  '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
    weth:    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },
  base: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter:  '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    router:  '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    weth:    '0x4200000000000000000000000000000000000006',
  },
  ethereum: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter:  '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    router:  '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    weth:    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
};

// Legacy BSC-only alias
const ADDRESSES = ADDRESSES_BY_CHAIN.bsc;

const FEE_TIERS = [100, 500, 2500, 10000];

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI = ['function liquidity() view returns (uint128)'];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
// PancakeSwap SmartRouter has same exactInputSingle signature as Uniswap V3
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function refundETH() payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

async function findBestPool(tokenIn, tokenOut, provider, chain = 'bsc') {
  const addrs = ADDRESSES_BY_CHAIN[chain] || ADDRESSES_BY_CHAIN.bsc;
  const factory = new ethers.Contract(addrs.factory, FACTORY_ABI, provider);
  let bestFee = null, bestLiq = 0n, bestPool = null;
  for (const fee of FEE_TIERS) {
    try {
      const addr = await factory.getPool(tokenIn, tokenOut, fee);
      if (addr === ethers.ZeroAddress) continue;
      const pool = new ethers.Contract(addr, POOL_ABI, provider);
      const liq = await pool.liquidity();
      if (liq > bestLiq) { bestLiq = liq; bestFee = fee; bestPool = addr; }
    } catch (_) {}
  }
  if (bestFee === null) throw new Error('No PancakeSwap V3 pool found');
  return { fee: bestFee, pool: bestPool, liquidity: bestLiq };
}

async function quoteExactInput(tokenIn, tokenOut, amountIn, fee, provider, chain = 'bsc') {
  const addrs = ADDRESSES_BY_CHAIN[chain] || ADDRESSES_BY_CHAIN.bsc;
  const quoter = new ethers.Contract(addrs.quoter, QUOTER_ABI, provider);
  const result = await quoter.quoteExactInputSingle.staticCall({
    tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
  });
  return { amountOut: result[0], gasEstimate: result[3] };
}

async function buyWithNative(tokenOut, amountInNative, slippageBps, signer, chain = 'bsc') {
  const provider = signer.provider;
  const addrs = ADDRESSES_BY_CHAIN[chain] || ADDRESSES_BY_CHAIN.bsc;
  const amountIn = ethers.parseEther(amountInNative.toString());
  const { fee } = await findBestPool(addrs.weth, tokenOut, provider, chain);
  const { amountOut } = await quoteExactInput(addrs.weth, tokenOut, amountIn, fee, provider, chain);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  const router = new ethers.Contract(addrs.router, ROUTER_ABI, signer);
  const tx = await router.exactInputSingle({
    tokenIn: addrs.weth, tokenOut, fee,
    recipient: await signer.getAddress(),
    amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
  }, { value: amountIn });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amountIn, amountOutExpected: amountOut, amountOutMin: minOut, fee, gasUsed: receipt.gasUsed };
}

async function sellToNative(tokenIn, amountIn, slippageBps, signer, chain = 'bsc') {
  const provider = signer.provider;
  const userAddr = await signer.getAddress();
  const addrs = ADDRESSES_BY_CHAIN[chain] || ADDRESSES_BY_CHAIN.bsc;

  const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const allowance = await token.allowance(userAddr, addrs.router);
  if (allowance < amountIn) {
    const approveTx = await token.approve(addrs.router, ethers.MaxUint256);
    try { await approveTx.wait(); }
    catch (_) {
      const { waitForReceiptResilient } = require('../trading');
      await waitForReceiptResilient(chain, approveTx.hash);
    }
  }

  const { fee } = await findBestPool(tokenIn, addrs.weth, provider, chain);
  const { amountOut } = await quoteExactInput(tokenIn, addrs.weth, amountIn, fee, provider, chain);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  const router = new ethers.Contract(addrs.router, ROUTER_ABI, signer);
  const swapData = router.interface.encodeFunctionData('exactInputSingle', [{
    tokenIn, tokenOut: addrs.weth, fee,
    recipient: addrs.router,
    amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
  }]);
  const unwrapData = router.interface.encodeFunctionData('unwrapWETH9', [minOut, userAddr]);

  const tx = await router.multicall([swapData, unwrapData]);
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amountIn, amountOutExpected: amountOut, amountOutMin: minOut, fee, gasUsed: receipt.gasUsed };
}

module.exports = { ADDRESSES, FEE_TIERS, findBestPool, quoteExactInput, buyWithNative, sellToNative };
