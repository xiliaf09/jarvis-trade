// ============================================================
// JARVIS TRADE — Telegram Bot UI (Sigma-inspired, multi-chain EVM)
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const wallet = require('./wallet');
const trading = require('./trading');
const positions = require('./positions');
const price = require('./price');
const transfers = require('./transfers');

let bot = null;
let _config = null;
const _state = new Map();
const _userPrefs = new Map();
const _positionRefreshers = new Map(); // msgId → interval id

function init(config) {
  _config = config;
  bot = new TelegramBot(config.telegramToken, {
    polling: { interval: 2000, autoStart: true, params: { timeout: 30 } },
  });
  bot.on('polling_error', (err) => {
    console.error('⚠️  Telegram polling error:', err.code, err.message);
  });
  bot.on('message', (msg) => {
    console.log(`[INCOMING] from=${msg.from?.id} text="${(msg.text || '').slice(0, 40)}"`);
  });
  _registerHandlers();

  // Register command menu (shown when user types "/")
  bot.setMyCommands([
    { command: 'start',     description: 'Main menu' },
    { command: 'wallets',   description: 'Manage wallets, balances, keys' },
    { command: 'positions', description: 'Open positions with live PnL' },
    { command: 'chains',    description: 'Switch active chain (Base / ETH / BSC)' },
    { command: 'settings',  description: 'Buy/Sell/Gas presets, slippage, etc.' },
    { command: 'stats',     description: 'Trading stats — win rate, realized PnL' },
    { command: 'transfers', description: 'Send ETH/tokens, consolidate or dispatch' },
  ]).catch(e => console.error('setMyCommands failed:', e.message));

  console.log('📱 Telegram bot connected');
}

function _isAuthorized(msg) {
  const userId = String(msg.from?.id || msg.chat?.id);
  return _config.authorizedUsers.includes(userId);
}

// ── User prefs (in memory — can be persisted later) ──
function _getUserPrefs(userId) {
  if (!_userPrefs.has(userId)) {
    const defaults = {
      activeChain: 'base',
      activeWalletByChain: {}, // { base: walletId, ethereum: walletId, bsc: walletId }
      slippageBps: 100,
      tradeConfirmation: false,
      buyPresets: {
        base: [..._config.defaultPresets.base.buy],
        ethereum: [..._config.defaultPresets.ethereum.buy],
        bsc: [..._config.defaultPresets.bsc.buy],
      },
      sellPresets: [..._config.sellPercentPresets],
      gasPresets: {
        base: [..._config.defaultPresets.base.gasGwei],
        ethereum: [..._config.defaultPresets.ethereum.gasGwei],
        bsc: [..._config.defaultPresets.bsc.gasGwei],
      },
      gasPresetIdx: 1, // 0=slow, 1=normal, 2=fast
      buyContext: null,
      positionsContext: null,
      recentTokens: [], // [{ chain, address, symbol }, ...] — last 3 tokens interacted with
    };
    _userPrefs.set(userId, defaults);
  }
  return _userPrefs.get(userId);
}

// Track the 3 most recently viewed tokens for quick re-access
function _trackRecentToken(userId, chain, tokenAddress, symbol) {
  const prefs = _getUserPrefs(userId);
  if (!prefs.recentTokens) prefs.recentTokens = [];
  // Remove if already present
  prefs.recentTokens = prefs.recentTokens.filter(t =>
    !(t.chain === chain && t.address.toLowerCase() === tokenAddress.toLowerCase())
  );
  // Add to front
  prefs.recentTokens.unshift({ chain, address: tokenAddress, symbol });
  // Keep last 3
  prefs.recentTokens = prefs.recentTokens.slice(0, 3);
}

// ── Helpers ──
function _getActiveWallet(userId, chain) {
  const wallets = wallet.listWallets(userId);
  if (wallets.length === 0) return null;
  const prefs = _getUserPrefs(userId);
  const ch = chain || prefs.activeChain;
  const walletId = prefs.activeWalletByChain[ch];
  if (walletId) {
    const w = wallets.find(w => w.id === walletId);
    if (w) return w;
  }
  // Fallback: first wallet
  return wallets[0];
}

function _setActiveWallet(userId, chain, walletId) {
  const prefs = _getUserPrefs(userId);
  prefs.activeWalletByChain[chain] = walletId;
}

// ── Formatters ──
function _shortAddr(addr) { return `${addr.slice(0, 6)}...${addr.slice(-4)}`; }
function _fmtEth(wei) { return parseFloat(ethers.formatEther(wei)).toFixed(4); }
function _fmtUsd(n) {
  if (!isFinite(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return sign + '$' + abs.toFixed(2);
  if (abs >= 0.01) return sign + '$' + abs.toFixed(4);
  if (abs === 0) return '$0';
  return sign + '$' + abs.toFixed(6);
}
function _chainIcon(chain) { return _config.chains[chain]?.icon || '🔵'; }
function _chainSymbol(chain) { return _config.chains[chain]?.symbol || 'ETH'; }
function _chainName(chain) { return _config.chains[chain]?.name || chain; }

function _safe(handler) {
  return async (msg, match) => {
    try {
      if (!_isAuthorized(msg)) return;
      console.log(`[HANDLER] ${(msg.text || '').slice(0, 30)} from ${msg.from?.id}`);
      await handler(msg, match);
    } catch (err) {
      console.error('❌ Handler error:', err.message, err.stack);
      try { await bot.sendMessage(msg.chat.id, `⚠️ Erreur: ${err.message.slice(0, 120)}`); } catch (_) {}
    }
  };
}

// ════════════════════════════════════════════════════════════
// HANDLERS REGISTRATION
// ════════════════════════════════════════════════════════════

function _registerHandlers() {
  bot.onText(/^\/start/, _safe(async (msg) => _sendMainMenu(msg.chat.id, String(msg.from.id))));
  bot.onText(/^\/wallets?$/, _safe(async (msg) => _sendWalletsMenu(msg.chat.id, String(msg.from.id))));
  bot.onText(/^\/positions/, _safe(async (msg) => _sendPositions(msg.chat.id, String(msg.from.id))));
  bot.onText(/^\/settings/, _safe(async (msg) => _sendSettingsMenu(msg.chat.id, String(msg.from.id))));
  bot.onText(/^\/chains/, _safe(async (msg) => _sendChainsMenu(msg.chat.id, String(msg.from.id))));
  bot.onText(/^\/stats/, _safe(async (msg) => _sendStats(msg.chat.id, String(msg.from.id))));
  bot.onText(/^\/transfers?$/, _safe(async (msg) => _sendTransfersMenu(msg.chat.id, String(msg.from.id))));

  bot.on('message', async (msg) => {
    if (!_isAuthorized(msg)) return;
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const userId = String(msg.from.id);
    const state = _state.get(userId);
    if (state) { await _handleStatefulInput(msg, state); return; }

    // Auto-detect ERC20 contract
    if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
      await _showBuyInterface(msg.chat.id, userId, text);
    }
  });

  bot.on('callback_query', async (query) => {
    const userId = String(query.from.id);
    if (!_config.authorizedUsers.includes(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
    }
    try {
      await _handleCallback(query, userId);
    } catch (err) {
      console.error('❌ Callback error:', err.message);
      try { await bot.answerCallbackQuery(query.id, { text: `Erreur: ${err.message.slice(0, 50)}` }); } catch (_) {}
    }
  });
}

// ════════════════════════════════════════════════════════════
// CALLBACK ROUTER
// ════════════════════════════════════════════════════════════

async function _handleCallback(query, userId) {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  // Navigation
  if (data === 'nav:main') { await bot.answerCallbackQuery(query.id); return _sendMainMenu(chatId, userId, msgId); }
  if (data === 'nav:wallets') { await bot.answerCallbackQuery(query.id); return _sendWalletsMenu(chatId, userId, msgId); }
  if (data === 'nav:positions') { await bot.answerCallbackQuery(query.id); return _sendPositions(chatId, userId); }
  if (data === 'nav:settings') { await bot.answerCallbackQuery(query.id); return _sendSettingsMenu(chatId, userId, msgId); }
  if (data === 'nav:chains') { await bot.answerCallbackQuery(query.id); return _sendChainsMenu(chatId, userId, msgId); }
  if (data === 'nav:stats') { await bot.answerCallbackQuery(query.id); return _sendStats(chatId, userId); }
  if (data === 'nav:transfers') { await bot.answerCallbackQuery(query.id); return _sendTransfersMenu(chatId, userId, msgId); }

  if (data === 'nav:close' || data === 'cancel' || data === 'msg:delete') {
    if (data !== 'msg:delete') _state.delete(userId);
    // Stop refresher if any
    const rid = _positionRefreshers.get(msgId);
    if (rid) { clearInterval(rid); _positionRefreshers.delete(msgId); }
    await bot.answerCallbackQuery(query.id, data === 'msg:delete' ? { text: '🗑️ Supprimé' } : undefined);
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  // Chain selection
  if (data.startsWith('chain:')) {
    const ch = data.split(':')[1];
    if (_config.chainKeys.includes(ch)) {
      _getUserPrefs(userId).activeChain = ch;
      await bot.answerCallbackQuery(query.id, { text: `Chain: ${_chainName(ch)}` });
      return _sendChainsMenu(chatId, userId, msgId);
    }
  }

  // Wallet actions
  if (data === 'wallet:create') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'wallet_create_label' });
    return bot.sendMessage(chatId, '🏷️ Nom du wallet ? (ex: "Main", "Sniper")');
  }
  if (data === 'wallet:import') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'wallet_import_pk' });
    return bot.sendMessage(chatId, '🔑 Colle la clé privée.\n\n⚠️ Ton message sera supprimé dès traité.');
  }
  if (data === 'wallet:rename') { await bot.answerCallbackQuery(query.id); return _sendWalletPicker(chatId, userId, 'rename', msgId); }
  if (data === 'wallet:remove') { await bot.answerCallbackQuery(query.id); return _sendWalletPicker(chatId, userId, 'remove', msgId); }
  if (data === 'wallet:keys')   { await bot.answerCallbackQuery(query.id); return _sendWalletPicker(chatId, userId, 'reveal', msgId); }
  if (data === 'wallet:setdefault') { await bot.answerCallbackQuery(query.id); return _sendWalletPicker(chatId, userId, 'setdefault', msgId); }

  if (data.startsWith('walletsel:')) return _handleWalletSel(query, data, userId);
  if (data.startsWith('walletdel:')) {
    const [, walletId] = data.split(':');
    wallet.deleteWallet(userId, walletId);
    await bot.answerCallbackQuery(query.id, { text: 'Wallet supprimé' });
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  if (data.startsWith('buy:')) return _handleBuyCallback(query, data, userId);
  if (data.startsWith('sell:')) return _handleSellCallback(query, data, userId);
  if (data.startsWith('sellt:')) return _handleSellTokenCallback(query, data, userId);
  if (data.startsWith('settings:')) return _handleSettingsCallback(query, data, userId);
  if (data.startsWith('tr:')) return _handleTransfersCallback(query, data, userId);

  await bot.answerCallbackQuery(query.id);
}

