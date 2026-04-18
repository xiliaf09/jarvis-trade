// ============================================================
// JARVIS TRADE — Configuration
// ============================================================

const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'ENCRYPTION_KEY',
  'AUTHORIZED_USERS',
];

// --- Fail fast if required vars missing ---
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`\n❌ Missing required env vars:\n${missing.map(v => `   - ${v}`).join('\n')}\n`);
  process.exit(1);
}

// --- Validate encryption key length ---
if (process.env.ENCRYPTION_KEY.length < 32) {
  console.error('\n❌ ENCRYPTION_KEY must be at least 32 characters\n');
  process.exit(1);
}

const config = {
  // --- Telegram ---
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  authorizedUsers: process.env.AUTHORIZED_USERS.split(',').map(s => s.trim()).filter(Boolean),

  // --- Encryption ---
  encryptionKey: process.env.ENCRYPTION_KEY,

  // --- RPCs ---
  rpcs: {
    base: process.env.BASE_RPC_URL || 'https://base.drpc.org',
    ethereum: process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org',
  },

  // --- Server ---
  port: parseInt(process.env.PORT || '3335', 10),
  hubRelayUrl: process.env.HUB_RELAY_URL || '',

  // --- Trading defaults ---
  trading: {
    defaultSlippageBps: 100,      // 1% default slippage
    maxSlippageBps: 3000,         // 30% max slippage (safety cap)
    defaultDeadlineSec: 300,      // 5 min tx deadline
    defaultGasBufferMultiplier: 1.2,
  },

  // --- Preset amounts (in ETH, configurable per user later) ---
  presets: {
    buy: [0.05, 0.1, 0.25, 0.5, 1],    // ETH amounts
    sellPercent: [25, 50, 75, 100],    // sell percentages
  },

  // --- Chain metadata ---
  chains: {
    base: {
      id: 8453,
      name: 'Base',
      symbol: 'ETH',
      explorer: 'https://basescan.org',
      wethAddress: '0x4200000000000000000000000000000000000006',
      usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    ethereum: {
      id: 1,
      name: 'Ethereum',
      symbol: 'ETH',
      explorer: 'https://etherscan.io',
      wethAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    },
  },
};

module.exports = config;
