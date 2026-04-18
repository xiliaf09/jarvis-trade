// ============================================================
// JARVIS TRADE — Telegram Bot UI (Sigma-inspired)
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const wallet = require('./wallet');
const trading = require('./trading');
const positions = require('./positions');
const price = require('./price');

let bot = null;
let _config = null;
const _state = new Map(); // userId → { step, data }
const _processedMsgs = new Set();
const _userPrefs = new Map(); // userId → { activeWalletId, slippageBps }

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
      _processedMsgs.delete(_processedMsgs.values().next().value);
    }
  }
  return true;
}

function _getUserPrefs(userId) {
  if (!_userPrefs.has(userId)) {
    _userPrefs.set(userId, { activeWalletId: null, slippageBps: 100, presetIndex: null });
  }
  return _userPrefs.get(userId);
}

function _shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function _fmtEth(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(4);
}

function _fmtUsd(n) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(6);
}

// ════════════════════════════════════════════════════════════
// HANDLERS
// ════════════════════════════════════════════════════════════

function _registerHandlers() {
  bot.onText(/^\/start/, (msg) => {
    if (!_isAuthorized(msg)) return;
    _sendMainMenu(msg.chat.id, String(msg.from.id));
  });

  bot.onText(/^\/wallets?$/, (msg) => {
    if (!_isAuthorized(msg)) return;
    _sendWalletsMenu(msg.chat.id, String(msg.from.id));
  });

  bot.onText(/^\/positions/, (msg) => {
    if (!_isAuthorized(msg)) return;
    _sendPositions(msg.chat.id, String(msg.from.id));
  });

  bot.onText(/^\/settings/, (msg) => {
    if (!_isAuthorized(msg)) return;
    _sendSettingsMenu(msg.chat.id, String(msg.from.id));
  });

  // Auto-detect CA + stateful input handler
  bot.on('message', async (msg) => {
    if (!_isAuthorized(msg)) return;
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const userId = String(msg.from.id);
    const state = _state.get(userId);
    if (state) {
      await _handleStatefulInput(msg, state);
      return;
    }

    // Auto-detect ERC20 contract address
    if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
      await _showBuyInterface(msg.chat.id, userId, text);
    }
  });

  // Callback queries
  bot.on('callback_query', async (query) => {
    const userId = String(query.from.id);
    if (!_config.authorizedUsers.includes(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
    }
    try {
      await _handleCallback(query, userId);
    } catch (err) {
      console.error('Callback error:', err.message);
      await bot.answerCallbackQuery(query.id, { text: `Erreur: ${err.message.slice(0, 50)}` });
    }
  });
}

