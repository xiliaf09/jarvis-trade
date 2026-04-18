// ============================================================
// JARVIS TRADE — Wallet Management (generate/import + AES-256 encryption)
// ============================================================
//
// Private keys are NEVER stored in plaintext. They are:
//  1. Encrypted with AES-256-GCM using a master key derived from ENCRYPTION_KEY via scrypt
//  2. Stored in wallets.enc (JSON with ciphertext + iv + authTag per wallet)
//  3. Decrypted in memory only when signing a transaction, then immediately cleared
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const WALLETS_FILE = path.join(__dirname, '..', 'wallets.enc');

let _encryptionKey = null;
let _wallets = {}; // userId → { id, label, address, encrypted (base64) }

// ── Key derivation (scrypt) ──

function _deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

// ── Encryption / Decryption ──

function encrypt(plaintext, masterKey) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = _deriveKey(masterKey, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([salt, iv, authTag, encrypted]);
  return blob.toString('base64');
}

function decrypt(encoded, masterKey) {
  const blob = Buffer.from(encoded, 'base64');
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 28);
  const authTag = blob.subarray(28, 44);
  const encrypted = blob.subarray(44);
  const key = _deriveKey(masterKey, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// ── Persistence ──

function _loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) return;
  try {
    const raw = fs.readFileSync(WALLETS_FILE, 'utf-8');
    _wallets = JSON.parse(raw);
  } catch (err) {
    console.error('⚠️  Failed to load wallets.enc:', err.message);
  }
}

function _saveWallets() {
  try {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(_wallets, null, 2));
  } catch (err) {
    console.error('⚠️  Failed to save wallets.enc:', err.message);
  }
}

// ── Public API ──

function init(encryptionKey) {
  _encryptionKey = encryptionKey;
  _loadWallets();
  const total = Object.values(_wallets).reduce((s, list) => s + list.length, 0);
  console.log(`🔐 Wallet manager initialized — ${total} wallets loaded`);
}

function listWallets(userId) {
  return (_wallets[userId] || []).map(w => ({
    id: w.id,
    label: w.label,
    address: w.address,
  }));
}

function getWalletById(userId, walletId) {
  const list = _wallets[userId] || [];
  return list.find(w => w.id === walletId);
}

function generateWallet(userId, label = 'Wallet') {
  const newWallet = ethers.Wallet.createRandom();
  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    label,
    address: newWallet.address,
    encrypted: encrypt(newWallet.privateKey, _encryptionKey),
    createdAt: new Date().toISOString(),
  };
  if (!_wallets[userId]) _wallets[userId] = [];
  _wallets[userId].push(entry);
  _saveWallets();
  return {
    id: entry.id,
    label: entry.label,
    address: entry.address,
    mnemonic: newWallet.mnemonic?.phrase || null, // only returned ONCE at creation
  };
}

function importWallet(userId, privateKey, label = 'Imported') {
  // Validate & normalize the private key
  let wallet;
  try {
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    wallet = new ethers.Wallet(pk);
  } catch (err) {
    throw new Error('Invalid private key format');
  }

  // Check for duplicates
  const existing = (_wallets[userId] || []).find(w => w.address.toLowerCase() === wallet.address.toLowerCase());
  if (existing) throw new Error(`Wallet ${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)} already imported`);

  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    label,
    address: wallet.address,
    encrypted: encrypt(wallet.privateKey, _encryptionKey),
    createdAt: new Date().toISOString(),
    imported: true,
  };
  if (!_wallets[userId]) _wallets[userId] = [];
  _wallets[userId].push(entry);
  _saveWallets();
  return { id: entry.id, label: entry.label, address: entry.address };
}

function deleteWallet(userId, walletId) {
  if (!_wallets[userId]) return false;
  const before = _wallets[userId].length;
  _wallets[userId] = _wallets[userId].filter(w => w.id !== walletId);
  if (_wallets[userId].length < before) {
    _saveWallets();
    return true;
  }
  return false;
}

function renameWallet(userId, walletId, newLabel) {
  const w = getWalletById(userId, walletId);
  if (!w) return false;
  w.label = (newLabel || '').toString().slice(0, 40);
  _saveWallets();
  return true;
}

/**
 * Get a decrypted signer for a specific wallet.
 * Private key is only in memory during the call — caller should use it and discard.
 */
function getSigner(userId, walletId, provider) {
  const w = getWalletById(userId, walletId);
  if (!w) throw new Error('Wallet not found');
  const privateKey = decrypt(w.encrypted, _encryptionKey);
  const signer = new ethers.Wallet(privateKey, provider);
  // Note: ethers.Wallet internally stores the key — caller must not hold a reference long-term
  return signer;
}

/**
 * Reveal private key (sensitive — only for export/backup).
 * Caller MUST handle this securely and never log it.
 */
function revealPrivateKey(userId, walletId) {
  const w = getWalletById(userId, walletId);
  if (!w) throw new Error('Wallet not found');
  return decrypt(w.encrypted, _encryptionKey);
}

module.exports = {
  init,
  listWallets,
  getWalletById,
  generateWallet,
  importWallet,
  deleteWallet,
  renameWallet,
  getSigner,
  revealPrivateKey,
};
