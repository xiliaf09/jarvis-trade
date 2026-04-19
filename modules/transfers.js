// ============================================================
// JARVIS TRADE — Transfers (native + ERC20, internal + external)
// ============================================================

const { ethers } = require('ethers');
const trading = require('./trading');
const wallet = require('./wallet');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
];

/**
 * Send native coin (ETH/BNB) from one wallet to an address
 */
async function sendNative(userId, walletId, chain, toAddress, amountNative) {
  const provider = trading.getProvider(chain);
  const signer = wallet.getSigner(userId, walletId, provider);
  const amount = ethers.parseEther(amountNative.toString());

  const balance = await provider.getBalance(await signer.getAddress());
  // Rough estimate of gas reserve needed (typical transfer = 21k gas)
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('1', 'gwei');
  const gasReserve = gasPrice * 30000n;

  if (amount + gasReserve > balance) {
    throw new Error(`Solde insuffisant (balance: ${ethers.formatEther(balance)}, need: ${ethers.formatEther(amount + gasReserve)})`);
  }

  const tx = await signer.sendTransaction({ to: toAddress, value: amount });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('./trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amount, gasUsed: receipt.gasUsed };
}

/**
 * Send max native (balance - gas reserve)
 */
async function sendMaxNative(userId, walletId, chain, toAddress) {
  const provider = trading.getProvider(chain);
  const signer = wallet.getSigner(userId, walletId, provider);
  const addr = await signer.getAddress();

  const balance = await provider.getBalance(addr);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('1', 'gwei');
  const gasReserve = gasPrice * 30000n;

  if (balance <= gasReserve) throw new Error('Solde trop bas pour couvrir les frais');
  const amount = balance - gasReserve;

  const tx = await signer.sendTransaction({ to: toAddress, value: amount });
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('./trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amount, gasUsed: receipt.gasUsed };
}

/**
 * Send ERC-20 token from one wallet to an address
 */
async function sendToken(userId, walletId, chain, tokenAddress, toAddress, amountTokens) {
  const provider = trading.getProvider(chain);
  const signer = wallet.getSigner(userId, walletId, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const decimals = Number(await token.decimals());
  const amount = ethers.parseUnits(amountTokens.toString(), decimals);

  const balance = await token.balanceOf(await signer.getAddress());
  if (amount > balance) throw new Error(`Solde token insuffisant`);

  const tx = await token.transfer(toAddress, amount);
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('./trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amount, gasUsed: receipt.gasUsed };
}

/**
 * Send 100% of a token's balance
 */
async function sendMaxToken(userId, walletId, chain, tokenAddress, toAddress) {
  const provider = trading.getProvider(chain);
  const signer = wallet.getSigner(userId, walletId, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const balance = await token.balanceOf(await signer.getAddress());
  if (balance === 0n) throw new Error('Balance nulle');
  const tx = await token.transfer(toAddress, balance);
  let receipt;
  try { receipt = await tx.wait(); }
  catch (_) {
    const { waitForReceiptResilient } = require('./trading');
    receipt = await waitForReceiptResilient(chain, tx.hash);
  }
  return { txHash: receipt.hash, amount: balance, gasUsed: receipt.gasUsed };
}

/**
 * CONSOLIDATE: transfer native from all other wallets → target wallet
 */
async function consolidateNative(userId, targetWalletId, chain) {
  const wallets = wallet.listWallets(userId);
  const target = wallets.find(w => w.id === targetWalletId);
  if (!target) throw new Error('Target wallet not found');

  const sources = wallets.filter(w => w.id !== targetWalletId);
  const results = [];

  for (const src of sources) {
    try {
      // Skip wallets with < 0.0005 ETH (not worth the gas)
      const provider = trading.getProvider(chain);
      const bal = await provider.getBalance(src.address);
      if (bal < ethers.parseEther('0.0005')) continue;

      const r = await sendMaxNative(userId, src.id, chain, target.address);
      results.push({ from: src.label, address: src.address, amount: r.amount, txHash: r.txHash, success: true });
    } catch (err) {
      results.push({ from: src.label, address: src.address, error: err.message, success: false });
    }
  }
  return results;
}

/**
 * DISPATCH: equally split native from source wallet → all other wallets
 */
async function dispatchNative(userId, sourceWalletId, chain, amountPerWallet = null) {
  const wallets = wallet.listWallets(userId);
  const source = wallets.find(w => w.id === sourceWalletId);
  if (!source) throw new Error('Source wallet not found');

  const destinations = wallets.filter(w => w.id !== sourceWalletId);
  if (destinations.length === 0) throw new Error('No destination wallets');

  const provider = trading.getProvider(chain);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('1', 'gwei');
  const gasCostPerTx = gasPrice * 30000n;

  let amountEach;
  if (amountPerWallet !== null) {
    amountEach = ethers.parseEther(amountPerWallet.toString());
  } else {
    // Split the source balance evenly
    const balance = await provider.getBalance(source.address);
    const totalGas = gasCostPerTx * BigInt(destinations.length);
    if (balance <= totalGas) throw new Error('Solde trop bas');
    amountEach = (balance - totalGas) / BigInt(destinations.length);
  }

  const results = [];
  for (const dest of destinations) {
    try {
      const r = await sendNative(userId, sourceWalletId, chain, dest.address, ethers.formatEther(amountEach));
      results.push({ to: dest.label, address: dest.address, amount: r.amount, txHash: r.txHash, success: true });
    } catch (err) {
      results.push({ to: dest.label, address: dest.address, error: err.message, success: false });
    }
  }
  return results;
}

function isValidAddress(addr) {
  try { return ethers.isAddress(addr); } catch (_) { return false; }
}

module.exports = {
  sendNative,
  sendMaxNative,
  sendToken,
  sendMaxToken,
  consolidateNative,
  dispatchNative,
  isValidAddress,
};