// ════════════════════════════════════════════════════════════
// MAIN MENU
// ════════════════════════════════════════════════════════════

async function _sendMainMenu(chatId, userId, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  const stats = positions.getStats(userId);
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;

  // Total worth in USD across all chains
  let worthUsd = 0;
  for (const ch of _config.chainKeys) {
    let nativeTotal = 0n;
    for (const w of wallets) {
      try { nativeTotal += await trading.getNativeBalance(ch, w.address); } catch (_) {}
    }
    const nativePrice = await price.getNativePrice(ch).catch(() => 0);
    worthUsd += parseFloat(ethers.formatEther(nativeTotal)) * nativePrice;
  }

  const text =
    `🤖 *JARVIS TRADE*\n` +
    `_Your custom trading bot · 0% fees_\n\n` +
    `🌐 Active Chain: *${_chainIcon(chain)} ${_chainName(chain)}*\n` +
    `💰 Total Worth: *${_fmtUsd(worthUsd)}*\n` +
    `💼 Wallets: ${wallets.length} · 📊 Positions: ${stats.openPositions}\n` +
    `📈 Realized PnL: *${stats.realizedPnl >= 0 ? '+' : ''}${_fmtUsd(stats.realizedPnl)}*\n\n` +
    `_Paste a contract address (0x...) to buy a token_`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '💎 Buy / Snipe', callback_data: 'buy:prompt' },
        { text: '📊 Positions', callback_data: 'nav:positions' },
      ],
      [
        { text: '💼 Wallets', callback_data: 'nav:wallets' },
        { text: '🌐 Chains', callback_data: 'nav:chains' },
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
// CHAINS MENU (switcher)
// ════════════════════════════════════════════════════════════

async function _sendChainsMenu(chatId, userId, editMsgId = null) {
  const prefs = _getUserPrefs(userId);
  const active = prefs.activeChain;

  const text = `🌐 *Chain Selection*\n\n_Active : ${_chainIcon(active)} ${_chainName(active)}_\n\nChoisis la chaîne active pour les trades:`;
  const keyboard = {
    inline_keyboard: [
      ..._config.chainKeys.map(ch => [{
        text: `${active === ch ? '🟢 ' : ''}${_chainIcon(ch)} ${_chainName(ch)}`,
        callback_data: `chain:${ch}`,
      }]),
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

// ════════════════════════════════════════════════════════════
// WALLETS MENU
// ════════════════════════════════════════════════════════════

async function _sendWalletsMenu(chatId, userId, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;

  let text = `💼 *Wallets* — ${_chainIcon(chain)} ${_chainName(chain)}\n\n`;

  if (wallets.length === 0) {
    text += `_No wallets. Create or import to start._`;
  } else {
    let totalUsd = 0;
    const nativePrice = await price.getNativePrice(chain).catch(() => 0);
    const balances = await Promise.all(wallets.map(w => trading.getNativeBalance(chain, w.address).catch(() => 0n)));
    balances.forEach(b => totalUsd += parseFloat(ethers.formatEther(b)) * nativePrice);

    text += `📊 Worth (${_chainSymbol(chain)}): *${_fmtUsd(totalUsd)}*\n\n`;
    const activeId = prefs.activeWalletByChain[chain];
    wallets.forEach((w, i) => {
      const b = balances[i];
      const isDefault = w.id === activeId;
      const bal = parseFloat(ethers.formatEther(b));
      const usd = bal * nativePrice;
      text += `${isDefault ? '⭐ ' : ''}*${i + 1}. ${w.label}*  `;
      text += `\`${bal.toFixed(4)} ${_chainSymbol(chain)}\` _(${_fmtUsd(usd)})_\n`;
      text += `\`${w.address}\`\n\n`;
    });
    text += `_⭐ = wallet actif pour ${_chainIcon(chain)} ${_chainName(chain)}_\n`;
    text += `_Change de chain via /chains pour gérer un autre wallet par défaut_`;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Create', callback_data: 'wallet:create' }, { text: '📥 Import', callback_data: 'wallet:import' }],
      [{ text: '✏️ Rename', callback_data: 'wallet:rename' }, { text: '🗑️ Remove', callback_data: 'wallet:remove' }],
      [{ text: '🔑 Private Keys', callback_data: 'wallet:keys' }, { text: '⭐ Set Default', callback_data: 'wallet:setdefault' }],
      [{ text: '🔁 Transfers', callback_data: 'nav:transfers' }],
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
  if (wallets.length === 0) return bot.sendMessage(chatId, '⚠️ Aucun wallet.');

  const labels = { rename: '✏️ Rename', remove: '🗑️ Remove', reveal: '🔑 View Key', setdefault: '⭐ Set Default' };
  const text = `*${labels[action]}* — Select a wallet:`;
  const keyboard = {
    inline_keyboard: [
      ...wallets.map((w, i) => [{ text: `${i + 1}. ${w.label} (${_shortAddr(w.address)})`, callback_data: `walletsel:${action}:${w.id}` }]),
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

async function _handleWalletSel(query, data, userId) {
  const [, action, walletId] = data.split(':');
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  await bot.answerCallbackQuery(query.id);

  if (action === 'rename') {
    _state.set(userId, { step: 'wallet_rename_label', data: { walletId } });
    return bot.sendMessage(chatId, '🏷️ Nouveau nom ?');
  }
  if (action === 'remove') {
    const w = wallet.getWalletById(userId, walletId);
    if (!w) return;
    return bot.sendMessage(chatId,
      `⚠️ Supprimer *${w.label}* ?\n\`${w.address}\`\n\nAction *irréversible*. Exporte la clé privée avant si nécessaire.`,
      { parse_mode: 'Markdown', reply_markup: {
        inline_keyboard: [[
          { text: '🗑️ Confirmer', callback_data: `walletdel:${walletId}` },
          { text: '❌ Annuler', callback_data: 'cancel' },
        ]],
      }}
    );
  }
  if (action === 'reveal') {
    const pk = wallet.revealPrivateKey(userId, walletId);
    const w = wallet.getWalletById(userId, walletId);
    const keyMsg = await bot.sendMessage(chatId,
      `🔑 *${w.label}*\n\n\`${pk}\`\n\n⚠️ Ne partage JAMAIS cette clé.\n_Auto-suppression dans 60s ou clique le bouton._`,
      { parse_mode: 'Markdown', reply_markup: {
        inline_keyboard: [[{ text: '🗑️ Delete now', callback_data: 'msg:delete' }]],
      }}
    );
    setTimeout(() => bot.deleteMessage(chatId, keyMsg.message_id).catch(() => {}), 60000);
    return;
  }
  if (action === 'setdefault') {
    const prefs = _getUserPrefs(userId);
    _setActiveWallet(userId, prefs.activeChain, walletId);
    return _sendWalletsMenu(chatId, userId, msgId);
  }
}

// ════════════════════════════════════════════════════════════
// BUY INTERFACE
// ════════════════════════════════════════════════════════════

/**
 * Main entry: fetches REAL on-chain balance for all wallets.
 * If any wallet holds the token → SELL menu.
 * Otherwise → BUY menu.
 * Also auto-cleans stale stored positions (qty stored but balance on-chain = 0).
 */
async function _showBuyInterface(chatId, userId, tokenAddress, forceMode = null, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Aucun wallet. Utilise /wallets pour en créer un.');
  }
  const prefs = _getUserPrefs(userId);

  // Detect chain
  const order = [prefs.activeChain, ..._config.chainKeys.filter(c => c !== prefs.activeChain)];
  let chain = null, dexInfo = null;
  for (const ch of order) {
    const info = await price.getTokenPrice(ch, tokenAddress);
    if (info && info.priceUsd > 0) { chain = ch; dexInfo = info; break; }
  }
  if (!chain) {
    return bot.sendMessage(chatId, `❌ Token introuvable ou pas de liquidité:\n\`${tokenAddress}\``, { parse_mode: 'Markdown' });
  }

  // Fetch REAL on-chain balance for each wallet (multi-RPC retry)
  const onChainBalances = await Promise.all(wallets.map(async (w) => {
    const bal = await trading.getOnChainTokenBalance(chain, tokenAddress, w.address);
    return { wallet: w, balance: bal };
  }));

  const holdingWallets = onChainBalances.filter(x => x.balance > 0n);

  // Auto-cleanup: remove stale stored positions (stored but not on-chain)
  const storedPositions = positions.getPositions(userId).filter(p =>
    p.chain === chain && p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );
  for (const p of storedPositions) {
    const onchain = onChainBalances.find(x => x.wallet.id === p.walletId);
    if (!onchain || onchain.balance === 0n) {
      // Balance is really 0 on-chain → remove stale position
      positions.removePosition?.(userId, p.walletId, chain, tokenAddress);
    }
  }

  // Re-fetch positions after cleanup
  const freshPositions = positions.getPositions(userId).filter(p =>
    p.chain === chain && p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );

  const mode = forceMode || (holdingWallets.length > 0 ? 'sell' : 'buy');

  // Track recent token for pinned buttons
  _trackRecentToken(userId, chain, tokenAddress, dexInfo.symbol || 'TOKEN');

  return _renderTokenView(chatId, userId, chain, tokenAddress, dexInfo, mode, freshPositions, onChainBalances, editMsgId);
}

/**
 * Unified token view — renders either Buy menu or Sell menu with position info.
 * Supports multi-wallet selection (Set).
 */
async function _renderTokenView(chatId, userId, chain, tokenAddress, dexInfo, mode, userPositions, onChainBalances = null, editMsgId = null) {
  const wallets = wallet.listWallets(userId);
  const prefs = _getUserPrefs(userId);

  const symbol = dexInfo.symbol || 'UNKNOWN';
  const name = dexInfo.name || symbol;
  const priceUsd = dexInfo.priceUsd;
  const liq = dexInfo.liquidityUsd;
  const vol = dexInfo.volume24h || 0;
  const change = dexInfo.priceChange24h || 0;
  const changeEmoji = change >= 0 ? '🟢' : '🔴';
  const nativeSymbol = _chainSymbol(chain);
  const nativePrice = await price.getNativePrice(chain).catch(() => 0);

  // If onChainBalances not provided, fetch now
  if (!onChainBalances) {
    onChainBalances = await Promise.all(wallets.map(async (w) => ({
      wallet: w,
      balance: await trading.getOnChainTokenBalance(chain, tokenAddress, w.address),
    })));
  }

  // For sell mode: only wallets with real on-chain balance > 0
  const availableWallets = mode === 'sell'
    ? onChainBalances.filter(x => x.balance > 0n).map(x => x.wallet)
    : wallets.slice(0, 4);

  // Initialize or refresh context (preserve selectedWalletIds when only mode changes)
  const ctxChanged = !prefs.buyContext || prefs.buyContext.tokenAddress !== tokenAddress;
  const modeChanged = prefs.buyContext && prefs.buyContext.mode !== mode;
  if (ctxChanged) {
    let defaultIds = [];
    if (mode === 'sell') {
      defaultIds = availableWallets.length > 0 ? [availableWallets[0].id] : [];
    } else {
      const active = _getActiveWallet(userId, chain);
      defaultIds = active ? [active.id] : (wallets[0] ? [wallets[0].id] : []);
    }
    prefs.buyContext = { chain, tokenAddress, mode, selectedWalletIds: new Set(defaultIds) };
  } else {
    prefs.buyContext.mode = mode;
    // On mode change, if sell mode has no selected wallets holding the token, pick one
    if (modeChanged && mode === 'sell' && availableWallets.length > 0) {
      const current = Array.from(prefs.buyContext.selectedWalletIds).filter(id =>
        availableWallets.some(w => w.id === id)
      );
      if (current.length === 0) {
        prefs.buyContext.selectedWalletIds = new Set([availableWallets[0].id]);
      }
    }
  }
  const ctx = prefs.buyContext;

  // Position aggregate
  let posText = '';
  let totalQty = 0, totalCost = 0, totalValue = 0, avgEntry = 0;
  if (userPositions.length > 0) {
    userPositions.forEach(p => {
      totalQty += p.amountTokens;
      totalCost += p.totalCostUsd;
      totalValue += p.amountTokens * priceUsd;
    });
    avgEntry = totalQty > 0 ? totalCost / totalQty : 0;
    const pnl = totalValue - totalCost;
    const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
    const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    const sign = pnl >= 0 ? '+' : '';
    posText =
      `\n📊 *Your Position:*\n` +
      `${pnlEmoji} PnL: *${sign}${_fmtUsd(pnl)}* (*${sign}${pnlPct.toFixed(1)}%*)\n` +
      `💰 Value: ${_fmtUsd(totalValue)}  ·  Cost: ${_fmtUsd(totalCost)}\n` +
      `📦 Qty: ${totalQty.toFixed(4)} ${symbol}\n` +
      `📍 Avg Entry: $${avgEntry.toFixed(8)}\n`;
  }

  // Fetch all wallets' native balances + gas
  const allWalletBals = await Promise.all(wallets.map(w => trading.getNativeBalance(chain, w.address).catch(() => 0n)));
  const gasGwei = await trading.getGasPriceGwei(chain).catch(() => 0);

  // Estimated tx fees (buy ~200k gas, sell ~220k gas)
  const buyGasEth = (gasGwei * 200000) / 1e9;
  const sellGasEth = (gasGwei * 220000) / 1e9;
  const buyFeeUsd = buyGasEth * nativePrice;
  const sellFeeUsd = sellGasEth * nativePrice;

  const mcap = dexInfo.fdv || 0;

  // Header — exact Sigma format
  let text = `*${symbol}* | *${name}* (🔗 ${_chainName(chain).toUpperCase()})\n`;
  text += `\`${tokenAddress}\`\n\n`;

  // Pool Info
  text += `💰 *Pool Info:*\n`;
  text += `🏭 DEX: ${dexInfo.dex || 'Unknown'}\n`;
  text += `💲 MCap: ${_fmtUsd(mcap)}\n`;
  text += `💧 Liq: ${_fmtUsd(liq)} | -\n`;
  text += `💸 TxFees: B ${_fmtUsd(buyFeeUsd)} | S ${_fmtUsd(sellFeeUsd)}\n\n`;

  // Token Info (stubbed — we don't have on-chain tax detection yet)
  text += `*Token Info:*\n`;
  text += `B -% | S -% | T -%\n`;
  text += `🎒 MaxTx: —\n`;
  text += `🔥 Burnt: —\n`;
  text += `🧯 Clogged: —\n\n`;

  // Price line with emoji
  text += `${changeEmoji} Price: $${priceUsd.toFixed(8)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)\n`;

  // Per-wallet positions
  const holdingWallets = onChainBalances.filter(x => x.balance > 0n);
  if (holdingWallets.length > 0) {
    text += `\n`;
    for (const { wallet: w, balance } of holdingWallets) {
      const globalIdx = wallets.findIndex(ww => ww.id === w.id);
      const actualQty = parseFloat(ethers.formatUnits(balance, 18));
      const storedPos = userPositions.find(p => p.walletId === w.id);
      const avgEntry = storedPos?.avgEntryUsd || priceUsd;
      const costUsd = actualQty * avgEntry;
      const worthUsd = actualQty * priceUsd;
      const worthNative = nativePrice > 0 ? worthUsd / nativePrice : 0;
      const costNative = nativePrice > 0 ? costUsd / nativePrice : 0;
      const pnl = worthUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnl / costUsd) * 100 : 0;
      const pnlEmoji = pnl >= 0 ? '🟩' : '🟥';
      const sign = pnl >= 0 ? '+' : '';
      const avgMc = mcap > 0 && priceUsd > 0 ? (avgEntry * mcap / priceUsd) : 0;
      const bagStr = _fmtTokenAmount(actualQty);

      text += `[${globalIdx + 1}] ${pnlEmoji} Profit: *${sign}${pnlPct.toFixed(2)}%* (${sign}${_fmtUsd(pnl)}) · Avg MC: ${_fmtUsd(avgMc)}\n`;
      text += `Worth: ${worthNative.toFixed(4)}Ξ · Cost: ${costNative.toFixed(4)}Ξ · Bag: ${bagStr} | 0.000%\n`;
    }
  }

  // All wallets native balances — single line (Sigma format)
  text += `\n`;
  const balLine = wallets.map((w, i) => {
    const bal = parseFloat(ethers.formatEther(allWalletBals[i]));
    const balStr = bal < 0.001 ? bal.toFixed(4) : bal.toFixed(1);
    return `W${i + 1}: ${balStr}Ξ`;
  }).join(' | ');
  text += balLine;

  // Build keyboard
  const keyboard = { inline_keyboard: _buildTokenKeyboard(userId, mode, availableWallets, userPositions) };
  const opts = { parse_mode: 'Markdown', reply_markup: keyboard, disable_web_page_preview: true };

  if (editMsgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts });
    } catch (err) {
      // If edit fails (message too old, not found, etc), fall back to new message
      if (!err.message?.includes('message is not modified')) {
        return bot.sendMessage(chatId, text, opts);
      }
    }
    return;
  }
  return bot.sendMessage(chatId, text, opts);
}

// Format token quantity with K/M suffix
function _fmtTokenAmount(qty) {
  if (qty >= 1e9) return (qty / 1e9).toFixed(2) + 'B';
  if (qty >= 1e6) return (qty / 1e6).toFixed(2) + 'M';
  if (qty >= 1e3) return (qty / 1e3).toFixed(1) + 'K';
  if (qty >= 1) return qty.toFixed(2);
  return qty.toFixed(4);
}

/**
 * Build the keyboard for the token view — extracted so we can reuse for reply_markup-only updates
 */
function _buildTokenKeyboard(userId, mode, availableWallets, userPositions) {
  const prefs = _getUserPrefs(userId);
  const ctx = prefs.buyContext;
  const wallets = wallet.listWallets(userId);
  const nativeSymbol = _chainSymbol(ctx.chain);
  const gasPresetIdx = prefs.gasPresetIdx ?? 1;
  const gasPresets = prefs.gasPresets?.[ctx.chain] || [0.1, 0.5, 1];
  const gasGweiValue = gasPresets[gasPresetIdx] ?? 1;

  // Recent tokens (pinned row)
  const recent = (prefs.recentTokens || []).slice(0, 3);
  const recentRow = recent.map((t, i) => {
    const isCurrent = t.chain === ctx.chain && t.address.toLowerCase() === ctx.tokenAddress.toLowerCase();
    return { text: `${isCurrent ? '✅ ' : ''}${t.symbol}`, callback_data: `buy:rt:${i}` };
  });

  // Wallet toggle buttons (global index used)
  const walletBtns = availableWallets.map((w) => {
    const globalIdx = wallets.findIndex(ww => ww.id === w.id);
    const checked = ctx.selectedWalletIds?.has(w.id);
    return { text: `W${globalIdx + 1} ${checked ? '🟢' : '⚪'}`, callback_data: `buy:tog:${globalIdx}` };
  });

  if (mode === 'buy') {
    const presets = prefs.buyPresets[ctx.chain];
    const presetBtns = presets.map((amt, idx) => ({
      text: `💰 ${amt}${nativeSymbol}`,
      callback_data: `buy:p:${idx}`,
    }));

    const rows = [[{ text: '🔄 Refresh', callback_data: 'buy:r' }]];
    if (recentRow.length > 0) rows.push(recentRow);
    if (userPositions.length > 0) rows.push([{ text: '🔄 Switch to Sell Menu', callback_data: 'buy:toggle' }]);
    rows.push(presetBtns.slice(0, 3));
    if (presetBtns.length > 3) rows.push(presetBtns.slice(3, 5));
    rows.push([{ text: `✏️ Buy X${nativeSymbol}`, callback_data: 'buy:c' }]);
    for (let i = 0; i < walletBtns.length; i += 2) rows.push(walletBtns.slice(i, i + 2));
    rows.push([
      { text: `🔥 ${gasGweiValue} GWEI`, callback_data: 'settings:gasbtns' },
      { text: `Slip ${prefs.slippageBps / 100}%`, callback_data: 'settings:slippage' },
    ]);
    rows.push([
      { text: '📈 Limit Order', callback_data: 'buy:limit' },
      { text: '❌ Close', callback_data: 'nav:close' },
    ]);
    return rows;
  }

  // SELL mode — Sigma-exact layout
  const sellPresets = prefs.sellPresets; // typically [10, 25, 50, 100]

  const rows = [[{ text: '🔄 Refresh', callback_data: 'buy:r' }]];
  if (recentRow.length > 0) rows.push(recentRow);
  rows.push([{ text: '🔄 Switch to Buy Menu', callback_data: 'buy:toggle' }]);

  if (availableWallets.length > 0) {
    // Sell Initials + Sell X ETH
    rows.push([
      { text: '💰 Sell Initials', callback_data: 'sellt:init' },
      { text: `💰 Sell X${nativeSymbol}`, callback_data: 'sellt:xeth' },
    ]);
    // % buttons — 4 per row: 10 | 50 | 100 | X%
    const pctBtns = [];
    [10, 50, 100].forEach(p => {
      if (sellPresets.includes(p)) pctBtns.push({ text: `💰 ${p}%`, callback_data: `sellt:p:${p}` });
    });
    pctBtns.push({ text: '💰 X%', callback_data: 'sellt:c' });
    rows.push(pctBtns);
    // Wallet selector: 2 per row
    for (let i = 0; i < walletBtns.length; i += 2) rows.push(walletBtns.slice(i, i + 2));
    // Sell All Wallets + PnL Card
    rows.push([
      { text: '💰 Sell All Wallets', callback_data: 'sellt:all' },
      { text: '🖼 PnL Card', callback_data: 'sellt:pnlcard' },
    ]);
  }
  rows.push([
    { text: `🔥 ${gasGweiValue} GWEI`, callback_data: 'settings:gasbtns' },
    { text: `Slip ${prefs.slippageBps / 100}%`, callback_data: 'settings:slippage' },
  ]);
  rows.push([
    { text: '📈 Limit Order', callback_data: 'sellt:limit' },
    { text: '❌ Close', callback_data: 'nav:close' },
  ]);
  return rows;
}

async function _handleBuyCallback(query, data, userId) {
  const parts = data.split(':');
  const action = parts[1];
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const prefs = _getUserPrefs(userId);
  const ctx = prefs.buyContext;

  if (action === 'prompt') {
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '💎 Paste a contract address (0x...)');
  }

  // openfromidx doesn't need buyContext — uses positionsContext
  if (action === 'openfromidx') {
    const idx = parseInt(parts[2], 10);
    const pos = prefs.positionsContext?.[idx];
    if (!pos) return bot.answerCallbackQuery(query.id, { text: 'Refais /positions' });
    await bot.answerCallbackQuery(query.id);
    return _showBuyInterface(chatId, userId, pos.tokenAddress);
  }

  if (!ctx) {
    await bot.answerCallbackQuery(query.id, { text: 'Session expirée' });
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  if (action === 'r') {
    await bot.answerCallbackQuery(query.id, { text: '🔄' });
    return _showBuyInterface(chatId, userId, ctx.tokenAddress, ctx.mode, msgId);
  }
  if (action === 'toggle') {
    // Use the stored mode to toggle properly (not inferred from positions)
    const currentMode = ctx.mode || 'buy';
    const newMode = currentMode === 'buy' ? 'sell' : 'buy';
    await bot.answerCallbackQuery(query.id, { text: `→ ${newMode.toUpperCase()}` });
    return _showBuyInterface(chatId, userId, ctx.tokenAddress, newMode, msgId);
  }
  if (action === 'opensell') {
    await bot.answerCallbackQuery(query.id);
    return _showBuyInterface(chatId, userId, ctx.tokenAddress, 'sell', msgId);
  }
  if (action === 'openbuy') {
    await bot.answerCallbackQuery(query.id);
    return _showBuyInterface(chatId, userId, ctx.tokenAddress, 'buy', msgId);
  }
  if (action === 'openfromidx') {
    const idx = parseInt(parts[2], 10);
    const pos = prefs.positionsContext?.[idx];
    if (!pos) return bot.answerCallbackQuery(query.id, { text: 'Refais /positions' });
    await bot.answerCallbackQuery(query.id);
    return _showBuyInterface(chatId, userId, pos.tokenAddress);
  }

  if (action === 'rt') {
    const idx = parseInt(parts[2], 10);
    const t = prefs.recentTokens?.[idx];
    if (!t) return bot.answerCallbackQuery(query.id);
    await bot.answerCallbackQuery(query.id, { text: `→ ${t.symbol}` });
    return _showBuyInterface(chatId, userId, t.address, null, msgId);
  }

  if (action === 'limit') {
    await bot.answerCallbackQuery(query.id, { text: 'Limit orders — bientôt disponible' });
    return;
  }
  if (action === 'w' || action === 'tog') {
    // Toggle wallet selection without reloading the whole message
    const idx = parseInt(parts[2], 10);
    const wallets = wallet.listWallets(userId);
    const w = wallets[idx];
    if (!w) return bot.answerCallbackQuery(query.id, { text: 'Wallet introuvable' });

    if (!ctx.selectedWalletIds) ctx.selectedWalletIds = new Set();
    const wasSelected = ctx.selectedWalletIds.has(w.id);
    if (wasSelected) {
      ctx.selectedWalletIds.delete(w.id);
    } else {
      ctx.selectedWalletIds.add(w.id);
    }
    await bot.answerCallbackQuery(query.id, { text: `${w.label}: ${wasSelected ? 'unselected' : 'selected'}` });

    // Reconstruct availableWallets + userPositions to rebuild keyboard
    const userPos = positions.getPositions(userId).filter(p =>
      p.chain === ctx.chain && p.tokenAddress.toLowerCase() === ctx.tokenAddress.toLowerCase()
    );
    const availableWallets = ctx.mode === 'sell'
      ? wallets.filter(ww => userPos.some(p => p.walletId === ww.id))
      : wallets.slice(0, 4);

    const newKeyboard = { inline_keyboard: _buildTokenKeyboard(userId, ctx.mode, availableWallets, userPos) };
    await bot.editMessageReplyMarkup(newKeyboard, { chat_id: chatId, message_id: msgId }).catch(() => {});
    return;
  }
  if (action === 'p') {
    const idx = parseInt(parts[2], 10);
    const amount = prefs.buyPresets[ctx.chain][idx];
    if (!amount) return bot.answerCallbackQuery(query.id, { text: 'Invalid' });
    const selected = Array.from(ctx.selectedWalletIds || []);
    if (selected.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucun wallet sélectionné' });
    await bot.answerCallbackQuery(query.id, { text: `Buying ${amount} on ${selected.length} wallet(s)...` });
    for (const wid of selected) {
      await _executeBuy(chatId, userId, wid, ctx.chain, ctx.tokenAddress, amount);
    }
    return;
  }
  if (action === 'c') {
    const selected = Array.from(ctx.selectedWalletIds || []);
    if (selected.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucun wallet sélectionné' });
    _state.set(userId, { step: 'buy_custom_amount', data: { chain: ctx.chain, tokenAddr: ctx.tokenAddress, walletIds: selected } });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, `💵 Montant en ${_chainSymbol(ctx.chain)} par wallet (${selected.length} sélectionné${selected.length > 1 ? 's' : ''}) ? (ex: 0.15)`);
  }
}

async function _executeBuy(chatId, userId, walletId, chain, tokenAddr, amountNative) {
  const nativeSymbol = _chainSymbol(chain);
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Buy in progress*\n\n` +
    `Token: \`${_shortAddr(tokenAddr)}\`\n` +
    `Chain: ${_chainName(chain)}\n` +
    `Amount: ${amountNative} ${nativeSymbol}`,
    { parse_mode: 'Markdown' }
  );

  try {
    const provider = trading.getProvider(chain);
    const signer = wallet.getSigner(userId, walletId, provider);
    const w = wallet.getWalletById(userId, walletId);
    const prefs = _getUserPrefs(userId);

    const balance = await trading.getNativeBalance(chain, w.address);
    if (balance < ethers.parseEther(amountNative.toString())) {
      return bot.editMessageText(
        `❌ Solde insuffisant\n\nWallet: ${_fmtEth(balance)} ${nativeSymbol}, besoin ${amountNative}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      );
    }

    const result = await trading.buy(chain, tokenAddr, amountNative, prefs.slippageBps, signer);
    const [info, dexInfo, nativePrice] = await Promise.all([
      trading.getTokenInfo(chain, tokenAddr, w.address),
      price.getTokenPrice(chain, tokenAddr).catch(() => null),
      price.getNativePrice(chain),
    ]);
    // Prefer DexScreener symbol (cleaner than contract's, handles weird tokens)
    const symbol = (dexInfo?.symbol && dexInfo.symbol !== 'UNKNOWN') ? dexInfo.symbol : info.symbol;
    info.symbol = symbol;
    positions.recordBuy({
      userId, walletId, walletAddr: w.address, chain,
      tokenAddress: tokenAddr,
      symbol,
      decimals: info.decimals,
      amountEth: ethers.parseEther(amountNative.toString()),
      amountTokens: result.amountOutExpected,
      ethPriceUsd: nativePrice,
      txHash: result.txHash,
    });

    const explorer = _config.chains[chain].explorer;
    const tokensReceived = Number(ethers.formatUnits(result.amountOutExpected, info.decimals));
    const usdSpent = amountNative * nativePrice;
    const entryPrice = tokensReceived > 0 ? usdSpent / tokensReceived : 0;

    // Refresh updated position aggregates
    const allPos = positions.getPositions(userId).filter(p =>
      p.chain === chain && p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase()
    );
    let totalQty = 0, totalCost = 0;
    allPos.forEach(p => { totalQty += p.amountTokens; totalCost += p.totalCostUsd; });
    const avgEntry = totalQty > 0 ? totalCost / totalQty : entryPrice;

    // Brief confirmation + transition to full token view (Sigma-style)
    const confirmText =
      `✅ *Bought ${tokensReceived.toFixed(4)} ${info.symbol}* for ${amountNative} ${nativeSymbol}\n` +
      `[View tx](${explorer}/tx/${result.txHash})`;
    await bot.editMessageText(confirmText, {
      chat_id: chatId, message_id: loadingMsg.message_id,
      parse_mode: 'Markdown', disable_web_page_preview: true,
    });

    // Reset context so new selected wallets aren't stale
    prefs.buyContext = null;

    // Wait briefly for on-chain state propagation before showing sell menu
    await new Promise(r => setTimeout(r, 1500));

    // Show the full Sigma-style token view in SELL mode
    await _showBuyInterface(chatId, userId, tokenAddr, 'sell');
  } catch (err) {
    console.error('Buy error:', err.message);
    await bot.editMessageText(
      `❌ Buy failed\n\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    );
  }
}

// ════════════════════════════════════════════════════════════
// POSITIONS with auto-refresh
// ════════════════════════════════════════════════════════════

async function _sendPositions(chatId, userId) {
  const pos = positions.getPositions(userId);
  if (pos.length === 0) {
    return bot.sendMessage(chatId, '📊 Aucune position ouverte.\n_Colle un CA pour acheter._', { parse_mode: 'Markdown' });
  }

  const prefs = _getUserPrefs(userId);
  prefs.positionsContext = pos.map(p => ({ chain: p.chain, tokenAddress: p.tokenAddress, walletId: p.walletId }));

  const msg = await bot.sendMessage(chatId, await _renderPositions(userId), {
    parse_mode: 'Markdown',
    reply_markup: _buildPositionsKeyboard(userId),
  });

  // Auto-refresh every 10s for 5 minutes
  let ticks = 0;
  const intervalId = setInterval(async () => {
    ticks++;
    if (ticks > 30) { clearInterval(intervalId); _positionRefreshers.delete(msg.message_id); return; }
    try {
      await bot.editMessageText(await _renderPositions(userId), {
        chat_id: chatId, message_id: msg.message_id,
        parse_mode: 'Markdown', reply_markup: _buildPositionsKeyboard(userId),
      }).catch(() => {});
    } catch (_) {}
  }, 10000);
  _positionRefreshers.set(msg.message_id, intervalId);
}

async function _renderPositions(userId) {
  const pos = positions.getPositions(userId);
  if (pos.length === 0) return '📊 *Open Positions*\n\n_Aucune position. Colle une CA pour acheter._';

  // Fetch prices + native prices per chain + aggregate DexScreener info
  const byChain = {};
  pos.forEach(p => { if (!byChain[p.chain]) byChain[p.chain] = []; byChain[p.chain].push(p.tokenAddress); });
  const pricesByChain = {};
  const nativePrices = {};
  for (const [ch, addrs] of Object.entries(byChain)) {
    pricesByChain[ch] = await price.getTokenPrices(ch, addrs);
    nativePrices[ch] = await price.getNativePrice(ch).catch(() => 0);
  }

  // Auto-heal: if symbol is UNKNOWN, try to get it from DexScreener
  for (const p of pos) {
    if (p.symbol === 'UNKNOWN') {
      const ds = pricesByChain[p.chain]?.[p.tokenAddress.toLowerCase()];
      if (ds?.symbol && ds.symbol !== 'UNKNOWN') {
        p.symbol = ds.symbol;
        // Persist the fix
        positions.updatePositionSymbol?.(userId, p.walletId, p.chain, p.tokenAddress, ds.symbol);
      }
    }
  }

  let text = `📊 *Open Positions* (${pos.length}) · _${new Date().toLocaleTimeString('fr-FR')}_\n\n`;
  let totalPnl = 0, totalValue = 0, totalCost = 0;
  const wallets = wallet.listWallets(userId);

  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    const current = pricesByChain[p.chain]?.[p.tokenAddress.toLowerCase()]?.priceUsd || 0;
    const nativePrice = nativePrices[p.chain] || 0;
    const value = p.amountTokens * current;
    const pnl = value - p.totalCostUsd;
    const pnlPct = p.totalCostUsd > 0 ? (pnl / p.totalCostUsd) * 100 : 0;
    const emoji = pnl >= 0 ? '🟩' : '🟥';
    const sign = pnl >= 0 ? '+' : '';
    totalPnl += pnl; totalValue += value; totalCost += p.totalCostUsd;

    const worthNative = nativePrice > 0 ? value / nativePrice : 0;
    const costNative = nativePrice > 0 ? p.totalCostUsd / nativePrice : 0;
    const bagStr = _fmtTokenAmount(p.amountTokens);

    // Find wallet index
    const wIdx = wallets.findIndex(w => w.id === p.walletId);
    const wLabel = wIdx >= 0 ? `W${wIdx + 1}` : '?';

    text += `${emoji} [${i + 1}] *${p.symbol}* (${_chainIcon(p.chain)} · ${wLabel})\n`;
    text += `Profit: *${sign}${pnlPct.toFixed(2)}%* (${sign}${_fmtUsd(pnl)})\n`;
    text += `Worth: ${worthNative.toFixed(4)}Ξ · Cost: ${costNative.toFixed(4)}Ξ · Bag: ${bagStr}\n`;
    text += `Entry: $${p.avgEntryUsd.toFixed(8)} → Now: $${current.toFixed(8)}\n\n`;
  }

  text += `━━━━━━━━━━━━━━━\n`;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const totalEmoji = totalPnl >= 0 ? '🟩' : '🟥';
  const totalSign = totalPnl >= 0 ? '+' : '';
  text += `${totalEmoji} *Total:* ${_fmtUsd(totalValue)}\n`;
  text += `*PnL:* ${totalSign}${_fmtUsd(totalPnl)} (${totalSign}${totalPnlPct.toFixed(2)}%)`;
  return text;
}

function _buildPositionsKeyboard(userId) {
  const prefs = _getUserPrefs(userId);
  const pos = positions.getPositions(userId);
  const sellPresets = prefs.sellPresets;

  // One row per position: clickable label (opens unified view) + sell % buttons
  const rows = [];
  pos.slice(0, 8).forEach((p, i) => {
    rows.push([{
      text: `📊 ${p.symbol} → Trade`,
      callback_data: `buy:openfromidx:${i}`,
    }]);
    rows.push(sellPresets.map(pct => ({
      text: pct === 100 ? '💥 MAX' : `Sell ${pct}%`,
      callback_data: `sell:${i}:${pct}`,
    })).slice(0, 4));
  });

  return {
    inline_keyboard: [
      ...rows,
      [{ text: '⬅️ Main', callback_data: 'nav:main' }],
    ],
  };
}

async function _handleSellCallback(query, data, userId) {
  const parts = data.split(':');
  const idx = parseInt(parts[1], 10);
  const pct = parseInt(parts[2], 10);
  const chatId = query.message.chat.id;
  const prefs = _getUserPrefs(userId);
  const pos = prefs.positionsContext?.[idx];
  if (!pos || !pct) return bot.answerCallbackQuery(query.id, { text: 'Introuvable, refais /positions' });
  await bot.answerCallbackQuery(query.id, { text: `Selling ${pct}%...` });
  return _executeSell(chatId, userId, pos.walletId, pos.chain, pos.tokenAddress, pct);
}

/**
 * Sell from the token view (unified menu) — uses buyContext
 */
async function _handleSellTokenCallback(query, data, userId) {
  const parts = data.split(':');
  const action = parts[1];
  const chatId = query.message.chat.id;
  const prefs = _getUserPrefs(userId);
  const ctx = prefs.buyContext;
  if (!ctx) return bot.answerCallbackQuery(query.id, { text: 'Session expirée' });

  // Find the position (use first matching wallet — may aggregate later)
  const userPos = positions.getPositions(userId).filter(p =>
    p.chain === ctx.chain && p.tokenAddress.toLowerCase() === ctx.tokenAddress.toLowerCase()
  );
  if (userPos.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Pas de position' });

  // Use the first wallet holding the token
  const pos = userPos[0];

  if (action === 'p') {
    const pct = parseInt(parts[2], 10);
    if (!pct) return bot.answerCallbackQuery(query.id);
    // Get selected wallets that have this token
    const selected = Array.from(ctx.selectedWalletIds || []);
    const walletsToSell = userPos.filter(p => selected.includes(p.walletId));
    if (walletsToSell.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucun wallet sélectionné avec ce token' });
    await bot.answerCallbackQuery(query.id, { text: `Selling ${pct}% on ${walletsToSell.length} wallet(s)...` });
    for (const p of walletsToSell) {
      await _executeSell(chatId, userId, p.walletId, p.chain, p.tokenAddress, pct);
    }
    return;
  }
  if (action === 'c') {
    const selected = Array.from(ctx.selectedWalletIds || []);
    const walletsToSell = userPos.filter(p => selected.includes(p.walletId));
    if (walletsToSell.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucun wallet sélectionné' });
    _state.set(userId, {
      step: 'sell_custom_pct',
      data: { chain: ctx.chain, tokenAddr: ctx.tokenAddress, walletIds: walletsToSell.map(p => p.walletId) },
    });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, `💸 Pourcentage à vendre (${walletsToSell.length} wallet${walletsToSell.length > 1 ? 's' : ''}) ? (ex: 33)`);
  }

  if (action === 'init') {
    // Sell Initials — sell enough to recover initial cost (in ETH)
    const selected = Array.from(ctx.selectedWalletIds || []);
    if (selected.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucun wallet sélectionné' });
    await bot.answerCallbackQuery(query.id, { text: 'Sell Initials...' });
    const nativePrice = await price.getNativePrice(ctx.chain).catch(() => 0);
    const tokenPrice = (await price.getTokenPrice(ctx.chain, ctx.tokenAddress))?.priceUsd || 0;
    for (const walletId of selected) {
      const p = userPos.find(x => x.walletId === walletId);
      if (!p || tokenPrice === 0) continue;
      // tokensToSell = (totalCostUsd) / tokenPrice  → pct = tokensToSell / amountTokens × 100
      const tokensToSell = p.totalCostUsd / tokenPrice;
      const pct = Math.min(100, Math.round((tokensToSell / p.amountTokens) * 100));
      if (pct <= 0) continue;
      await _executeSell(chatId, userId, walletId, ctx.chain, ctx.tokenAddress, pct);
    }
    return;
  }

  if (action === 'xeth') {
    // Sell X ETH — sell enough tokens to receive X native
    const selected = Array.from(ctx.selectedWalletIds || []);
    if (selected.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucun wallet sélectionné' });
    _state.set(userId, {
      step: 'sell_xeth',
      data: { chain: ctx.chain, tokenAddr: ctx.tokenAddress, walletIds: selected },
    });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, `💰 Montant à récupérer en ${_chainSymbol(ctx.chain)} ? (ex: 0.05)`);
  }

  if (action === 'all') {
    // Sell All Wallets — sell 100% from all wallets holding the token
    const walletsToSell = userPos;
    if (walletsToSell.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Aucune position' });
    await bot.answerCallbackQuery(query.id, { text: `Selling 100% on ${walletsToSell.length} wallet(s)...` });
    for (const p of walletsToSell) {
      await _executeSell(chatId, userId, p.walletId, p.chain, p.tokenAddress, 100);
    }
    return;
  }

  if (action === 'pnlcard') {
    await bot.answerCallbackQuery(query.id, { text: 'PnL Card — bientôt disponible' });
    return;
  }

  if (action === 'limit') {
    await bot.answerCallbackQuery(query.id, { text: 'Limit orders — bientôt disponible' });
    return;
  }
}

async function _executeSell(chatId, userId, walletId, chain, tokenAddr, pct) {
  const nativeSymbol = _chainSymbol(chain);
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Sell in progress*\nAmount: ${pct}%\nChain: ${_chainName(chain)}`,
    { parse_mode: 'Markdown' }
  );
  try {
    const provider = trading.getProvider(chain);
    const signer = wallet.getSigner(userId, walletId, provider);
    const w = wallet.getWalletById(userId, walletId);
    const prefs = _getUserPrefs(userId);

    const [info, dexInfo] = await Promise.all([
      trading.getTokenInfo(chain, tokenAddr, w.address),
      price.getTokenPrice(chain, tokenAddr).catch(() => null),
    ]);
    if (dexInfo?.symbol && dexInfo.symbol !== 'UNKNOWN') info.symbol = dexInfo.symbol;

    // Retry balance with alternate RPCs if first returns 0
    let sellableBalance = info.balance;
    const balanceAbi = ['function balanceOf(address) view returns (uint256)'];
    if (sellableBalance === 0n) {
      const altRpcs = {
        base: ['https://base.llamarpc.com', 'https://mainnet.base.org', 'https://base.publicnode.com'],
        ethereum: ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com'],
        bsc: ['https://binance.llamarpc.com', 'https://bsc.publicnode.com'],
      };
      for (const rpcUrl of (altRpcs[chain] || [])) {
        try {
          const altProvider = new ethers.JsonRpcProvider(rpcUrl);
          const token = new ethers.Contract(tokenAddr, balanceAbi, altProvider);
          const bal = await token.balanceOf(w.address);
          if (bal > 0n) { sellableBalance = bal; console.log(`ℹ️  Balance retrieved via ${rpcUrl}: ${bal.toString()}`); break; }
        } catch (_) {}
      }
    }

    if (sellableBalance === 0n) {
      // Token balance is actually 0 on-chain. Position is stale — remove it to prevent confusion.
      const stored = positions.getPositions(userId).find(p =>
        p.walletId === walletId && p.chain === chain &&
        p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase()
      );
      const storedStr = stored ? ` (position stockée: ${stored.amountTokens.toFixed(4)} ${info.symbol})` : '';
      console.log(`⚠️  Balance on-chain = 0 pour ${info.symbol} sur ${w.address}${storedStr}`);
      return bot.editMessageText(
        `❌ *Pas de balance ${info.symbol} sur ${w.label}*\n\n` +
        `Ta position stockée indique \`${stored?.amountTokens.toFixed(4) || '?'}\` ${info.symbol} mais on-chain il n'y en a pas.\n\n` +
        `Les tokens ont peut-être été transférés hors de ce wallet. Vérifie sur [BaseScan](${_config.chains[chain].explorer}/address/${w.address}).`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }
    const amountIn = sellableBalance * BigInt(pct) / 100n;
    const result = await trading.sell(chain, tokenAddr, amountIn, prefs.slippageBps, signer);

    const nativePrice = await price.getNativePrice(chain);
    const { realizedPnl } = positions.recordSell({
      userId, walletId, walletAddr: w.address, chain,
      tokenAddress: tokenAddr, symbol: info.symbol, decimals: info.decimals,
      amountTokens: amountIn, amountEthReceived: result.amountOutExpected,
      ethPriceUsd: nativePrice, txHash: result.txHash,
    });

    const nativeOut = _fmtEth(result.amountOutExpected);
    const usdOut = parseFloat(nativeOut) * nativePrice;
    const explorer = _config.chains[chain].explorer;
    const pnlEmoji = realizedPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = realizedPnl >= 0 ? '+' : '';

    // Remaining position
    const remaining = positions.getPositions(userId).filter(p =>
      p.chain === chain && p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase()
    );
    const hasRemaining = remaining.length > 0;

    prefs.buyContext = { chain, tokenAddress: tokenAddr };

    const successText =
      `${pnlEmoji} *Sell successful* (${pct}%)\n\n` +
      `💎 *${info.symbol}* via ${result.dex}\n` +
      `📦 Sold: \`${Number(ethers.formatUnits(amountIn, info.decimals)).toFixed(4)} ${info.symbol}\`\n` +
      `💰 Received: \`${nativeOut} ${nativeSymbol}\` _(${_fmtUsd(usdOut)})_\n` +
      `📈 Realized PnL: *${pnlSign}${_fmtUsd(realizedPnl)}*`;

    await bot.editMessageText(successText, {
      chat_id: chatId, message_id: loadingMsg.message_id,
      parse_mode: 'Markdown', disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🔎 View tx', url: `${explorer}/tx/${result.txHash}` }]],
      },
    });

    // Auto-switch token view: Sell menu if remaining, Buy menu if fully closed
    await _showBuyInterface(chatId, userId, tokenAddr, hasRemaining ? 'sell' : 'buy');
  } catch (err) {
    console.error('Sell error:', err.message);
    await bot.editMessageText(`❌ Sell failed\n\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  }
}

// ════════════════════════════════════════════════════════════
// SETTINGS (Sigma-style tree)
// ════════════════════════════════════════════════════════════

async function _sendSettingsMenu(chatId, userId, editMsgId = null) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;

  const text =
    `⚙️ *Settings* (${_chainIcon(chain)} ${_chainName(chain)})\n\n` +
    `_Select an option below to configure:_`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💡 Default Trading Values', callback_data: 'settings:trading' }],
      [{ text: '❓ Trade Confirmation', callback_data: 'settings:confirm' }],
      [
        { text: '⚡ Buy Buttons', callback_data: 'settings:buybtns' },
        { text: '⚡ Sell Buttons %', callback_data: 'settings:sellbtns' },
      ],
      [{ text: '⛽ Gas Buttons', callback_data: 'settings:gasbtns' }],
      [{ text: '🌐 Switch Chain', callback_data: 'nav:chains' }],
      [{ text: '⬅️ Main', callback_data: 'nav:main' }],
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

async function _handleSettingsCallback(query, data, userId) {
  const [, section, ...rest] = data.split(':');
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const prefs = _getUserPrefs(userId);

  if (section === 'trading') {
    await bot.answerCallbackQuery(query.id);
    const text =
      `💡 *Default Trading Values*\n\n` +
      `📊 Slippage: *${prefs.slippageBps / 100}%*\n` +
      `⏱ Deadline: ${_config.trading.defaultDeadlineSec}s\n` +
      `⛽ Gas buffer: x${_config.trading.defaultGasBufferMultiplier}`;
    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Slippage', callback_data: 'settings:slippage' }],
          [{ text: '⬅️ Back', callback_data: 'nav:settings' }],
        ],
      },
    });
  }

  if (section === 'slippage') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'settings_slippage' });
    return bot.sendMessage(chatId, '📊 Slippage en % ? (ex: 1 pour 1%, max 30)');
  }

  if (section === 'confirm') {
    prefs.tradeConfirmation = !prefs.tradeConfirmation;
    await bot.answerCallbackQuery(query.id, { text: `Trade confirm: ${prefs.tradeConfirmation ? 'ON' : 'OFF'}` });
    return _sendSettingsMenu(chatId, userId, msgId);
  }

  if (section === 'buybtns') {
    await bot.answerCallbackQuery(query.id);
    return _sendBuyButtonsMenu(chatId, userId, msgId);
  }
  if (section === 'buybtnchain') {
    const ch = rest[0];
    await bot.answerCallbackQuery(query.id);
    return _sendBuyButtonsChain(chatId, userId, ch, msgId);
  }
  if (section === 'buybtnremove') {
    const [ch, idxStr] = rest;
    const idx = parseInt(idxStr, 10);
    prefs.buyPresets[ch].splice(idx, 1);
    await bot.answerCallbackQuery(query.id, { text: 'Removed' });
    return _sendBuyButtonsChain(chatId, userId, ch, msgId);
  }
  if (section === 'buybtnadd') {
    const ch = rest[0];
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'settings_buybtn_add', data: { chain: ch } });
    return bot.sendMessage(chatId, `💰 Nouveau montant preset pour ${_chainName(ch)} (ex: 0.3) ?`);
  }
  if (section === 'buybtncopy') {
    const ch = rest[0];
    _config.chainKeys.forEach(otherCh => {
      if (otherCh !== ch) prefs.buyPresets[otherCh] = [...prefs.buyPresets[ch]];
    });
    await bot.answerCallbackQuery(query.id, { text: 'Copied to all chains' });
    return _sendBuyButtonsChain(chatId, userId, ch, msgId);
  }

  if (section === 'sellbtns') {
    await bot.answerCallbackQuery(query.id);
    return _sendSellButtonsMenu(chatId, userId, msgId);
  }
  if (section === 'sellbtnremove') {
    const idx = parseInt(rest[0], 10);
    prefs.sellPresets.splice(idx, 1);
    await bot.answerCallbackQuery(query.id, { text: 'Removed' });
    return _sendSellButtonsMenu(chatId, userId, msgId);
  }
  if (section === 'sellbtnadd') {
    await bot.answerCallbackQuery(query.id);
    _state.set(userId, { step: 'settings_sellbtn_add' });
    return bot.sendMessage(chatId, '💸 Nouveau % de vente (ex: 33) ?');
  }

  if (section === 'gasbtns') {
    await bot.answerCallbackQuery(query.id);
    return _sendGasButtonsMenu(chatId, userId, msgId);
  }
  if (section === 'gasset') {
    const idx = parseInt(rest[0], 10);
    prefs.gasPresetIdx = idx;
    await bot.answerCallbackQuery(query.id, { text: ['🐢 Slow', '⚡ Normal', '🚀 Fast'][idx] });
    return _sendGasButtonsMenu(chatId, userId, msgId);
  }

  await bot.answerCallbackQuery(query.id);
}

async function _sendBuyButtonsMenu(chatId, userId, editMsgId) {
  const text = `⚡ *Buy Buttons*\n\n_Select a chain to configure:_`;
  const keyboard = {
    inline_keyboard: [
      ..._config.chainKeys.map(ch => [{ text: `${_chainIcon(ch)} ${_chainName(ch)}`, callback_data: `settings:buybtnchain:${ch}` }]),
      [{ text: '⬅️ Back', callback_data: 'nav:settings' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _sendBuyButtonsChain(chatId, userId, chain, editMsgId) {
  const prefs = _getUserPrefs(userId);
  const presets = prefs.buyPresets[chain] || [];
  const nativeSymbol = _chainSymbol(chain);
  const nativePrice = await price.getNativePrice(chain).catch(() => 0);

  let text = `⚡ *Buy Buttons — ${_chainIcon(chain)} ${_chainName(chain)}*\n\n_Click to remove, or add new:_\n\n`;
  presets.forEach((amt, i) => {
    const usd = amt * nativePrice;
    text += `  ${i + 1}. ${amt} ${nativeSymbol}  _(${_fmtUsd(usd)})_\n`;
  });

  const presetRows = [];
  for (let i = 0; i < presets.length; i += 3) {
    presetRows.push(presets.slice(i, i + 3).map((amt, j) => ({
      text: `💰 ${amt} ${nativeSymbol}`,
      callback_data: `settings:buybtnremove:${chain}:${i + j}`,
    })));
  }

  const keyboard = {
    inline_keyboard: [
      ...presetRows,
      [
        { text: '📋 Copy to All Chains', callback_data: `settings:buybtncopy:${chain}` },
        { text: '➕ Add New', callback_data: `settings:buybtnadd:${chain}` },
      ],
      [{ text: '⬅️ Back', callback_data: 'settings:buybtns' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _sendSellButtonsMenu(chatId, userId, editMsgId) {
  const prefs = _getUserPrefs(userId);
  let text = `⚡ *Sell Buttons %*\n\n_Click to remove, or add new:_\n\n`;
  prefs.sellPresets.forEach((p, i) => { text += `  ${i + 1}. ${p}%\n`; });

  const presetRows = [];
  for (let i = 0; i < prefs.sellPresets.length; i += 4) {
    presetRows.push(prefs.sellPresets.slice(i, i + 4).map((p, j) => ({
      text: `${p}%`,
      callback_data: `settings:sellbtnremove:${i + j}`,
    })));
  }

  const keyboard = {
    inline_keyboard: [
      ...presetRows,
      [{ text: '➕ Add New', callback_data: 'settings:sellbtnadd' }],
      [{ text: '⬅️ Back', callback_data: 'nav:settings' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _sendGasButtonsMenu(chatId, userId, editMsgId) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  const presets = prefs.gasPresets[chain];
  const nativeSymbol = _chainSymbol(chain);
  const nativePrice = await price.getNativePrice(chain).catch(() => 0);
  const labels = ['🐢 Slow', '⚡ Normal', '🚀 Fast'];

  // Typical gas cost for a swap ~ 200k gas units
  const typicalGasUnits = 200000;
  let text = `⛽ *Gas Preset — ${_chainIcon(chain)} ${_chainName(chain)}*\n\n`;
  presets.forEach((gwei, i) => {
    const costEth = (gwei * typicalGasUnits) / 1e9;
    const costUsd = costEth * nativePrice;
    const active = i === prefs.gasPresetIdx ? '🟢 ' : '  ';
    text += `${active}${labels[i]}: *${gwei} gwei*  _(~${_fmtUsd(costUsd)})_\n`;
  });

  const keyboard = {
    inline_keyboard: [
      [
        { text: `${prefs.gasPresetIdx === 0 ? '🟢' : '⚪'} Slow`,   callback_data: 'settings:gasset:0' },
        { text: `${prefs.gasPresetIdx === 1 ? '🟢' : '⚪'} Normal`, callback_data: 'settings:gasset:1' },
        { text: `${prefs.gasPresetIdx === 2 ? '🟢' : '⚪'} Fast`,   callback_data: 'settings:gasset:2' },
      ],
      [{ text: '⬅️ Back', callback_data: 'nav:settings' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

// ════════════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════════════

async function _sendStats(chatId, userId) {
  const s = positions.getStats(userId);
  const wr = s.sells > 0 ? (s.winRate).toFixed(1) : '0';
  return bot.sendMessage(chatId,
    `📊 *Stats*\n\n` +
    `Trades: ${s.totalTrades} (${s.buys} buys · ${s.sells} sells)\n` +
    `Win rate: ${wr}%\n` +
    `Wins: ${s.wins} | Losses: ${s.losses}\n` +
    `Realized PnL: *${s.realizedPnl >= 0 ? '+' : ''}${_fmtUsd(s.realizedPnl)}*\n` +
    `Open positions: ${s.openPositions}`,
    { parse_mode: 'Markdown' }
  );
}

// ════════════════════════════════════════════════════════════
// STATEFUL INPUT
// ════════════════════════════════════════════════════════════

async function _handleStatefulInput(msg, state) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (state.step === 'wallet_create_label') {
    const label = text.slice(0, 40);
    const w = wallet.generateWallet(userId, label);
    _state.delete(userId);
    const keyMsg = await bot.sendMessage(chatId,
      `✅ *Wallet created*\n\n` +
      `Label: *${w.label}*\n` +
      `Address: \`${w.address}\`\n\n` +
      `🔐 *Private Key* :\n\`${w.privateKey}\`\n\n` +
      `⚠️ Sauvegarde cette clé MAINTENANT. Elle ne sera plus affichée automatiquement.\n` +
      `_Auto-suppression dans 2min, ou clique le bouton._`,
      { parse_mode: 'Markdown', reply_markup: {
        inline_keyboard: [[{ text: '🗑️ Delete now', callback_data: 'msg:delete' }]],
      }}
    );
    setTimeout(() => bot.deleteMessage(chatId, keyMsg.message_id).catch(() => {}), 120000);
    return _sendWalletsMenu(chatId, userId);
  }

  if (state.step === 'wallet_import_pk') {
    try {
      const imported = wallet.importWallet(userId, text, 'Imported');
      _state.delete(userId);
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      await bot.sendMessage(chatId,
        `✅ *Wallet imported*\n\nAddress: \`${imported.address}\``,
        { parse_mode: 'Markdown' }
      );
      return _sendWalletsMenu(chatId, userId);
    } catch (err) {
      _state.delete(userId);
      return bot.sendMessage(chatId, `❌ Import failed: ${err.message}`);
    }
  }

  if (state.step === 'wallet_rename_label') {
    wallet.renameWallet(userId, state.data.walletId, text);
    _state.delete(userId);
    await bot.sendMessage(chatId, `✅ Renamed.`);
    return _sendWalletsMenu(chatId, userId);
  }

  if (state.step === 'buy_custom_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '⚠️ Invalid');
    const { chain, tokenAddr, walletIds, walletId } = state.data;
    _state.delete(userId);
    const ids = walletIds || [walletId];
    for (const wid of ids) {
      await _executeBuy(chatId, userId, wid, chain, tokenAddr, amount);
    }
    return;
  }

  if (state.step === 'sell_custom_pct') {
    const pct = parseInt(text, 10);
    if (isNaN(pct) || pct <= 0 || pct > 100) return bot.sendMessage(chatId, '⚠️ Invalide (1-100)');
    const { chain, tokenAddr, walletIds, walletId } = state.data;
    _state.delete(userId);
    const ids = walletIds || [walletId];
    for (const wid of ids) {
      await _executeSell(chatId, userId, wid, chain, tokenAddr, pct);
    }
    return;
  }

  if (state.step === 'sell_xeth') {
    const amountEth = parseFloat(text);
    if (isNaN(amountEth) || amountEth <= 0) return bot.sendMessage(chatId, '⚠️ Montant invalide');
    const { chain, tokenAddr, walletIds } = state.data;
    _state.delete(userId);
    const nativePrice = await price.getNativePrice(chain).catch(() => 0);
    const tokenPrice = (await price.getTokenPrice(chain, tokenAddr))?.priceUsd || 0;
    if (tokenPrice === 0 || nativePrice === 0) {
      return bot.sendMessage(chatId, '⚠️ Impossible de déterminer le prix');
    }
    const targetUsd = amountEth * nativePrice;
    const positionsAll = positions.getPositions(userId);
    for (const wid of walletIds) {
      const pos = positionsAll.find(p => p.walletId === wid && p.chain === chain && p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase());
      if (!pos) continue;
      const tokensToSell = targetUsd / tokenPrice;
      const pct = Math.min(100, Math.round((tokensToSell / pos.amountTokens) * 100));
      if (pct <= 0) continue;
      await _executeSell(chatId, userId, wid, chain, tokenAddr, pct);
    }
    return;
  }

  if (state.step === 'settings_slippage') {
    const pct = parseFloat(text);
    if (isNaN(pct) || pct <= 0 || pct > 30) return bot.sendMessage(chatId, '⚠️ Invalide (0-30)');
    _getUserPrefs(userId).slippageBps = Math.round(pct * 100);
    _state.delete(userId);
    return bot.sendMessage(chatId, `✅ Slippage: ${pct}%`);
  }

  if (state.step === 'settings_buybtn_add') {
    const amt = parseFloat(text);
    if (isNaN(amt) || amt <= 0) return bot.sendMessage(chatId, '⚠️ Invalid');
    const ch = state.data.chain;
    _getUserPrefs(userId).buyPresets[ch].push(amt);
    _getUserPrefs(userId).buyPresets[ch].sort((a, b) => a - b);
    _state.delete(userId);
    return bot.sendMessage(chatId, `✅ Added ${amt} ${_chainSymbol(ch)}`);
  }

  if (state.step === 'settings_sellbtn_add') {
    const pct = parseInt(text, 10);
    if (isNaN(pct) || pct <= 0 || pct > 100) return bot.sendMessage(chatId, '⚠️ Invalid (1-100)');
    _getUserPrefs(userId).sellPresets.push(pct);
    _getUserPrefs(userId).sellPresets.sort((a, b) => a - b);
    _state.delete(userId);
    return bot.sendMessage(chatId, `✅ Added ${pct}%`);
  }

  // ── Transfers flow ──

  if (state.step === 'transfer_external_addr') {
    if (!transfers.isValidAddress(text)) {
      return bot.sendMessage(chatId, '⚠️ Adresse invalide. Colle une adresse EVM valide (0x...).');
    }
    const { mode, fromId } = state.data;
    _state.set(userId, { step: 'transfer_amount', data: { mode, fromId, toAddress: text } });
    const nativeSymbol = _chainSymbol(_getUserPrefs(userId).activeChain);
    if (mode === 'sendnative') {
      return bot.sendMessage(chatId, `💵 Montant en ${nativeSymbol} ? (ou "max" pour tout)`);
    } else {
      return bot.sendMessage(chatId, `🪙 Colle l'adresse du token ERC-20 à envoyer:`);
    }
  }

  if (state.step === 'transfer_amount') {
    const { mode, fromId, toAddress } = state.data;
    if (mode === 'sendnative') {
      const amt = text.toLowerCase() === 'max' ? 'max' : parseFloat(text);
      if (amt !== 'max' && (isNaN(amt) || amt <= 0)) return bot.sendMessage(chatId, '⚠️ Montant invalide.');
      _state.delete(userId);
      return _executeTransferNative(chatId, userId, fromId, toAddress, amt);
    } else {
      // Token mode — user just sent the token CA, now ask amount
      if (!/^0x[a-fA-F0-9]{40}$/.test(text)) {
        return bot.sendMessage(chatId, '⚠️ Adresse de token invalide (0x...).');
      }
      _state.set(userId, { step: 'transfer_token_amount', data: { mode, fromId, toAddress, tokenAddr: text } });
      return bot.sendMessage(chatId, '🔢 Montant de tokens ? (ou "max" pour tout le solde)');
    }
  }

  if (state.step === 'transfer_token_amount') {
    const { fromId, toAddress, tokenAddr } = state.data;
    const amt = text.toLowerCase() === 'max' ? 'max' : parseFloat(text);
    if (amt !== 'max' && (isNaN(amt) || amt <= 0)) return bot.sendMessage(chatId, '⚠️ Montant invalide.');
    _state.delete(userId);
    return _executeTransferToken(chatId, userId, fromId, tokenAddr, toAddress, amt);
  }

  if (state.step === 'transfer_dispatch_amount') {
    const { sourceId } = state.data;
    const amt = text.toLowerCase() === 'max' ? 'max' : parseFloat(text);
    if (amt !== 'max' && (isNaN(amt) || amt <= 0)) return bot.sendMessage(chatId, '⚠️ Montant invalide.');
    _state.delete(userId);
    return _executeDispatch(chatId, userId, sourceId, amt);
  }
}

// ════════════════════════════════════════════════════════════
// TRANSFERS MENU
// ════════════════════════════════════════════════════════════

async function _sendTransfersMenu(chatId, userId, editMsgId = null) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;

  const text =
    `🔁 *Transfers* (${_chainIcon(chain)} ${_chainName(chain)})\n\n` +
    `_Chaîne active : change via /chains si besoin._\n\n` +
    `Select an action:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `💸 Send ${_chainSymbol(chain)}`, callback_data: 'tr:sendnative' }],
      [{ text: '🪙 Send Token', callback_data: 'tr:sendtoken' }],
      [{ text: '🧲 Consolidate (all → one)', callback_data: 'tr:consolidate' }],
      [{ text: '🔀 Dispatch (one → all, equal)', callback_data: 'tr:dispatch' }],
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

async function _handleTransfersCallback(query, data, userId) {
  const [, action, ...rest] = data.split(':');
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;

  // Action: pick source wallet
  if (action === 'sendnative' || action === 'sendtoken') {
    await bot.answerCallbackQuery(query.id);
    return _pickWalletForTransfer(chatId, userId, action, msgId);
  }
  if (action === 'consolidate') {
    await bot.answerCallbackQuery(query.id);
    return _pickWalletForConsolidate(chatId, userId, msgId);
  }
  if (action === 'dispatch') {
    await bot.answerCallbackQuery(query.id);
    return _pickWalletForDispatch(chatId, userId, msgId);
  }

  const wallets = wallet.listWallets(userId);
  const modeMap = { sn: 'sendnative', st: 'sendtoken' };

  // tr:from:<modeKey>:<walletIdx>
  if (action === 'from') {
    const [modeKey, walletIdxStr] = rest;
    const mode = modeMap[modeKey] || modeKey;
    const walletIdx = parseInt(walletIdxStr, 10);
    const w = wallets[walletIdx];
    if (!w) return bot.answerCallbackQuery(query.id, { text: 'Wallet introuvable' });
    await bot.answerCallbackQuery(query.id);
    return _pickDestination(chatId, userId, mode, w.id, msgId);
  }

  // tr:to:<modeKey>:<fromIdx>:<toIdx|x>
  if (action === 'to') {
    const [modeKey, fromIdxStr, toSpec] = rest;
    const mode = modeMap[modeKey] || modeKey;
    const fromIdx = parseInt(fromIdxStr, 10);
    const from = wallets[fromIdx];
    if (!from) return bot.answerCallbackQuery(query.id, { text: 'Wallet introuvable' });
    await bot.answerCallbackQuery(query.id);

    if (toSpec === 'x') {
      _state.set(userId, { step: 'transfer_external_addr', data: { mode, fromId: from.id } });
      return bot.sendMessage(chatId, `📮 Colle l'adresse de destination (${_chainName(chain)}):`);
    }
    const toIdx = parseInt(toSpec, 10);
    const toW = wallets[toIdx];
    if (!toW) return bot.answerCallbackQuery(query.id, { text: 'Wallet introuvable' });
    _state.set(userId, { step: 'transfer_amount', data: { mode, fromId: from.id, toAddress: toW.address } });
    if (mode === 'sendnative') {
      return bot.sendMessage(chatId, `💵 Montant en ${_chainSymbol(chain)} ? (ou "max" pour tout)`);
    } else {
      return bot.sendMessage(chatId, `🪙 Colle l'adresse du token ERC-20 à envoyer:`);
    }
  }

  // tr:cons:<walletIdx>
  if (action === 'cons') {
    const idx = parseInt(rest[0], 10);
    const target = wallets[idx];
    if (!target) return bot.answerCallbackQuery(query.id, { text: 'Wallet introuvable' });
    await bot.answerCallbackQuery(query.id, { text: 'Consolidating...' });
    return _executeConsolidate(chatId, userId, target.id);
  }
  // tr:disp:<walletIdx>
  if (action === 'disp') {
    const idx = parseInt(rest[0], 10);
    const source = wallets[idx];
    if (!source) return bot.answerCallbackQuery(query.id, { text: 'Wallet introuvable' });
    _state.set(userId, { step: 'transfer_dispatch_amount', data: { sourceId: source.id } });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId,
      `🔀 *Dispatch*\nMontant en ${_chainSymbol(chain)} par wallet ?\n_(ou "max" pour split la balance équitablement)_`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function _pickWalletForTransfer(chatId, userId, mode, editMsgId) {
  const wallets = wallet.listWallets(userId);
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  if (wallets.length === 0) return bot.sendMessage(chatId, '⚠️ Aucun wallet.');

  const nativePrice = await price.getNativePrice(chain).catch(() => 0);
  const bals = await Promise.all(wallets.map(w => trading.getNativeBalance(chain, w.address).catch(() => 0n)));

  const text = `📤 *From which wallet ?*\n_${mode === 'sendnative' ? `Send ${_chainSymbol(chain)}` : 'Send Token'}_`;
  // Shortened mode key: sn=sendnative, st=sendtoken
  const modeKey = mode === 'sendnative' ? 'sn' : 'st';
  const keyboard = {
    inline_keyboard: [
      ...wallets.map((w, i) => {
        const bal = parseFloat(ethers.formatEther(bals[i]));
        const usd = bal * nativePrice;
        return [{
          text: `${w.label} — ${bal.toFixed(3)} ${_chainSymbol(chain)} (${_fmtUsd(usd)})`,
          callback_data: `tr:from:${modeKey}:${i}`,
        }];
      }),
      [{ text: '⬅️ Back', callback_data: 'nav:transfers' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _pickDestination(chatId, userId, mode, fromWalletId, editMsgId) {
  const wallets = wallet.listWallets(userId);
  const fromIdx = wallets.findIndex(w => w.id === fromWalletId);
  const from = wallets[fromIdx];
  if (!from) return;

  const text = `📥 *To where ?*\nFrom: *${from.label}*\n_Choose an internal wallet or send to external address_`;
  const modeKey = mode === 'sendnative' ? 'sn' : 'st';
  const keyboard = {
    inline_keyboard: [
      ...wallets.map((w, i) => {
        if (w.id === fromWalletId) return null;
        return [{
          text: `💼 ${w.label} (${_shortAddr(w.address)})`,
          callback_data: `tr:to:${modeKey}:${fromIdx}:${i}`,
        }];
      }).filter(Boolean),
      [{ text: '📮 External address', callback_data: `tr:to:${modeKey}:${fromIdx}:x` }],
      [{ text: '⬅️ Back', callback_data: 'nav:transfers' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _pickWalletForConsolidate(chatId, userId, editMsgId) {
  const wallets = wallet.listWallets(userId);
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  if (wallets.length < 2) return bot.sendMessage(chatId, '⚠️ Il faut au moins 2 wallets.');

  const text =
    `🧲 *Consolidate*\n\n` +
    `Envoie le ${_chainSymbol(chain)} de tous les autres wallets → wallet choisi.\n` +
    `_(skip les wallets < 0.0005 ${_chainSymbol(chain)})_\n\n` +
    `Target wallet ?`;
  const keyboard = {
    inline_keyboard: [
      ...wallets.map((w, i) => [{ text: `➡️ ${w.label} (${_shortAddr(w.address)})`, callback_data: `tr:cons:${i}` }]),
      [{ text: '⬅️ Back', callback_data: 'nav:transfers' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _pickWalletForDispatch(chatId, userId, editMsgId) {
  const wallets = wallet.listWallets(userId);
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  if (wallets.length < 2) return bot.sendMessage(chatId, '⚠️ Il faut au moins 2 wallets.');

  const nativePrice = await price.getNativePrice(chain).catch(() => 0);
  const bals = await Promise.all(wallets.map(w => trading.getNativeBalance(chain, w.address).catch(() => 0n)));

  const text =
    `🔀 *Dispatch*\n\nEnvoie le ${_chainSymbol(chain)} du wallet source équitablement → tous les autres wallets.\n\nSource wallet ?`;
  const keyboard = {
    inline_keyboard: [
      ...wallets.map((w, i) => {
        const bal = parseFloat(ethers.formatEther(bals[i]));
        const usd = bal * nativePrice;
        return [{
          text: `⬅️ ${w.label} — ${bal.toFixed(3)} ${_chainSymbol(chain)} (${_fmtUsd(usd)})`,
          callback_data: `tr:disp:${i}`,
        }];
      }),
      [{ text: '⬅️ Back', callback_data: 'nav:transfers' }],
    ],
  };
  return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
}

async function _executeTransferNative(chatId, userId, walletId, toAddress, amount) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  const nativeSymbol = _chainSymbol(chain);
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Sending ${amount === 'max' ? 'MAX' : amount} ${nativeSymbol}*\nTo: \`${_shortAddr(toAddress)}\``,
    { parse_mode: 'Markdown' }
  );
  try {
    const r = amount === 'max'
      ? await transfers.sendMaxNative(userId, walletId, chain, toAddress)
      : await transfers.sendNative(userId, walletId, chain, toAddress, amount);
    const explorer = _config.chains[chain].explorer;
    const sentEth = parseFloat(ethers.formatEther(r.amount));
    const nativePrice = await price.getNativePrice(chain).catch(() => 0);
    await bot.editMessageText(
      `✅ *Transfer successful*\n\n` +
      `Sent: ${sentEth.toFixed(6)} ${nativeSymbol} _(${_fmtUsd(sentEth * nativePrice)})_\n` +
      `To: \`${toAddress}\`\n\n[View tx](${explorer}/tx/${r.txHash})`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Transfer error:', err.message);
    await bot.editMessageText(`❌ Transfer failed\n\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  }
}

async function _executeTransferToken(chatId, userId, walletId, tokenAddr, toAddress, amount) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Sending token*\nToken: \`${_shortAddr(tokenAddr)}\`\nTo: \`${_shortAddr(toAddress)}\``,
    { parse_mode: 'Markdown' }
  );
  try {
    const r = amount === 'max'
      ? await transfers.sendMaxToken(userId, walletId, chain, tokenAddr, toAddress)
      : await transfers.sendToken(userId, walletId, chain, tokenAddr, toAddress, amount);
    const info = await trading.getTokenInfo(chain, tokenAddr, null);
    const explorer = _config.chains[chain].explorer;
    await bot.editMessageText(
      `✅ *Token transfer successful*\n\n` +
      `Sent: ${ethers.formatUnits(r.amount, info.decimals)} ${info.symbol}\n` +
      `To: \`${toAddress}\`\n\n[View tx](${explorer}/tx/${r.txHash})`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Token transfer error:', err.message);
    await bot.editMessageText(`❌ Transfer failed\n\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  }
}

async function _executeConsolidate(chatId, userId, targetWalletId) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  const target = wallet.getWalletById(userId, targetWalletId);
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Consolidating ${_chainSymbol(chain)} → ${target.label}*...`,
    { parse_mode: 'Markdown' }
  );
  try {
    const results = await transfers.consolidateNative(userId, targetWalletId, chain);
    const explorer = _config.chains[chain].explorer;
    let text = `✅ *Consolidation complete*\n\nTarget: *${target.label}*\n\n`;
    let totalSent = 0n;
    results.forEach(r => {
      if (r.success) {
        totalSent += r.amount;
        text += `🟢 ${r.from}: ${parseFloat(ethers.formatEther(r.amount)).toFixed(4)} → [tx](${explorer}/tx/${r.txHash})\n`;
      } else {
        text += `🔴 ${r.from}: ${r.error.slice(0, 40)}\n`;
      }
    });
    const nativePrice = await price.getNativePrice(chain).catch(() => 0);
    const totalUsd = parseFloat(ethers.formatEther(totalSent)) * nativePrice;
    text += `\n💰 *Total transferred:* ${parseFloat(ethers.formatEther(totalSent)).toFixed(4)} ${_chainSymbol(chain)} _(${_fmtUsd(totalUsd)})_`;
    await bot.editMessageText(text,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    await bot.editMessageText(`❌ Consolidation failed\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  }
}

async function _executeDispatch(chatId, userId, sourceWalletId, amountPerWallet) {
  const prefs = _getUserPrefs(userId);
  const chain = prefs.activeChain;
  const source = wallet.getWalletById(userId, sourceWalletId);
  const loadingMsg = await bot.sendMessage(chatId,
    `⏳ *Dispatching from ${source.label}*...`,
    { parse_mode: 'Markdown' }
  );
  try {
    const results = await transfers.dispatchNative(userId, sourceWalletId, chain, amountPerWallet === 'max' ? null : amountPerWallet);
    const explorer = _config.chains[chain].explorer;
    let text = `✅ *Dispatch complete*\n\nFrom: *${source.label}*\n\n`;
    results.forEach(r => {
      if (r.success) {
        text += `🟢 ${r.to}: ${parseFloat(ethers.formatEther(r.amount)).toFixed(4)} → [tx](${explorer}/tx/${r.txHash})\n`;
      } else {
        text += `🔴 ${r.to}: ${r.error.slice(0, 40)}\n`;
      }
    });
    await bot.editMessageText(text,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    await bot.editMessageText(`❌ Dispatch failed\n\`${err.message.slice(0, 200)}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  }
}

module.exports = { init, _executeTransferNative, _executeTransferToken, _executeDispatch };
