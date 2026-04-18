// ============================================================
// JARVIS TRADE v0.1.0 — Telegram Trading Bot
// Uniswap V3 + Aerodrome direct execution on Ethereum & Base
// ============================================================

const JARVIS_VERSION = 'v0.1.0';

const config = require('./config');
const express = require('express');
const wallet = require('./modules/wallet');
const trading = require('./modules/trading');
const positions = require('./modules/positions');
const telegram = require('./modules/telegram');

// ── Express API (for future Jarvis Hub integration) ──
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: JARVIS_VERSION,
    uptime: process.uptime(),
  });
});

// ── Boot ──
async function boot() {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   JARVIS TRADE ${JARVIS_VERSION}                ║`);
  console.log(`║   Telegram Trading Bot                ║`);
  console.log(`║   Uniswap V3 + Aerodrome              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  console.log(`⚙️  Config loaded`);
  console.log(`   📱 Telegram: ✅`);
  console.log(`   👥 Authorized users: ${config.authorizedUsers.length}`);
  console.log(`   🔐 Encryption key: ${config.encryptionKey.length} chars`);
  console.log(`   🌐 RPC Base: ${config.rpcs.base.slice(0, 30)}...`);
  console.log(`   🌐 RPC Ethereum: ${config.rpcs.ethereum.slice(0, 30)}...`);

  // Init modules
  wallet.init(config.encryptionKey);
  trading.init(config.rpcs);
  positions.init();
  telegram.init(config);

  // Start HTTP server
  app.listen(config.port, () => {
    console.log(`\n🌐 API server: http://localhost:${config.port}`);
  });

  console.log(`\n✅ Jarvis Trade is live\n`);
}

boot().catch(err => {
  console.error('❌ Boot failed:', err.message);
  process.exit(1);
});
