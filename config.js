// ============================================================
// JARVIS TRADE — Configuration
// ============================================================

const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'ENCRYPTION_KEY',
  'AUTHORIZED_USERS',
];

const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`\n❌ Missing required env vars:\n${missing.map(v => `   - ${v}`).join('\n')}\n`);
  process.exit(1);
}

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
    bsc: process.env.BSC_RPC_URL || 'https://bsc.drpc.org',
  },

  // --- Server ---
  port: parseInt(process.env.PORT || '3335', 10),

  // --- Trading defaults ---
  trading: {
    defaultSlippageBps: 100,
    maxSlippageBps: 3000,
    defaultDeadlineSec: 300,
    defaultGasBufferMultiplier: 1.2,
    tradeConfirmation: false, // if true, ask confirm before executing
  },

  // --- Default presets (per-chain, user can override) ---
  defaultPresets: {
    base:     { buy: [0.05, 0.1, 0.25, 0.5, 1], gasGwei: [0.1, 0.5, 1] },
    ethereum: { buy: [0.05, 0.1, 0.25, 0.5, 1], gasGwei: [5, 10, 30] },
    bsc:      { buy: [0.1, 0.5, 1, 2, 5],       gasGwei: [3, 5, 10] },
  },
  sellPercentPresets: [10, 25, 50, 100],

  // --- Chain metadata (EVM only) ---
  chains: {
    base: {
      id: 8453,
      name: 'Base',
      symbol: 'ETH',
      icon: '🔵',
      explorer: 'https://basescan.org',
      wethAddress: '0x4200000000000000000000000000000000000006',
      usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      nativeCoinGeckoId: 'ethereum',
      dexes: ['uniswap', 'aerodrome'],
    },
    ethereum: {
      id: 1,
      name: 'Ethereum',
      symbol: 'ETH',
      icon: '⟠',
      explorer: 'https://etherscan.io',
      wethAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      nativeCoinGeckoId: 'ethereum',
      dexes: ['uniswap'],
    },
    bsc: {
      id: 56,
      name: 'BNB Smart Chain',
      symbol: 'BNB',
      icon: '🟡',
      explorer: 'https://bscscan.com',
      wethAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
      usdcAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      nativeCoinGeckoId: 'binancecoin',
      dexes: ['pancakeswap'],
    },
  },
};

config.chainKeys = Object.keys(config.chains);

module.exports = config;