async function _handleCallback(query, userId) {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  // Navigation
  if (data === 'nav:main') {
    await bot.answerCallbackQuery(query.id);
    return _sendMainMenu(chatId, userId, msgId);
  }
  if (data === 'nav:wallets') {
    await bot.answerCallbackQuery(query.id);
    return _sendWalletsMenu(chatId, userId, msgId);
  }
  if (data === 'nav:positions') {
    await bot.answerCallbackQuery(query.id);
    return _sendPositions(chatId, userId);
  }
  if (data === 'nav:settings') {
    await bot.answerCallbackQuery(query.id);
    return _sendSettingsMenu(chatId, userId, msgId);
  }
  if (data === 'nav:close' || data === 'cancel') {
    _state.delete(userId);
    await bot.answerCallbackQuery(query.id);
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  // Wallet actions
  if (data === 'wallet:create') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'wallet_create_label' });
    return bot.sendMessage(chatId, '🏷️ Nom du nouveau wallet ?\n(ex: "Main", "Sniper", "Degen")');
  }
  if (data === 'wallet:import') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'wallet_import_pk' });
    return bot.sendMessage(chatId,
      '🔑 Colle la clé privée du wallet à importer.\n\n' +
      '⚠️ Ne partage JAMAIS cette clé. Elle sera chiffrée AES-256 et ton message sera supprimé.'
    );
  }
  if (data === 'wallet:rename') {
    await bot.answerCallbackQuery(query.id);
    return _sendWalletPicker(chatId, userId, 'rename', msgId);
  }
  if (data === 'wallet:remove') {
    await bot.answerCallbackQuery(query.id);
    return _sendWalletPicker(chatId, userId, 'remove', msgId);
  }
  if (data === 'wallet:keys') {
    await bot.answerCallbackQuery(query.id);
    return _sendWalletPicker(chatId, userId, 'reveal', msgId);
  }
  if (data === 'wallet:setdefault') {
    await bot.answerCallbackQuery(query.id);
    return _sendWalletPicker(chatId, userId, 'setdefault', msgId);
  }

  if (data.startsWith('walletsel:')) {
    const [, action, walletId] = data.split(':');
    await bot.answerCallbackQuery(query.id);
    if (action === 'rename') {
      _state.set(userId, { step: 'wallet_rename_label', data: { walletId } });
      return bot.sendMessage(chatId, '🏷️ Nouveau nom ?');
    }
    if (action === 'remove') {
      const w = wallet.getWalletById(userId, walletId);
      if (!w) return;
      return bot.sendMessage(chatId,
        `⚠️ Supprimer *${w.label}* (\`${w.address}\`) ?\n\n` +
        `Cette action est *irréversible*. Exporte la clé privée d'abord si nécessaire.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🗑️ Confirmer', callback_data: `walletdel:${walletId}` },
              { text: '❌ Annuler', callback_data: 'cancel' },
            ]],
          },
        }
      );
    }
    if (action === 'reveal') {
      const pk = wallet.revealPrivateKey(userId, walletId);
      const w = wallet.getWalletById(userId, walletId);
      const keyMsg = await bot.sendMessage(chatId,
        `🔑 *Clé privée — ${w.label}*\n\n` +
        `\`${pk}\`\n\n` +
        `⚠️ Ne partage JAMAIS cette clé.\n_Ce message sera supprimé dans 60 secondes._`,
        { parse_mode: 'Markdown' }
      );
      setTimeout(() => bot.deleteMessage(chatId, keyMsg.message_id).catch(() => {}), 60000);
      return;
    }
    if (action === 'setdefault') {
      _getUserPrefs(userId).activeWalletId = walletId;
      return _sendWalletsMenu(chatId, userId, msgId);
    }
  }
  if (data.startsWith('walletdel:')) {
    const [, walletId] = data.split(':');
    wallet.deleteWallet(userId, walletId);
    await bot.answerCallbackQuery(query.id, { text: 'Wallet supprimé' });
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  // Buy flow
  if (data.startsWith('buy:')) {
    return _handleBuyCallback(query, data, userId);
  }

  // Sell flow
  if (data.startsWith('sell:')) {
    return _handleSellCallback(query, data, userId);
  }

  // Settings
  if (data === 'settings:slippage') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'settings_slippage' });
    return bot.sendMessage(chatId, '📊 Slippage en % ? (ex: 1 pour 1%, 5 pour 5%, max 30)');
  }

  // Default: ack
  await bot.answerCallbackQuery(query.id);
}

// ════════════════════════════════════════════════════════════
// MAIN MENU
// ════════════════════════════════════════════════════════════

