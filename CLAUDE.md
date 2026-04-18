# JARVIS TRADE — Claude Code Instructions

## Project
- **Jarvis Trade** — Telegram trading bot, self-hosted, zero fees
- **Version**: see `JARVIS_VERSION` constant (line 6 of index.js)
- **Format**: `vMAJOR.MINOR.PATCH`
- **Runtime**: Node.js 18+, ethers.js v6
- **Local**: `http://localhost:3335`
- **Scope**: usage par xiliaf09 et son pote uniquement (pas de commercialisation)

## Pourquoi ce projet existe
User payait ~$20k/6mois de frais sur Sigma Bot (1% sur $2M volume). Ce bot les court-circuite en routant directement vers les DEXs (Uniswap V3 + Aerodrome) sur Ethereum et Base.

## Architecture
```
index.js            — Boot + API Express
config.js           — Env vars + paramètres
modules/
  telegram.js       — UI Telegram (menus, callbacks, flows)
  wallet.js         — Gen/import + AES-256-GCM encryption (scrypt KDF)
  trading.js        — Orchestrateur DEX (choix du meilleur quote)
  positions.js      — Portfolio tracking + PnL (data.json)
  price.js          — DexScreener price oracle
  dex/
    uniswap.js      — Uniswap V3 (SwapRouter02, QuoterV2, Factory)
    aerodrome.js    — Aerodrome V2-style router (Base only)
```

## Sécurité CRITIQUE
- Clés privées **JAMAIS** en plaintext, **JAMAIS** loggées, **JAMAIS** sur le réseau
- Encryption AES-256-GCM avec scrypt KDF (N=16384, r=8, p=1)
- Master key `ENCRYPTION_KEY` en env var (min 32 chars)
- Whitelist Telegram user IDs via `AUTHORIZED_USERS`
- Quand user importe une clé privée, le message contenant la clé est auto-supprimé
- Mnemonic phrase affichée UNE SEULE FOIS à la génération (pas re-récupérable)

## Env vars
- `TELEGRAM_BOT_TOKEN` — required (via @BotFather)
- `ENCRYPTION_KEY` — required, min 32 chars (random)
- `AUTHORIZED_USERS` — required, comma-separated Telegram IDs (ex: "7042516399,123456789")
- `BASE_RPC_URL` — required pour trading sur Base
- `ETHEREUM_RPC_URL` — required pour trading sur Ethereum
- `PORT` — default 3335

## Routing DEX
Pour chaque trade, `trading.getBestQuote()` :
1. Quote Uniswap V3 (scan fee tiers 100/500/3000/10000, picks highest liquidity)
2. Quote Aerodrome (Base only, stable + volatile)
3. Compare `amountOut`, exécute sur le gagnant
4. Slippage default 1% (100 bps), cap 30%

## Commandes Telegram
- `/start` — menu principal avec stats
- `/wallet` — gestion des wallets (generate/import)
- `/positions` — positions ouvertes avec PnL live
- `/stats` — statistiques (trades, win rate, realized PnL)
- Coller un `0x...` (contract address) → interface d'achat automatique

## Flow d'achat
1. User colle une CA (auto-detect ERC-20)
2. Bot détecte le chain (Base puis Ethereum), fetch price via DexScreener
3. Affiche card : symbol, price, change24h, liquidity, volume
4. Keyboard : 5 presets (0.05/0.1/0.25/0.5/1 ETH) + Custom + Wallet switcher
5. Click → execute → record position → confirmation avec lien explorer

## Key Patterns
- **Conversation state**: `_state` Map dans telegram.js pour les multi-step flows (custom amount, import PK, etc.)
- **Anti-duplicate**: `_processedMsgs` Set pour éviter les doublons (polling conflicts)
- **Signer isolation**: `wallet.getSigner()` déchiffre la clé en mémoire, le signer est utilisé pour UNE tx puis jeté
- **Position weighted avg**: `positions.recordBuy()` moyenne pondérée pour l'entry price sur multi-buys
- **Price caching**: 30s TTL sur DexScreener queries

## TODO Immédiat
- Implémenter sell flow complet dans telegram.js (`_handleSellCallback`)
- Interface `/positions` avec boutons quick-sell (25/50/75/100%)
- Settings menu (slippage custom, presets custom)

## Infrastructure
- **Railway project**: `jarvis-trade` (à créer)
- **GitHub**: `xiliaf09/jarvis-trade` (privé)
- **Local data**: `wallets.enc` (chiffré), `data.json` (positions/trades)

## Style de travail attendu
- Autonomie complète, tester avant de dire "fait"
- Commit + push après chaque feature validée
- Sécurité d'abord (financial app — bugs = argent perdu)
- Interfaces pro : inline keyboards, feedback immédiat, gestion d'erreurs claire
