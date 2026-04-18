// ============================================================
// JARVIS TRADE — Telegram Bot UI (Sigma-inspired flow)
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const wallet = require('./wallet');
const trading = require('./trading');
const positions = require('./positions');
const price = require('./price');

let bot = null;
let _config = null;
const _state = new Map(); // userId → { step, data } (conversation state for multi-step flows)
const _processedMsgs = new Set(); // anti-duplicate

function init(config) {
  _config = config;
  bot = new TelegramBot(config.telegramToken, {
    polling: { interval: 2000, autoStart: true, params: { timeout: 30 } },
  });

  bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) return;
    console.error('⚠️  Telegram polling error:', err.message);
  });

  _registerHandlers();
  console.log('📱 Telegram bot connected');
}

function _isAuthorized(msg) {
  const userId = String(msg.from?.id || msg.chat?.id);
  if (!_config.authorizedUsers.includes(userId)) return false;
  const mid = msg.message_id;
  if (mid && _processedMsgs.has(mid)) return false;
  if (mid) {
    _processedMsgs.add(mid);
    if (_processedMsgs.size > 200) {
      const oldest = _processedMsgs.values().next().value;
      _processedMsgs.delete(oldest);
    }
  }
  return true;
}

function _registerHandlers() {
  // ── /start → Main menu ──
  bot.onText(/^\/start/, (msg) => {
    if (!_isAuthorized(msg)) return;
    _sendMainMenu(msg.chat.id, String(msg.from.id));
  });

  // ── /wallet ──
  bot.onText(/^\/wallet/, (msg) => {
    if (!_isAuthorized(msg)) return;
    _sendWalletMenu(msg.chat.id, String(msg.from.id));
  });

  // ── /positions ──
  bot.onText(/^\/positions/, async (msg) => {
    if (!_isAuthorized(msg)) return;
    await _sendPositions(msg.chat.id, String(msg.from.id));
  });

  // ── /stats ──
  bot.onText(/^\/stats/, (msg) => {
    if (!_isAuthorized(msg)) return;
    const stats = positions.getStats(String(msg.from.id));
    bot.sendMessage(msg.chat.id,
      `📊 *Stats*\n\n` +
      `Trades: ${stats.totalTrades} (${stats.buys} buys · ${stats.sells} sells)\n` +
      `Win rate: ${stats.winRate.toFixed(1)}%\n` +
      `Realized PnL: $${stats.realizedPnl.toFixed(2)}\n` +
      `Open positions: ${stats.openPositions}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Auto-detect contract addresses pasted in chat ──
  bot.on('message', async (msg) => {
    if (!_isAuthorized(msg)) return;
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    // Check conversation state
    const userId = String(msg.from.id);
    const state = _state.get(userId);
    if (state) {
      await _handleStatefulInput(msg, state);
      return;
    }

    // Auto-detect ERC20 contract address
    const ethAddrMatch = text.match(/^(0x[a-fA-F0-9]{40})$/);
    if (ethAddrMatch) {
      await _showBuyInterface(msg.chat.id, userId, ethAddrMatch[1]);
    }
  });

  // ── Callback queries (button clicks) ──
  bot.on('callback_query', async (query) => {
    const userId = String(query.from.id);
    if (!_config.authorizedUsers.includes(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
    }

    const data = query.data;
    const chatId = query.message.chat.id;

    try {
      if (data === 'menu:main') {
        await bot.answerCallbackQuery(query.id);
        await _sendMainMenu(chatId, userId, query.message.message_id);
      } else if (data === 'menu:wallet') {
        await bot.answerCallbackQuery(query.id);
        await _sendWalletMenu(chatId, userId, query.message.message_id);
      } else if (data === 'menu:positions') {
        await bot.answerCallbackQuery(query.id);
        await _sendPositions(chatId, userId);
      } else if (data === 'wallet:generate') {
        await bot.answerCallbackQuery(query.id);
        _state.set(userId, { step: 'wallet_generate_label' });
        bot.sendMessage(chatId, '🏷️ Label pour ce nouveau wallet ?\n(ex: "Sniper", "Main", "Degen")');
      } else if (data === 'wallet:import') {
        await bot.answerCallbackQuery(query.id);
        _state.set(userId, { step: 'wallet_import_pk' });
        bot.sendMessage(chatId,
          '🔑 Colle la clé privée du wallet à importer.\n\n' +
          '⚠️ Ne partage JAMAIS cette clé avec qui que ce soit. Elle sera chiffrée AES-256 dans le bot.'
        );
      } else if (data.startsWith('buy:')) {
        await _handleBuyCallback(query, data);
      } else if (data.startsWith('sell:')) {
        await _handleSellCallback(query, data);
      } else if (data === 'cancel') {
        _state.delete(userId);
        await bot.answerCallbackQuery(query.id, { text: 'Annulé' });
        await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      } else {
        await bot.answerCallbackQuery(query.id);
      }
    } catch (err) {
      console.error('Callback error:', err.message);
      await bot.answerCallbackQuery(query.id, { text: `Erreur: ${err.message.slice(0, 50)}` });
    }
  });
}

// ════════════════════════════════════════════════════════════
// MAIN MENU
// ════════════════════════════════════════════════════════════

async function _sendMainMenu(chatId, userId, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  const stats = positions.getStats(userId);
  const openPos = positions.getPositions(userId);

  const text =
    `🤖 *JARVIS TRADE*\n\n` +
    `💼 Wallets: ${wallets.length}\n` +
    `📊 Positions ouvertes: ${openPos.length}\n` +
    `💰 PnL réalisé: ${stats.realizedPnl >= 0 ? '+' : ''}$${stats.realizedPnl.toFixed(2)}\n\n` +
    `_Colle un contract address pour acheter_`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '💼 Wallets', callback_data: 'menu:wallet' },
        { text: '📊 Positions', callback_data: 'menu:positions' },
      ],
      [
        { text: '📈 Stats', callback_data: 'menu:stats' },
        { text: '⚙️ Settings', callback_data: 'menu:settings' },
      ],
    ],
  };

  if (editMsgId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: editMsgId,
      parse_mode: 'Markdown', reply_markup: keyboard,
    }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// ════════════════════════════════════════════════════════════
// WALLET MENU
// ════════════════════════════════════════════════════════════

async function _sendWalletMenu(chatId, userId, editMsgId = null) {
  const wallets = wallet.listWallets(userId);

  let text = `💼 *Wallets*\n\n`;
  if (wallets.length === 0) {
    text += `_Aucun wallet. Génère ou importe un wallet pour commencer._`;
  } else {
    // Show ETH balance on both chains for each wallet
    for (const w of wallets) {
      const [baseBal, ethBal] = await Promise.all([
        trading.getEthBalance('base', w.address).catch(() => 0n),
        trading.getEthBalance('ethereum', w.address).catch(() => 0n),
      ]);
      text += `*${w.label}* \`${w.address.slice(0, 6)}...${w.address.slice(-4)}\`\n`;
      text += `  Base: ${ethers.formatEther(baseBal).slice(0, 8)} ETH\n`;
      text += `  Ethereum: ${ethers.formatEther(ethBal).slice(0, 8)} ETH\n\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '➕ Generate', callback_data: 'wallet:generate' },
        { text: '📥 Import', callback_data: 'wallet:import' },
      ],
      [{ text: '⬅️ Back', callback_data: 'menu:main' }],
    ],
  };

  if (editMsgId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: editMsgId,
      parse_mode: 'Markdown', reply_markup: keyboard,
    }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// ════════════════════════════════════════════════════════════
// POSITIONS
// ════════════════════════════════════════════════════════════

async function _sendPositions(chatId, userId) {
  const pos = positions.getPositions(userId);
  if (pos.length === 0) {
    return bot.sendMessage(chatId, '📊 Aucune position ouverte.');
  }

  // Fetch current prices
  const byChain = {};
  pos.forEach(p => {
    if (!byChain[p.chain]) byChain[p.chain] = [];
    byChain[p.chain].push(p.tokenAddress);
  });

  const pricesByChain = {};
  for (const [chain, addrs] of Object.entries(byChain)) {
    pricesByChain[chain] = await price.getTokenPrices(chain, addrs);
  }

  let text = `📊 *Positions ouvertes* (${pos.length})\n\n`;
  for (const p of pos) {
    const currentPrice = pricesByChain[p.chain]?.[p.tokenAddress.toLowerCase()]?.priceUsd || 0;
    const currentValue = p.amountTokens * currentPrice;
    const pnl = currentValue - p.totalCostUsd;
    const pnlPct = p.totalCostUsd > 0 ? (pnl / p.totalCostUsd) * 100 : 0;
    const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    const pnlSign = pnl >= 0 ? '+' : '';

    text += `${pnlEmoji} *${p.symbol}* (${p.chain})\n`;
    text += `  Entry: $${p.avgEntryUsd.toFixed(6)} → Now: $${currentPrice.toFixed(6)}\n`;
    text += `  Amount: ${p.amountTokens.toFixed(4)} | Value: $${currentValue.toFixed(2)}\n`;
    text += `  PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)\n\n`;
  }

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ════════════════════════════════════════════════════════════
// BUY FLOW
// ════════════════════════════════════════════════════════════

async function _showBuyInterface(chatId, userId, tokenAddress) {
  const wallets = wallet.listWallets(userId);
  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Aucun wallet. Utilise /wallet pour en créer un.');
  }

  // Try to get token info on Base first, then Ethereum
  let chain = 'base';
  let info = null;
  let dexInfo = null;
  try {
    info = await trading.getTokenInfo('base', tokenAddress, wallets[0].address);
    dexInfo = await price.getTokenPrice('base', tokenAddress);
    if (!dexInfo || dexInfo.priceUsd === 0) throw new Error('no base liquidity');
  } catch (_) {
    try {
      chain = 'ethereum';
      info = await trading.getTokenInfo('ethereum', tokenAddress, wallets[0].address);
      dexInfo = await price.getTokenPrice('ethereum', tokenAddress);
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Token introuvable ou pas de liquidité:\n\`${tokenAddress}\``, { parse_mode: 'Markdown' });
    }
  }

  const symbol = dexInfo?.symbol || info?.symbol || 'UNKNOWN';
  const name = dexInfo?.name || '';
  const priceUsd = dexInfo?.priceUsd || 0;
  const liq = dexInfo?.liquidityUsd || 0;
  const vol = dexInfo?.volume24h || 0;
  const change = dexInfo?.priceChange24h || 0;

  const text =
    `💎 *${symbol}* ${name ? `— ${name}` : ''}\n` +
    `Chain: *${chain}* · \`${tokenAddress.slice(0,6)}...${tokenAddress.slice(-4)}\`\n\n` +
    `Price: *$${priceUsd.toFixed(6)}* (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)\n` +
    `Liq: $${(liq/1000).toFixed(1)}K · Vol24h: $${(vol/1000).toFixed(1)}K\n\n` +
    `_Choisis un montant:_`;

  // Build preset buttons (2 rows of presets + wallet selector)
  const presets = _config.presets.buy;
  const presetRows = [];
  for (let i = 0; i < presets.length; i += 3) {
    presetRows.push(presets.slice(i, i + 3).map(amt => ({
      text: `${amt} ETH`,
      callback_data: `buy:preset:${chain}:${tokenAddress}:${amt}:${wallets[0].id}`,
    })));
  }

  const keyboard = {
    inline_keyboard: [
      ...presetRows,
      [
        { text: '✏️ Custom', callback_data: `buy:custom:${chain}:${tokenAddress}:${wallets[0].id}` },
        { text: '💼 Change wallet', callback_data: `buy:wallet:${chain}:${tokenAddress}` },
      ],
      [{ text: '❌ Cancel', callback_data: 'cancel' }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function _handleBuyCallback(query, data) {
  const parts = data.split(':');
  const action = parts[1];
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);

  if (action === 'preset') {
    const [, , chain, tokenAddr, amountStr, walletId] = parts;
    const amount = parseFloat(amountStr);
    await bot.answerCallbackQuery(query.id, { text: `Achat ${amount} ETH en cours...` });
    await _executeBuy(chatId, userId, walletId, chain, tokenAddr, amount);
  } else if (action === 'custom') {
    const [, , chain, tokenAddr, walletId] = parts;
    _state.set(userId, { step: 'buy_custom_amount', data: { chain, tokenAddr, walletId } });
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, '💵 Montant d\'ETH à dépenser ? (ex: 0.15)');
  }
}

async function _executeBuy(chatId, userId, walletId, chain, tokenAddr, amountEth) {
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ Achat en cours...\nAmount: ${amountEth} ETH\nToken: \`${tokenAddr.slice(0,10)}...\`\nChain: ${chain}`,
    { parse_mode: 'Markdown' }
  );

  try {
    const provider = trading.getProvider(chain);
    const signer = wallet.getSigner(userId, walletId, provider);
    const w = wallet.getWalletById(userId, walletId);

    // Check balance
    const balance = await trading.getEthBalance(chain, w.address);
    if (balance < ethers.parseEther(amountEth.toString())) {
      return bot.editMessageText(`❌ Balance insuffisante. Wallet a ${ethers.formatEther(balance).slice(0,8)} ETH, besoin de ${amountEth}`, {
        chat_id: chatId, message_id: loadingMsg.message_id,
      });
    }

    const result = await trading.buy(chain, tokenAddr, amountEth, _config.trading.defaultSlippageBps, signer);

    // Record position
    const info = await trading.getTokenInfo(chain, tokenAddr, w.address);
    const ethPrice = await price.getEthPrice();
    positions.recordBuy({
      userId, walletId, walletAddr: w.address, chain,
      tokenAddress: tokenAddr,
      symbol: info.symbol,
      decimals: info.decimals,
      amountEth: ethers.parseEther(amountEth.toString()),
      amountTokens: result.amountOutExpected,
      ethPriceUsd: ethPrice,
      txHash: result.txHash,
    });

    const explorer = _config.chains[chain].explorer;
    await bot.editMessageText(
      `✅ *Achat réussi*\n\n` +
      `${info.symbol} acheté via ${result.dex}\n` +
      `Montant: ${Number(ethers.formatUnits(result.amountOutExpected, info.decimals)).toFixed(4)} ${info.symbol}\n` +
      `Coût: ${amountEth} ETH\n\n` +
      `[Voir tx](${explorer}/tx/${result.txHash})`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Buy error:', err.message);
    await bot.editMessageText(`❌ Erreur d'achat:\n\`${err.message.slice(0, 200)}\``, {
      chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown',
    });
  }
}

async function _handleSellCallback(query, data) {
  // TODO: implement sell flow
  await bot.answerCallbackQuery(query.id, { text: 'Sell flow — à implémenter' });
}

// ════════════════════════════════════════════════════════════
// STATEFUL CONVERSATIONS
// ════════════════════════════════════════════════════════════

async function _handleStatefulInput(msg, state) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (state.step === 'wallet_generate_label') {
    const label = text.slice(0, 40);
    const newWallet = wallet.generateWallet(userId, label);
    _state.delete(userId);
    bot.sendMessage(chatId,
      `✅ *Wallet créé*\n\n` +
      `Label: *${newWallet.label}*\n` +
      `Address: \`${newWallet.address}\`\n\n` +
      (newWallet.mnemonic ? `🔐 *Mnemonic* (à sauvegarder IMMÉDIATEMENT, ne sera JAMAIS réaffiché):\n\`${newWallet.mnemonic}\`\n\n⚠️ Supprime ce message après avoir sauvegardé.` : ''),
      { parse_mode: 'Markdown' }
    );
  } else if (state.step === 'wallet_import_pk') {
    try {
      const imported = wallet.importWallet(userId, text, 'Imported');
      _state.delete(userId);
      // Delete message containing private key
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      bot.sendMessage(chatId,
        `✅ *Wallet importé*\n\n` +
        `Address: \`${imported.address}\`\n\n` +
        `🔐 Ton message avec la clé privée a été supprimé.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      _state.delete(userId);
      bot.sendMessage(chatId, `❌ Import échoué: ${err.message}`);
    }
  } else if (state.step === 'buy_custom_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, '⚠️ Montant invalide. Essaie encore (ex: 0.15)');
    }
    const { chain, tokenAddr, walletId } = state.data;
    _state.delete(userId);
    await _executeBuy(chatId, userId, walletId, chain, tokenAddr, amount);
  }
}

module.exports = { init };
