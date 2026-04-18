// ============================================================
// JARVIS TRADE — Uniswap V3 direct integration
// ============================================================
//
// Works on both Ethereum mainnet and Base.
// Flow:
//   1. Find the best V3 pool (fee tier 100/500/3000/10000) by liquidity
//   2. Get quote via Quoter V2
//   3. Execute swap via SwapRouter02 (exactInputSingle)
// ============================================================

const { ethers } = require('ethers');

// Contract addresses per chain
const ADDRESSES = {
  base: {
    factory:    '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // Uniswap V3 Factory
    quoter:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // QuoterV2
    router:     '0x2626664c2603336E57B271c5C0b26F421741e481', // SwapRouter02
    weth:       '0x4200000000000000000000000000000000000006',
  },
  ethereum: {
    factory:    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router:     '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    weth:       '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
};

const FEE_TIERS = [100, 500, 3000, 10000];

// Minimal ABIs
const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
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

/**
 * Find the V3 pool with the best liquidity for tokenIn/tokenOut
 */
async function findBestPool(chain, tokenIn, tokenOut, provider) {
  const addrs = ADDRESSES[chain];
  const factory = new ethers.Contract(addrs.factory, FACTORY_ABI, provider);

  let bestFee = null;
  let bestLiquidity = 0n;
  let bestPool = null;

  for (const fee of FEE_TIERS) {
    try {
      const poolAddr = await factory.getPool(tokenIn, tokenOut, fee);
      if (poolAddr === ethers.ZeroAddress) continue;
      const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
      const liquidity = await pool.liquidity();
      if (liquidity > bestLiquidity) {
        bestLiquidity = liquidity;
        bestFee = fee;
        bestPool = poolAddr;
      }
    } catch (_) {}
  }

  if (bestFee === null) throw new Error(`No V3 pool found for ${tokenIn.slice(0,8)}/${tokenOut.slice(0,8)}`);
  return { fee: bestFee, pool: bestPool, liquidity: bestLiquidity };
}

/**
 * Quote exact input via Quoter V2 (callStatic)
 */
async function quoteExactInput(chain, tokenIn, tokenOut, amountIn, fee, provider) {
  const addrs = ADDRESSES[chain];
  const quoter = new ethers.Contract(addrs.quoter, QUOTER_ABI, provider);
  try {
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0,
    });
    return {
      amountOut: result[0],
      gasEstimate: result[3],
    };
  } catch (err) {
    throw new Error(`Quote failed: ${err.message.slice(0, 100)}`);
  }
}

/**
 * BUY: ETH → Token (exactInputSingle with ETH wrapping)
 */
async function buyWithEth(chain, tokenOut, amountInEth, slippageBps, signer, deadlineSec = 300) {
  const addrs = ADDRESSES[chain];
  const provider = signer.provider;
  const amountIn = ethers.parseEther(amountInEth.toString());

  // 1. Find best pool (WETH → tokenOut)
  const { fee } = await findBestPool(chain, addrs.weth, tokenOut, provider);

  // 2. Quote
  const { amountOut } = await quoteExactInput(chain, addrs.weth, tokenOut, amountIn, fee, provider);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  // 3. Execute swap with ETH value
  const router = new ethers.Contract(addrs.router, ROUTER_ABI, signer);
  const params = {
    tokenIn: addrs.weth,
    tokenOut,
    fee,
    recipient: await signer.getAddress(),
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0,
  };

  const tx = await router.exactInputSingle(params, {
    value: amountIn,
    // Note: gas estimation done by ethers automatically; we can add gasLimit buffer if needed
  });
  const receipt = await tx.wait();
  return {
    txHash: receipt.hash,
    amountIn,
    amountOutExpected: amountOut,
    amountOutMin: minOut,
    fee,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * SELL: Token → ETH
 */
async function sellToEth(chain, tokenIn, amountIn, slippageBps, signer, deadlineSec = 300) {
  const addrs = ADDRESSES[chain];
  const provider = signer.provider;
  const userAddr = await signer.getAddress();

  // 1. Ensure allowance
  const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const allowance = await token.allowance(userAddr, addrs.router);
  if (allowance < amountIn) {
    const approveTx = await token.approve(addrs.router, ethers.MaxUint256);
    await approveTx.wait();
  }

  // 2. Find best pool (tokenIn → WETH)
  const { fee } = await findBestPool(chain, tokenIn, addrs.weth, provider);

  // 3. Quote
  const { amountOut } = await quoteExactInput(chain, tokenIn, addrs.weth, amountIn, fee, provider);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  // 4. Execute swap — use multicall to swap + unwrap WETH to ETH
  const router = new ethers.Contract(addrs.router, ROUTER_ABI, signer);
  const swapData = router.interface.encodeFunctionData('exactInputSingle', [{
    tokenIn,
    tokenOut: addrs.weth,
    fee,
    recipient: addrs.router, // router receives WETH, then unwraps
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0,
  }]);
  const unwrapData = router.interface.encodeFunctionData('unwrapWETH9', [minOut, userAddr]);

  const tx = await router.multicall([swapData, unwrapData]);
  const receipt = await tx.wait();
  return {
    txHash: receipt.hash,
    amountIn,
    amountOutExpected: amountOut,
    amountOutMin: minOut,
    fee,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * Get token metadata (symbol, decimals, balance)
 */
async function getTokenInfo(chain, tokenAddress, walletAddress, provider) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [symbol, decimals, balance] = await Promise.all([
    token.symbol().catch(() => 'UNKNOWN'),
    token.decimals().catch(() => 18),
    walletAddress ? token.balanceOf(walletAddress).catch(() => 0n) : Promise.resolve(0n),
  ]);
  return { symbol, decimals: Number(decimals), balance };
}

module.exports = {
  ADDRESSES,
  FEE_TIERS,
  findBestPool,
  quoteExactInput,
  buyWithEth,
  sellToEth,
  getTokenInfo,
};