async function _sendMainMenu(chatId, userId, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  const stats = positions.getStats(userId);

  // Total wallet worth (ETH balance only for now, in USD)
  let totalEth = 0n;
  for (const w of wallets) {
    try {
      const [base, eth] = await Promise.all([
        trading.getEthBalance('base', w.address).catch(() => 0n),
        trading.getEthBalance('ethereum', w.address).catch(() => 0n),
      ]);
      totalEth += base + eth;
    } catch (_) {}
  }
  const ethPrice = await price.getEthPrice().catch(() => 0);
  const walletWorthUsd = parseFloat(ethers.formatEther(totalEth)) * ethPrice;

  const text =
    `🤖 *JARVIS TRADE*\n` +
    `_Your custom trading bot · 0% fees_\n\n` +
    `💰 Wallet Worth: *${_fmtUsd(walletWorthUsd)}*\n` +
    `💼 Wallets: ${wallets.length} · 📊 Positions: ${stats.openPositions}\n` +
    `📈 Realized PnL: *${stats.realizedPnl >= 0 ? '+' : ''}$${stats.realizedPnl.toFixed(2)}*\n\n` +
    `_Paste a contract address (0x...) to buy a token_`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '💎 Buy / Snipe', callback_data: 'buy:prompt' },
        { text: '📊 Positions', callback_data: 'nav:positions' },
      ],
      [
        { text: '💼 Wallets', callback_data: 'nav:wallets' },
        { text: '🔁 Transfers', callback_data: 'nav:transfers' },
      ],
      [
        { text: '📈 Stats', callback_data: 'nav:stats' },
        { text: '⚙️ Settings', callback_data: 'nav:settings' },
      ],
      [{ text: '❌ Close', callback_data: 'nav:close' }],
    ],
  };

  const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts })
      .catch(() => bot.sendMessage(chatId, text, opts));
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

// ════════════════════════════════════════════════════════════
// WALLETS MENU (Sigma-style)
// ════════════════════════════════════════════════════════════

async function _sendWalletsMenu(chatId, userId, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  const prefs = _getUserPrefs(userId);

  let text = `💼 *Settings › Wallets*\n\n`;

  if (wallets.length === 0) {
    text += `_No wallets. Create or import one to get started._`;
  } else {
    let totalEth = 0n;
    const balances = await Promise.all(wallets.map(async (w) => {
      const [base, eth] = await Promise.all([
        trading.getEthBalance('base', w.address).catch(() => 0n),
        trading.getEthBalance('ethereum', w.address).catch(() => 0n),
      ]);
      const total = base + eth;
      totalEth += total;
      return { base, eth, total };
    }));
    const ethPrice = await price.getEthPrice().catch(() => 0);
    const worth = parseFloat(ethers.formatEther(totalEth)) * ethPrice;

    text += `📊 Wallet Worth: *${_fmtUsd(worth)}*\n\n`;
    text += `_Your wallets:_\n\n`;

    wallets.forEach((w, i) => {
      const b = balances[i];
      const isDefault = w.id === prefs.activeWalletId;
      text += `${isDefault ? '⭐ ' : ''}*${i + 1}. ${w.label}*  `;
      text += `\`${_fmtEth(b.total)} Ξ\`\n`;
      text += `\`${w.address}\`\n\n`;
    });
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '➕ Create', callback_data: 'wallet:create' },
        { text: '📥 Import', callback_data: 'wallet:import' },
      ],
      [
        { text: '✏️ Rename', callback_data: 'wallet:rename' },
        { text: '🗑️ Remove', callback_data: 'wallet:remove' },
      ],
      [
        { text: '🔑 Private Keys', callback_data: 'wallet:keys' },
        { text: '⭐ Set Default', callback_data: 'wallet:setdefault' },
      ],
      [{ text: '⬅️ Back', callback_data: 'nav:main' }],
    ],
  };

  const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts })
      .catch(() => bot.sendMessage(chatId, text, opts));
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

async function _sendWalletPicker(chatId, userId, action, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Aucun wallet disponible.');
  }

  const actionLabels = {
    rename: '✏️ Rename',
    remove: '🗑️ Remove',
    reveal: '🔑 View Key',
    setdefault: '⭐ Set Default',
  };

  const text = `*${actionLabels[action]}* — Select a wallet:`;
  const keyboard = {
    inline_keyboard: [
      ...wallets.map((w, i) => [{
        text: `${i + 1}. ${w.label} (${_shortAddr(w.address)})`,
        callback_data: `walletsel:${action}:${w.id}`,
      }]),
      [{ text: '⬅️ Back', callback_data: 'nav:wallets' }],
    ],
  };

  const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts })
      .catch(() => bot.sendMessage(chatId, text, opts));
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

