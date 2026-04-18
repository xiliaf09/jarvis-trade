# Changelog

## v0.1.0 (2026-04-19) — MVP Setup

**Première version — Core trading flow**

### Features
- 💼 Wallet management : generate + import avec chiffrement AES-256-GCM (scrypt KDF)
- 💎 Buy par contract address : auto-detection chain (Base/Ethereum), affichage prix DexScreener, presets d'achat rapide
- 📊 Positions tracking : entry price pondéré, PnL live via DexScreener
- 📈 Stats : win rate, realized PnL, compteur trades
- 🔐 Sécurité : whitelist Telegram user IDs, message de clé privée auto-supprimé à l'import

### DEX Routing
- Uniswap V3 : scan des 4 fee tiers (100/500/3000/10000), quote via QuoterV2
- Aerodrome : pools stable + volatile, router V2-style
- Auto-routing : compare les quotes, exécute sur le meilleur

### Infrastructure
- Repo GitHub : `xiliaf09/jarvis-trade` (privé)
- Railway : projet à créer
- Persistence : `wallets.enc` (chiffré) + `data.json`

### TODO
- Sell flow complet avec % (25/50/75/100)
- Interface `/positions` avec boutons quick-sell
- Settings menu (slippage custom, presets custom)
- Limit orders (v0.3)
