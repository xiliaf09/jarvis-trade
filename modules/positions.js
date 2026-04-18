// ============================================================
// JARVIS TRADE — Positions / Portfolio tracking + PnL
// ============================================================
//
// Tracks every buy/sell per wallet+token, computes:
//  - Entry price (weighted avg cost basis)
//  - Current price (via DexScreener)
//  - Unrealized PnL
//  - Realized PnL (from closed trades)
// Persisted in data.json
// ============================================================

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DATA_PATH = path.join(__dirname, '..', 'data.json');

let _data = {
  positions: {}, // key: `${userId}_${walletAddr}_${chain}_${tokenAddr}` → position
  trades: [],    // [{ userId, walletId, chain, tokenAddress, side, amountEth, amountTokens, priceUsd, txHash, ts }]
};

function _load() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    _data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    if (!_data.positions) _data.positions = {};
    if (!_data.trades) _data.trades = [];
  } catch (err) {
    console.error('⚠️  Failed to load data.json:', err.message);
  }
}

function _save() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(_data, null, 2));
  } catch (err) {
    console.error('⚠️  Failed to save data.json:', err.message);
  }
}

function init() {
  _load();
  console.log(`📊 Positions module — ${Object.keys(_data.positions).length} positions, ${_data.trades.length} trades`);
}

function _key(userId, walletAddr, chain, tokenAddr) {
  return `${userId}_${walletAddr.toLowerCase()}_${chain}_${tokenAddr.toLowerCase()}`;
}

/**
 * Record a BUY — adds to position (weighted avg cost basis)
 */
function recordBuy({ userId, walletId, walletAddr, chain, tokenAddress, symbol, decimals, amountEth, amountTokens, ethPriceUsd, txHash }) {
  const k = _key(userId, walletAddr, chain, tokenAddress);
  const tokensFloat = Number(ethers.formatUnits(amountTokens, decimals));
  const ethFloat = Number(ethers.formatEther(amountEth));
  const costUsd = ethFloat * ethPriceUsd;
  const pricePerToken = tokensFloat > 0 ? costUsd / tokensFloat : 0;

  const existing = _data.positions[k];
  if (existing) {
    // Weighted avg entry
    const totalTokens = existing.amountTokens + tokensFloat;
    const totalCost = existing.totalCostUsd + costUsd;
    existing.amountTokens = totalTokens;
    existing.totalCostUsd = totalCost;
    existing.avgEntryUsd = totalTokens > 0 ? totalCost / totalTokens : 0;
    existing.lastBuyAt = new Date().toISOString();
  } else {
    _data.positions[k] = {
      userId,
      walletId,
      walletAddr,
      chain,
      tokenAddress,
      symbol,
      decimals,
      amountTokens: tokensFloat,
      totalCostUsd: costUsd,
      avgEntryUsd: pricePerToken,
      openedAt: new Date().toISOString(),
      lastBuyAt: new Date().toISOString(),
    };
  }

  _data.trades.push({
    userId, walletId, chain, tokenAddress, symbol,
    side: 'buy',
    amountEth: ethFloat,
    amountTokens: tokensFloat,
    priceUsd: pricePerToken,
    txHash,
    ts: Date.now(),
  });
  _save();
  return _data.positions[k];
}

/**
 * Record a SELL — subtracts from position, computes realized PnL
 */
function recordSell({ userId, walletId, walletAddr, chain, tokenAddress, symbol, decimals, amountTokens, amountEthReceived, ethPriceUsd, txHash }) {
  const k = _key(userId, walletAddr, chain, tokenAddress);
  const tokensFloat = Number(ethers.formatUnits(amountTokens, decimals));
  const ethFloat = Number(ethers.formatEther(amountEthReceived));
  const proceedsUsd = ethFloat * ethPriceUsd;
  const pricePerToken = tokensFloat > 0 ? proceedsUsd / tokensFloat : 0;

  const position = _data.positions[k];
  let realizedPnl = 0;
  if (position) {
    // Proportion of position sold
    const proportion = position.amountTokens > 0 ? tokensFloat / position.amountTokens : 1;
    const costBasis = position.totalCostUsd * proportion;
    realizedPnl = proceedsUsd - costBasis;

    position.amountTokens -= tokensFloat;
    position.totalCostUsd -= costBasis;
    position.realizedPnlUsd = (position.realizedPnlUsd || 0) + realizedPnl;

    // Close position if fully sold
    if (position.amountTokens < 0.000001) {
      delete _data.positions[k];
    }
  }

  _data.trades.push({
    userId, walletId, chain, tokenAddress, symbol,
    side: 'sell',
    amountEth: ethFloat,
    amountTokens: tokensFloat,
    priceUsd: pricePerToken,
    realizedPnl,
    txHash,
    ts: Date.now(),
  });
  _save();
  return { realizedPnl, positionRemaining: _data.positions[k] || null };
}

/**
 * Get all open positions for a user (optionally filtered by wallet)
 */
function getPositions(userId, walletId = null) {
  return Object.values(_data.positions).filter(p =>
    p.userId === userId && (walletId === null || p.walletId === walletId)
  );
}

/**
 * Get trades history for a user
 */
function getTrades(userId, limit = 50) {
  return _data.trades.filter(t => t.userId === userId).slice(-limit).reverse();
}

/**
 * Total stats for a user
 */
function getStats(userId) {
  const trades = _data.trades.filter(t => t.userId === userId);
  const sells = trades.filter(t => t.side === 'sell');
  const realizedPnl = sells.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const wins = sells.filter(t => (t.realizedPnl || 0) > 0).length;
  const losses = sells.filter(t => (t.realizedPnl || 0) <= 0).length;
  return {
    totalTrades: trades.length,
    buys: trades.filter(t => t.side === 'buy').length,
    sells: sells.length,
    realizedPnl,
    wins,
    losses,
    winRate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
    openPositions: getPositions(userId).length,
  };
}

module.exports = {
  init,
  recordBuy,
  recordSell,
  getPositions,
  getTrades,
  getStats,
};