// ════════════════════════════════════════════════════════════
// BUY FLOW (Sigma-style token card)
// ════════════════════════════════════════════════════════════

async function _showBuyInterface(chatId, userId, tokenAddress) {
  const wallets = wallet.listWallets(userId);
  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Aucun wallet. Utilise /wallets pour en créer un.');
  }
  const prefs = _getUserPrefs(userId);
  const activeWallet = prefs.activeWalletId
    ? wallets.find(w => w.id === prefs.activeWalletId) || wallets[0]
    : wallets[0];

  // Determine chain & fetch info
  let chain = 'base';
  let dexInfo = await price.getTokenPrice('base', tokenAddress);
  if (!dexInfo || dexInfo.priceUsd === 0) {
    chain = 'ethereum';
    dexInfo = await price.getTokenPrice('ethereum', tokenAddress);
    if (!dexInfo || dexInfo.priceUsd === 0) {
      return bot.sendMessage(chatId,
        `❌ Token not found or no liquidity:\n\`${tokenAddress}\``,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Fetch all wallets' ETH balances on this chain
  const walletBals = await Promise.all(wallets.map(w => trading.getEthBalance(chain, w.address).catch(() => 0n)));

  const symbol = dexInfo.symbol || 'UNKNOWN';
  const name = dexInfo.name || symbol;
  const priceUsd = dexInfo.priceUsd;
  const mcap = dexInfo.fdv || 0;
  const liq = dexInfo.liquidityUsd;
  const change = dexInfo.priceChange24h || 0;
  const chainIcon = chain === 'base' ? '🔵' : '⟠';
  const chainName = chain === 'base' ? 'BASE' : 'ETHEREUM';
  const changeEmoji = change >= 0 ? '🟢' : '🔴';

  let text = `💎 *${name}* | *${symbol}* (${chainIcon} ${chainName})\n`;
  text += `\`${tokenAddress}\`\n\n`;
  text += `💰 *Pool Info:*\n`;
  text += `🏭 DEX: ${dexInfo.dex || 'Unknown'}\n`;
  text += `💵 Price: $${priceUsd.toFixed(8)} (${changeEmoji} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%)\n`;
  text += `💧 Liq: ${_fmtUsd(liq)}\n`;
  text += `📊 Vol 24h: ${_fmtUsd(dexInfo.volume24h || 0)}\n\n`;
  text += `💼 *Your Wallets (${chainName}):*\n`;
  wallets.forEach((w, i) => {
    const eth = parseFloat(ethers.formatEther(walletBals[i]));
    const isActive = w.id === activeWallet.id ? '⭐ ' : '';
    text += `${isActive}W${i + 1}: ${eth.toFixed(4)}Ξ\n`;
  });
  text += `\n_Active wallet: ${activeWallet.label}_\n`;
  text += `_Slippage: ${prefs.slippageBps / 100}%_`;

  const presets = _config.presets.buy;
  const presetBtns = presets.map(amt => ({
    text: `💰 Buy ${amt}Ξ`,
    callback_data: `buy:preset:${chain}:${tokenAddress}:${amt}:${activeWallet.id}`,
  }));

  // Wallet selector row (W1/W2/W3/W4)
  const walletBtns = wallets.slice(0, 4).map((w, i) => ({
    text: `${w.id === activeWallet.id ? '🟢' : '⚪'} W${i + 1}`,
    callback_data: `buy:walletsel:${chain}:${tokenAddress}:${w.id}`,
  }));

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: `buy:refresh:${chain}:${tokenAddress}` }],
      presetBtns.slice(0, 3),
      presetBtns.slice(3, 5),
      [
        { text: '✏️ Buy X (Custom)', callback_data: `buy:custom:${chain}:${tokenAddress}:${activeWallet.id}` },
      ],
      walletBtns,
      [
        { text: `📊 Slip ${prefs.slippageBps / 100}%`, callback_data: 'settings:slippage' },
        { text: '❌ Close', callback_data: 'nav:close' },
      ],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function _handleBuyCallback(query, data, userId) {
  const parts = data.split(':');
  const action = parts[1];
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  if (action === 'prompt') {
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '💎 Paste a contract address (0x...) to buy a token.');
  }

  if (action === 'refresh') {
    const [, , chain, tokenAddr] = parts;
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' });
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return _showBuyInterface(chatId, userId, tokenAddr);
  }

  if (action === 'walletsel') {
    const [, , , tokenAddr, walletId] = parts;
    _getUserPrefs(userId).activeWalletId = walletId;
    await bot.answerCallbackQuery(query.id, { text: 'Wallet changé' });
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return _showBuyInterface(chatId, userId, tokenAddr);
  }

  if (action === 'preset') {
    const [, , chain, tokenAddr, amountStr, walletId] = parts;
    const amount = parseFloat(amountStr);
    await bot.answerCallbackQuery(query.id, { text: `Achat ${amount} ETH en cours...` });
    return _executeBuy(chatId, userId, walletId, chain, tokenAddr, amount);
  }

  if (action === 'custom') {
    const [, , chain, tokenAddr, walletId] = parts;
    _state.set(userId, { step: 'buy_custom_amount', data: { chain, tokenAddr, walletId } });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '💵 Montant d\'ETH à dépenser ? (ex: 0.15)');
  }
}

