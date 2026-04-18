# 🤖 Jarvis Trade

**Telegram trading bot — Uniswap V3 + Aerodrome direct execution sur Ethereum & Base**

Un bot Telegram privé pour acheter/vendre des tokens ERC-20 sans frais intermédiaires. Inspiré de Sigma/Maestro mais custom, self-hosted, zéro fees sur le volume.

---

## Pourquoi ce projet

Les bots Telegram comme **Sigma** ou **Maestro** facturent **1% de frais sur tout le volume**. Sur $2M de volume, ça fait **$20k de frais** — complètement évitable avec un bot custom qui route directement vers les DEXs.

Jarvis Trade :
- **0% de frais** (juste gas + spread DEX)
- **Self-hosted** sur Railway
- **Keys chiffrées AES-256-GCM** (non-custodial local)
- **Privé** — usage par moi et mon pote seulement

---

## Features (MVP)

| Feature | Status |
|---------|--------|
| 💼 Generate / import wallet (chiffrement AES-256) | ✅ |
| 💎 Buy par contract address (auto-détection) | ✅ |
| 📊 Positions / Portfolio avec PnL live | ✅ |
| ⚡ Presets d'achat rapide (0.05/0.1/0.25/0.5/1 ETH) | ✅ |
| 💸 Sell avec % (25/50/75/100) | 🚧 WIP |
| 🔄 Multi-wallet par utilisateur | ✅ |
| 🔐 Auth par Telegram user ID (whitelist) | ✅ |

## Architecture

```
index.js          → Boot + API Express (port 3335)
config.js         → Env vars + paramètres
modules/
  telegram.js     → UI Telegram (menus, callbacks, flows)
  wallet.js       → Gen/import + AES-256-GCM encryption
  trading.js      → Orchestrateur (choix du meilleur DEX)
  positions.js    → Tracking portfolio + PnL (data.json)
  price.js        → Oracle prix via DexScreener
  dex/
    uniswap.js    → Uniswap V3 (SwapRouter02 + QuoterV2)
    aerodrome.js  → Aerodrome (Base only)
```

## Stack

- **Node.js 18+**
- **ethers.js v6** pour les interactions EVM
- **node-telegram-bot-api** pour Telegram
- **Pas de DB** — wallets.enc + data.json

## Sécurité

- Clés privées chiffrées **AES-256-GCM** avec dérivation scrypt
- Master key (`ENCRYPTION_KEY`) en env var, jamais en code
- Whitelist stricte des Telegram user IDs
- Clés privées jamais loggées ni envoyées sur le réseau
- Messages Telegram contenant des clés privées auto-supprimés à l'import

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
BASE_RPC_URL=                    # https://base.drpc.org
ETHEREUM_RPC_URL=                # https://eth.drpc.org

# Optional
PORT=3335
HUB_RELAY_URL=                   # Future Jarvis Hub integration
```

## Flow d'utilisation

1. `/start` → menu principal
2. `/wallet` → générer ou importer un wallet
3. Fund le wallet avec de l'ETH (Base ou Ethereum)
4. Coller un contract address (0x...) dans le chat → interface d'achat
5. Cliquer sur un preset (0.1 ETH) ou Custom
6. Trade exécuté → position trackée automatiquement
7. `/positions` → voir les positions ouvertes avec PnL live

## DEX Routing

Pour chaque trade, Jarvis Trade :
1. Quote Uniswap V3 (scan des 4 fee tiers : 100/500/3000/10000)
2. Quote Aerodrome (Base uniquement, stable + volatile pools)
3. Compare les `amountOut` et route vers le meilleur
4. Slippage par défaut : 1% (configurable)

## Infrastructure

| Composant | Détail |
|-----------|--------|
| Local | `http://localhost:3335` |
| GitHub | `xiliaf09/jarvis-trade` (privé) |
| Railway | Projet `jarvis-trade` |
| Telegram | `@JarvisTradeBot` (à créer) |

## Roadmap

**v0.2** — Sell flow complet + positions management
**v0.3** — Limit orders (buy at price)
**v0.4** — Multi-buy / multi-sell batch
**v0.5** — Copy trading d'adresses wallet
**v1.0** — Intégration Jarvis Hub (vue portfolio cross-bot)

---

*Built for speed, privacy and zero fees.*
