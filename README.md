# 🤖 Jarvis Trade

**Telegram trading bot — multi-DEX direct execution sur Base, Ethereum & BSC**

Un bot Telegram privé pour acheter/vendre des tokens ERC-20 sans frais intermédiaires. Inspiré de Sigma/Maestro mais custom, self-hosted, zéro fees sur le volume.

---

## Pourquoi ce projet

Les bots Telegram comme **Sigma** ou **Maestro** facturent **1% de frais sur tout le volume**. Sur $2M de volume, ça fait **$20k de frais** — complètement évitable avec un bot custom qui route directement vers les DEXs.

Jarvis Trade :
- **0% de frais** (juste gas + spread DEX)
- **Self-hosted** (local ou Railway)
- **Keys chiffrées AES-256-GCM** (non-custodial local)
- **Privé** — usage personnel whitelist-only

---

## Features

| Feature | Status |
|---------|--------|
| 💼 Generate / import wallet (AES-256-GCM) | ✅ |
| 🌐 Multi-chain : Base, Ethereum, BSC | ✅ |
| 💎 Buy par contract address (auto-détection chain) | ✅ |
| 💸 Sell avec % (25/50/75/100 + custom) | ✅ |
| 📊 Positions / Portfolio avec PnL live (DexScreener) | ✅ |
| ⚡ Presets d'achat rapide (configurable par chain) | ✅ |
| 🔄 Multi-wallet select (achat/vente sur plusieurs wallets en parallèle) | ✅ |
| 💱 Transfers : send native, send token, consolidate, dispatch | ✅ |
| 🎯 Auto-switch Buy ↔ Sell menu basé sur balance on-chain | ✅ |
| 🔁 Toggle Buy/Sell fluide (editMessage, zéro flicker) | ✅ |
| 🔐 Auth par Telegram user ID (whitelist) | ✅ |
| 🖼 PnL Card | 🚧 WIP |
| 📈 Limit Orders | 🚧 Planned |

---

## Architecture

```
index.js            → Boot + API Express (port 3335)
config.js           → Env vars + chain configs + presets
modules/
  telegram.js       → UI Telegram (menus, callbacks, flows Sigma-style)
  wallet.js         → Gen/import + AES-256-GCM encryption
  trading.js        → Orchestrateur multi-DEX + RPC fallback resilient
  positions.js      → Tracking portfolio + PnL (data.json)
  price.js          → Oracle prix via DexScreener + native price
  transfers.js      → Send native / token / consolidate / dispatch
  dex/
    uniswap.js      → Uniswap V3 (SwapRouter02 + QuoterV2)
    uniswap_v2.js   → Uniswap V2 (Base + Ethereum, meme tokens)
    aerodrome.js    → Aerodrome (Base only, stable + volatile)
    pancakeswap.js  → PancakeSwap V3 (BSC + Base + Ethereum)
    kyberswap.js    → KyberSwap aggregator (fallback V4/Doppler/hooks)
```

---

## DEX Routing

Pour chaque trade, Jarvis Trade teste en parallèle :

1. **Uniswap V3** (Base + Ethereum) — scan 4 fee tiers (100/500/3000/10000)
2. **Aerodrome** (Base only) — stable + volatile pools
3. **PancakeSwap V3** (BSC + Base + Ethereum) — scan 4 fee tiers
4. **Uniswap V2** (Base + Ethereum) — meme tokens
5. **KyberSwap aggregator** (fallback) — couvre Uniswap V4, Doppler hooks, tous les DEXs restants

Le bot compare les `amountOut` et route vers le meilleur. Slippage par défaut : 1% (configurable par user).

---

## RPC Resilience

- Primary RPC dRPC + fallbacks (llamarpc, publicnode, ankr, base.org)
- `runWithFallback(chain, fn)` — réessaie l'action sur chaque provider jusqu'à réussite
- `waitForReceiptResilient(chain, txHash)` — poll receipt avec fallback RPC (évite les "internal errors" dRPC)
- `getOnChainTokenBalance(chain, token, wallet)` — multi-RPC retry pour récupérer balance non-zero

---

## Stack

- **Node.js 18+**
- **ethers.js v6** pour les interactions EVM
- **node-telegram-bot-api** pour Telegram
- **Pas de DB** — `wallets.enc` + `data.json`

---

## Sécurité

- Clés privées chiffrées **AES-256-GCM** avec dérivation scrypt
- Master key (`ENCRYPTION_KEY`) en env var, jamais en code
- Whitelist stricte des Telegram user IDs
- Clés privées jamais loggées ni envoyées sur le réseau
- Messages Telegram contenant des clés privées auto-supprimés à l'import

---

## Setup

```bash
git clone https://github.com/xiliaf09/jarvis-trade.git
cd jarvis-trade
npm install
cp .env.example .env
# Remplis .env (voir variables ci-dessous)
node index.js
```

### Variables d'environnement

```env
# Required
TELEGRAM_BOT_TOKEN=              # Via @BotFather
ENCRYPTION_KEY=                  # Master password (min 32 chars random)
AUTHORIZED_USERS=                # "7042516399,123456789" (Telegram user IDs)

# RPCs (required for trading)
BASE_RPC_URL=                    # https://base.drpc.org (ou dRPC avec API key)
ETHEREUM_RPC_URL=                # https://eth.drpc.org
BSC_RPC_URL=                     # https://bsc.drpc.org

# Optional
PORT=3335
HUB_RELAY_URL=                   # Future Jarvis Hub integration
```

---

## Flow d'utilisation

1. `/start` → menu principal
2. `/wallets` → générer ou importer un wallet
3. Fund le wallet avec de l'ETH/BNB
4. Coller un contract address (0x...) dans le chat → interface token auto-détectée
   - Si tu **détient** le token → Sell menu ouvert par défaut
   - Si tu ne le détient pas → Buy menu
5. Cliquer sur un preset ou Custom
6. Trade exécuté → message de succès clean + switch automatique :
   - Reste du token → Sell menu re-affiché (balance à jour)
   - Tout vendu → Buy menu re-affiché (pour racheter si besoin)
7. `/positions` → voir toutes les positions ouvertes avec PnL live

### Interface Sigma-style

Le menu token reproduit la disposition Sigma :
- **Buy mode** : presets ETH + Custom + wallet selector multi-select + Gas/Slip
- **Sell mode** : Sell Initials + Sell X ETH + presets % + wallet selector + Sell All Wallets + PnL Card + Limit Order
- Toggle Buy ↔ Sell fluide (editMessageText, aucun flicker)
- Recent tokens épinglés (3 derniers)
- Multi-wallet : sélection instantanée via editMessageReplyMarkup

---

## Infrastructure

| Composant | Détail |
|-----------|--------|
| Local | `http://localhost:3335` |
| GitHub | `xiliaf09/jarvis-trade` (privé) |
| Railway | Projet `jarvis-trade` (à activer) |
| Telegram | Bot perso via @BotFather |

---

## Roadmap

- **v0.1** ✅ MVP : wallets, buy/sell cross-chain, positions, multi-wallet, transfers, auto-switch menu
- **v0.2** — PnL Card (image générée)
- **v0.3** — Limit orders (buy/sell at price)
- **v0.4** — Multi-buy / multi-sell batch cross-wallet
- **v0.5** — Copy trading (shadow d'une adresse wallet)
- **v1.0** — Intégration Jarvis Hub (vue portfolio cross-bot)

---

*Built for speed, privacy and zero fees.*