async function _executeBuy(chatId, userId, walletId, chain, tokenAddr, amountEth) {
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Buy in progress*\n\n` +
    `Token: \`${_shortAddr(tokenAddr)}\`\n` +
    `Chain: ${chain}\n` +
    `Amount: ${amountEth} ETH`,
    { parse_mode: 'Markdown' }
  );

  try {
    const provider = trading.getProvider(chain);
    const signer = wallet.getSigner(userId, walletId, provider);
    const w = wallet.getWalletById(userId, walletId);
    const prefs = _getUserPrefs(userId);

    const balance = await trading.getEthBalance(chain, w.address);
    if (balance < ethers.parseEther(amountEth.toString())) {
      return bot.editMessageText(
        `❌ Balance insuffisante\n\nWallet a ${_fmtEth(balance)} ETH, besoin ${amountEth} ETH`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      );
    }

    const result = await trading.buy(chain, tokenAddr, amountEth, prefs.slippageBps, signer);

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
    const tokensReceived = Number(ethers.formatUnits(result.amountOutExpected, info.decimals));

    await bot.editMessageText(
      `✅ *Buy successful*\n\n` +
      `💎 ${info.symbol} bought via ${result.dex}\n` +
      `💰 Spent: ${amountEth} ETH\n` +
      `📦 Received: ${tokensReceived.toFixed(4)} ${info.symbol}\n` +
      `💵 Entry: $${(amountEth * ethPrice / tokensReceived).toFixed(6)}\n\n` +
      `[View tx](${explorer}/tx/${result.txHash})`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Buy error:', err.message);
    await bot.editMessageText(
      `❌ Buy failed\n\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    );
  }
}

// ════════════════════════════════════════════════════════════
// POSITIONS
// ════════════════════════════════════════════════════════════

async function _sendPositions(chatId, userId) {
  const pos = positions.getPositions(userId);
  if (pos.length === 0) {
    return bot.sendMessage(chatId, '📊 No open positions.\n\n_Paste a contract address to buy a token._', { parse_mode: 'Markdown' });
  }

  // Fetch prices
  const byChain = {};
  pos.forEach(p => {
    if (!byChain[p.chain]) byChain[p.chain] = [];
    byChain[p.chain].push(p.tokenAddress);
  });
  const pricesByChain = {};
  for (const [chain, addrs] of Object.entries(byChain)) {
    pricesByChain[chain] = await price.getTokenPrices(chain, addrs);
  }

  let text = `📊 *Open Positions* (${pos.length})\n\n`;
  for (const p of pos) {
    const current = pricesByChain[p.chain]?.[p.tokenAddress.toLowerCase()]?.priceUsd || 0;
    const value = p.amountTokens * current;
    const pnl = value - p.totalCostUsd;
    const pnlPct = p.totalCostUsd > 0 ? (pnl / p.totalCostUsd) * 100 : 0;
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    const sign = pnl >= 0 ? '+' : '';

    text += `${emoji} *${p.symbol}* (${p.chain})\n`;
    text += `  Entry: $${p.avgEntryUsd.toFixed(6)} → Now: $${current.toFixed(6)}\n`;
    text += `  Amount: ${p.amountTokens.toFixed(2)} | Value: ${_fmtUsd(value)}\n`;
    text += `  PnL: ${sign}${_fmtUsd(pnl)} (${sign}${pnlPct.toFixed(1)}%)\n\n`;
  }

  // Sell buttons per position
  const sellButtons = pos.flatMap((p, i) => [[
    { text: `💸 ${p.symbol} 25%`, callback_data: `sell:pct:${p.chain}:${p.tokenAddress}:25:${p.walletId}` },
    { text: '50%', callback_data: `sell:pct:${p.chain}:${p.tokenAddress}:50:${p.walletId}` },
    { text: '100%', callback_data: `sell:pct:${p.chain}:${p.tokenAddress}:100:${p.walletId}` },
  ]]);

  const keyboard = {
    inline_keyboard: [
      ...sellButtons.slice(0, 8), // cap at 8 rows (8 positions)
      [{ text: '⬅️ Main menu', callback_data: 'nav:main' }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function _handleSellCallback(query, data, userId) {
  const parts = data.split(':');
  const action = parts[1];
  const chatId = query.message.chat.id;

  if (action === 'pct') {
    const [, , chain, tokenAddr, pctStr, walletId] = parts;
    const pct = parseInt(pctStr, 10);
    await bot.answerCallbackQuery(query.id, { text: `Selling ${pct}%...` });
    return _executeSell(chatId, userId, walletId, chain, tokenAddr, pct);
  }
}

async function _executeSell(chatId, userId, walletId, chain, tokenAddr, pct) {
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Sell in progress*\n\nAmount: ${pct}%\nChain: ${chain}`,
    { parse_mode: 'Markdown' }
  );

  try {
    const provider = trading.getProvider(chain);
    const signer = wallet.getSigner(userId, walletId, provider);
    const w = wallet.getWalletById(userId, walletId);
    const prefs = _getUserPrefs(userId);

    // Get current balance of token
    const info = await trading.getTokenInfo(chain, tokenAddr, w.address);
    if (info.balance === 0n) {
      return bot.editMessageText(`❌ No ${info.symbol} balance in this wallet.`,
        { chat_id: chatId, message_id: loadingMsg.message_id });
    }
    const amountIn = info.balance * BigInt(pct) / 100n;

    const result = await trading.sell(chain, tokenAddr, amountIn, prefs.slippageBps, signer);

    const ethPrice = await price.getEthPrice();
    const { realizedPnl } = positions.recordSell({
      userId, walletId, walletAddr: w.address, chain,
      tokenAddress: tokenAddr,
      symbol: info.symbol,
      decimals: info.decimals,
      amountTokens: amountIn,
      amountEthReceived: result.amountOutExpected,
      ethPriceUsd: ethPrice,
      txHash: result.txHash,
    });

    const ethOut = _fmtEth(result.amountOutExpected);
    const explorer = _config.chains[chain].explorer;
    const pnlEmoji = realizedPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = realizedPnl >= 0 ? '+' : '';

    await bot.editMessageText(
      `✅ *Sell successful*\n\n` +
      `${pnlEmoji} ${info.symbol} sold via ${result.dex}\n` +
      `📦 Sold: ${Number(ethers.formatUnits(amountIn, info.decimals)).toFixed(4)} ${info.symbol}\n` +
      `💰 Received: ${ethOut} ETH (${_fmtUsd(parseFloat(ethOut) * ethPrice)})\n` +
      `📈 Realized PnL: *${pnlSign}${_fmtUsd(realizedPnl)}*\n\n` +
      `[View tx](${explorer}/tx/${result.txHash})`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Sell error:', err.message);
    await bot.editMessageText(
      `❌ Sell failed\n\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    );
  }
}

// ════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════

async function _sendSettingsMenu(chatId, userId, editMsgId = null) {
  const prefs = _getUserPrefs(userId);
  const text =
    `⚙️ *Settings*\n\n` +
    `📊 Slippage: *${prefs.slippageBps / 100}%*\n` +
    `⛽ Gas buffer: x${_config.trading.defaultGasBufferMultiplier}\n` +
    `💰 Buy presets: ${_config.presets.buy.join(', ')} ETH`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📊 Slippage', callback_data: 'settings:slippage' }],
      [{ text: '⬅️ Main menu', callback_data: 'nav:main' }],
    ],
  };

  const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts })
      .catch(() => bot.sendMessage(chatId, text, opts));
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

// ════════════════════════════════════════════════════════════
// STATEFUL CONVERSATIONS
// ════════════════════════════════════════════════════════════

async function _handleStatefulInput(msg, state) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (state.step === 'wallet_create_label') {
    const label = text.slice(0, 40);
    const w = wallet.generateWallet(userId, label);
    _state.delete(userId);
    await bot.sendMessage(chatId,
      `✅ *Wallet created*\n\n` +
      `Label: *${w.label}*\n` +
      `Address: \`${w.address}\`\n\n` +
      (w.mnemonic
        ? `🔐 *Mnemonic* (sauvegarde IMMÉDIATEMENT, ne sera JAMAIS réaffiché):\n\`${w.mnemonic}\`\n\n⚠️ Supprime ce message après avoir sauvegardé.`
        : ''),
      { parse_mode: 'Markdown' }
    );
    return _sendWalletsMenu(chatId, userId);
  }

  if (state.step === 'wallet_import_pk') {
    try {
      const imported = wallet.importWallet(userId, text, 'Imported');
      _state.delete(userId);
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      await bot.sendMessage(chatId,
        `✅ *Wallet imported*\n\nAddress: \`${imported.address}\`\n\n🔐 Message supprimé.`,
        { parse_mode: 'Markdown' }
      );
      return _sendWalletsMenu(chatId, userId);
    } catch (err) {
      _state.delete(userId);
      return bot.sendMessage(chatId, `❌ Import failed: ${err.message}`);
    }
  }

  if (state.step === 'wallet_rename_label') {
    const { walletId } = state.data;
    wallet.renameWallet(userId, walletId, text);
    _state.delete(userId);
    await bot.sendMessage(chatId, `✅ Wallet renommé.`);
    return _sendWalletsMenu(chatId, userId);
  }

  if (state.step === 'buy_custom_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, '⚠️ Montant invalide. Essaie (ex: 0.15)');
    }
    const { chain, tokenAddr, walletId } = state.data;
    _state.delete(userId);
    return _executeBuy(chatId, userId, walletId, chain, tokenAddr, amount);
  }

  if (state.step === 'settings_slippage') {
    const pct = parseFloat(text);
    if (isNaN(pct) || pct <= 0 || pct > 30) {
      return bot.sendMessage(chatId, '⚠️ Slippage invalide (0-30%)');
    }
    _getUserPrefs(userId).slippageBps = Math.round(pct * 100);
    _state.delete(userId);
    return bot.sendMessage(chatId, `✅ Slippage set to ${pct}%`);
  }
}

module.exports = { init };
