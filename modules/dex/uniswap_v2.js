// ============================================================
// JARVIS TRADE — Uniswap V2 (Base + Ethereum)
// Used for tokens not on V3 (many meme launches)
// ============================================================

const { ethers } = require('ethers');

const ADDRESSES = {
  base: {
    factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    router:  '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    weth:    '0x4200000000000000000000000000000000000006',
  },
  ethereum: {
    factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    router:  '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    weth:    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
};

const FACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];
const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

async function findPool(chain, tokenA, tokenB, provider) {
  const addrs = ADDRESSES[chain];
  if (!addrs) return null;
  const factory = new ethers.Contract(addrs.factory, FACTORY_ABI, provider);
  const pair = await factory.getPair(tokenA, tokenB);
  if (pair === ethers.ZeroAddress) throw new Error('No V2 pair');
  return pair;
}

async function quote(chain, tokenIn, tokenOut, amountIn, provider) {
  const addrs = ADDRESSES[chain];
  const router = new ethers.Contract(addrs.router, ROUTER_ABI, provider);
  const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
  return amounts[amounts.length - 1];
}

async function buyWithEth(chain, tokenOut, amountInEth, slippageBps, signer) {
  const addrs = ADDRESSES[chain];
  const provider = signer.provider;
  const amountIn = ethers.parseEther(amountInEth.toString());
  await findPool(chain, addrs.weth, tokenOut, provider); // throws if no pair

  const amountOut = await quote(chain, addrs.weth, tokenOut, amountIn, provider);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  const router = new ethers.Contract(addrs.router, ROUTER_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut, [addrs.weth, tokenOut], await signer.getAddress(), deadline,
    { value: amountIn }
  );
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amountIn, amountOutExpected: amountOut, amountOutMin: minOut, gasUsed: receipt.gasUsed };
}

async function sellToEth(chain, tokenIn, amountIn, slippageBps, signer) {
  const addrs = ADDRESSES[chain];
  const provider = signer.provider;
  const userAddr = await signer.getAddress();

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

  await findPool(chain, tokenIn, addrs.weth, provider);
  const amountOut = await quote(chain, tokenIn, addrs.weth, amountIn, provider);
  const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;

  const router = new ethers.Contract(addrs.router, ROUTER_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
    amountIn, minOut, [tokenIn, addrs.weth], userAddr, deadline
  );
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('../trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amountIn, amountOutExpected: amountOut, amountOutMin: minOut, gasUsed: receipt.gasUsed };
}

module.exports = { ADDRESSES, findPool, quote, buyWithEth, sellToEth };
