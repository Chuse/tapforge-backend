// ============================================================================
// KLEVERTOOLS BOT — Custodial Wallet Service
// ============================================================================
// Generates Klever wallets, encrypts private keys with a single master key.
//
// Security model:
//   - Private keys are AES-256-GCM encrypted with ONE master key
//     (CUSTODIAL_MASTER_KEY env var, set in Railway — never in the repo)
//   - Each wallet still has its own random IV + authTag per encryption
//   - No PIN, no unlock session: decrypt happens inline on each send,
//     directly from DB, and is never cached in memory beyond the call
//   - A single compromised env var decrypts ALL custodial wallets —
//     this is a deliberate low-friction tradeoff, not an oversight.
//     Mitigate with: hard balance caps per wallet, treating these as
//     hot/pass-through wallets, Railway sealed vars, no logging of
//     decrypted keys ever.
//
// Requires: @klever/sdk-node, crypto (native)
// ============================================================================

const crypto = require('crypto');
const { pool } = require('./db');

// ── Constants ──
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;        // 256 bits
const IV_LENGTH = 16;         // 128 bits

// ── Master key (loaded once, derived from env var) ──
let masterKey = null;

function getMasterKey() {
  if (masterKey) return masterKey;

  const raw = process.env.CUSTODIAL_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'CUSTODIAL_MASTER_KEY no está configurada. Añádela como variable sellada en Railway (32 bytes, hex o base64).'
    );
  }

  // Accept either a 64-char hex string or a base64 string that decodes to 32 bytes
  let keyBuf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    keyBuf = Buffer.from(raw, 'hex');
  } else {
    keyBuf = Buffer.from(raw, 'base64');
  }

  if (keyBuf.length !== KEY_LENGTH) {
    throw new Error(
      `CUSTODIAL_MASTER_KEY debe decodificar a ${KEY_LENGTH} bytes (obtenido: ${keyBuf.length}). Genera una con: crypto.randomBytes(32).toString('hex')`
    );
  }

  masterKey = keyBuf;
  return masterKey;
}

// ── Klever SDK (lazy loaded) ──
let kleverSdk = null;

async function getKleverSdk() {
  if (!kleverSdk) {
    try {
      kleverSdk = require('@klever/sdk-node');
      const provider = {
        api: process.env.KLEVER_API || 'https://api.testnet.klever.org/v1.0',
        node: process.env.KLEVER_NODE || 'https://node.testnet.klever.org',
      };
      // Remove /v1.0 suffix for SDK provider (it adds its own)
      const apiUrl = provider.api.replace('/v1.0', '');
      kleverSdk.utils.setProviders({ api: apiUrl, node: provider.node });
    } catch (err) {
      console.error('❌ @klever/sdk-node not installed. Run: npm install @klever/sdk-node');
      throw err;
    }
  }
  return kleverSdk;
}

// ============================================================================
// ENCRYPTION HELPERS
// ============================================================================

/**
 * Encrypt private key with the master key
 * Returns: { encrypted, iv, authTag } — all as hex strings
 */
function encryptPrivateKey(privateKeyHex) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(privateKeyHex, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt private key with the master key
 * Returns: privateKeyHex string, or null if decryption fails
 * (should only fail on data corruption — there's no per-user secret anymore)
 */
function decryptPrivateKey(encData) {
  try {
    const key = getMasterKey();
    const iv = Buffer.from(encData.iv, 'hex');
    const authTag = Buffer.from(encData.authTag, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error('❌ decryptPrivateKey error:', err.message);
    return null;
  }
}

// ============================================================================
// DATABASE — custodial_wallets table
// ============================================================================

async function ensureCustodialTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custodial_wallets (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL UNIQUE,
      wallet_address VARCHAR(100) NOT NULL UNIQUE,
      encrypted_key TEXT NOT NULL,
      iv VARCHAR(64) NOT NULL,
      auth_tag VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_custodial_tg ON custodial_wallets(telegram_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_custodial_addr ON custodial_wallets(wallet_address)');
  console.log('  ✅ custodial_wallets table ready');
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Create a new custodial wallet for a Telegram user
 * @param {number} telegramId
 * @returns {{ success: boolean, address?: string, error?: string }}
 */
async function createWallet(telegramId) {
  // Check if already has a custodial wallet
  const existing = await pool.query(
    'SELECT wallet_address FROM custodial_wallets WHERE telegram_id = $1',
    [telegramId]
  );
  if (existing.rows.length > 0) {
    return {
      success: false,
      error: 'already_exists',
      address: existing.rows[0].wallet_address,
    };
  }

  try {
    // Generate Klever keypair
    const sdk = await getKleverSdk();
    const keyPair = await sdk.utils.generateKeyPair();

    // keyPair should have: { privateKey: string (hex), address: string (klv1...) }
    const privateKeyHex = keyPair.privateKey;
    const address = keyPair.address;

    if (!privateKeyHex || !address) {
      console.error('❌ SDK generateKeyPair returned unexpected format:', Object.keys(keyPair));
      return { success: false, error: 'sdk_error' };
    }

    // Encrypt private key with the master key
    const encData = encryptPrivateKey(privateKeyHex);

    // Store in DB
    await pool.query(
      `INSERT INTO custodial_wallets 
       (telegram_id, wallet_address, encrypted_key, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5)`,
      [telegramId, address, encData.encrypted, encData.iv, encData.authTag]
    );

    console.log(`🔐 Custodial wallet created: ${formatAddr(address)} for TG:${telegramId}`);

    return { success: true, address };

  } catch (err) {
    console.error('❌ createWallet error:', err);
    if (err.code === '23505') { // unique constraint
      return { success: false, error: 'already_exists' };
    }
    return { success: false, error: 'internal' };
  }
}

/**
 * Get custodial wallet address for a Telegram user (no auth needed)
 */
async function getCustodialAddress(telegramId) {
  const res = await pool.query(
    'SELECT wallet_address FROM custodial_wallets WHERE telegram_id = $1',
    [telegramId]
  );
  return res.rows[0]?.wallet_address || null;
}

/**
 * Check if user has a custodial wallet
 */
async function hasCustodialWallet(telegramId) {
  const addr = await getCustodialAddress(telegramId);
  return !!addr;
}

/**
 * Get the decrypted private key for a Telegram user, straight from DB.
 * No session, no cache — decrypts inline on every call using the master key.
 * @param {number} telegramId
 * @returns {Promise<string|null>} Private key hex, or null if no wallet / decrypt failed
 */
async function getPrivateKey(telegramId) {
  const res = await pool.query(
    'SELECT encrypted_key, iv, auth_tag FROM custodial_wallets WHERE telegram_id = $1',
    [telegramId]
  );
  if (res.rows.length === 0) return null;

  const row = res.rows[0];
  return decryptPrivateKey({
    encrypted: row.encrypted_key,
    iv: row.iv,
    authTag: row.auth_tag,
  });
}

// ============================================================================
// TRANSACTION HELPERS
// ============================================================================

/**
 * Get wallet balance from Klever API
 * @param {string} address - klv1... address
 * @returns {{ klv: number, tokens: object }} 
 */
async function getBalance(address) {
  try {
    const apiBase = process.env.KLEVER_API || 'https://api.testnet.klever.org/v1.0';
    const resp = await fetch(`${apiBase}/address/${address}`);
    if (!resp.ok) return { klv: 0, tokens: {} };

    const data = await resp.json();
    const account = data?.data?.account;
    if (!account) return { klv: 0, tokens: {} };

    const klv = (account.balance || 0) / 1e6;
    const tokens = {};

    // Parse assets (KDAs)
    if (account.assets) {
      for (const [assetId, assetData] of Object.entries(account.assets)) {
        if (assetId === 'KLV') continue; // Already counted above
        const balance = (assetData.balance || 0) / Math.pow(10, assetData.precision || 6);
        if (balance > 0) {
          tokens[assetId] = balance;
        }
      }
    }

    return { klv, tokens };

  } catch (err) {
    console.error('❌ getBalance error:', err.message);
    return { klv: 0, tokens: {} };
  }
}

/**
 * Build, sign and broadcast a Transfer transaction
 * Uses the Account-based approach which auto-resolves chainID and nonce
 * @param {number} telegramId - Must have a custodial wallet
 * @param {string} receiver - klv1... address
 * @param {number} amount - Human-readable amount
 * @param {string} [kda='KLV'] - Token to send
 * @param {number} [decimals=6] - Token decimals
 * @returns {{ success: boolean, txHash?: string, error?: string }}
 */
async function sendTransfer(telegramId, receiver, amount, kda = 'KLV', decimals = 6) {
  const privateKey = await getPrivateKey(telegramId);
  if (!privateKey) {
    return { success: false, error: 'no_wallet' };
  }

  try {
    const sdk = await getKleverSdk();
    const address = await getCustodialAddress(telegramId);
    if (!address) return { success: false, error: 'no_wallet' };

    const amountUnits = Math.round(amount * Math.pow(10, decimals));
    console.log(`📤 Preparing TX: ${amount} ${kda} (${amountUnits} units) → ${formatAddr(receiver)}`);

    // Use Account-based approach — auto-resolves nonce and chainID
    const account = new sdk.Account(privateKey);
    await account.ready;

    const unsignedTx = await account.buildTransaction([{
      payload: {
        receiver: receiver,
        amount: amountUnits,
        kda: kda,
      },
      type: sdk.TransactionType.Transfer,
    }]);

    console.log(`📋 TX built, signing...`);
    const signedTx = await account.signTransaction(unsignedTx);
    
    console.log(`📋 TX signed, broadcasting...`);
    const broadcastRes = await account.broadcastTransactions([signedTx]);

    console.log(`📋 Broadcast response:`, JSON.stringify(broadcastRes));

    // Extract txHash from response
    const txHash = broadcastRes?.data?.txsHashes?.[0] 
                || broadcastRes?.data?.txHash
                || broadcastRes?.data?.tx_hash;

    if (txHash) {
      console.log(`✅ TX sent: ${txHash}`);
      return { success: true, txHash };
    } else if (broadcastRes?.error) {
      console.error('❌ Broadcast error:', broadcastRes.error);
      return { success: false, error: broadcastRes.error };
    } else {
      console.error('❌ Broadcast: no hash in response:', JSON.stringify(broadcastRes));
      return { success: false, error: 'no_hash_returned' };
    }

  } catch (err) {
    console.error('❌ sendTransfer error:', err);
    return { success: false, error: err.message || 'tx_error' };
  }
}

/**
 * Build, sign and broadcast a SmartContract invoke transaction (tipo 63)
 * Uses buildTransaction with metadata as second parameter (base64-encoded).
 * Reference: https://forum.klever.org/t/klever-sc-invoke-via-node-sdk-troubleshooting-fix/3931/8
 */
async function sendSmartContract(telegramId, contractAddress, functionName, args = [], amountKLV = 0) {
  const privateKey = await getPrivateKey(telegramId);
  if (!privateKey) {
    return { success: false, error: 'no_wallet' };
  }

  try {
    const address = await getCustodialAddress(telegramId);
    if (!address) return { success: false, error: 'no_wallet' };

    const amountUnits = Math.round(amountKLV * 1e6);
    console.log(`📤 SC Call: ${functionName}(${args.join(', ')}) → ${formatAddr(contractAddress)} [${amountKLV} KLV]`);

    // Build the metadata string: "function@hexArg1@hexArg2"
    // Then encode to Base64 (this is the key!)
    const dataStr = [functionName, ...args].join('@');
    const metadata = Buffer.from(dataStr).toString('base64');
    console.log(`📋 SC data: ${dataStr}`);
    console.log(`📋 SC metadata (b64): ${metadata}`);

    const sdk = await getKleverSdk();
    const account = new sdk.Account(privateKey);
    await account.ready;

    // Build SC payload
    const payload = {
      scType: 0,  // 0 = SCInvoke
      address: contractAddress,
    };

    // Add callValue if payable
    if (amountUnits > 0) {
      payload.callValue = { KLV: amountUnits };
    }

    // buildTransaction(contracts, metadata[], options?)
    const unsignedTx = await account.buildTransaction(
      [{
        payload,
        type: sdk.TransactionType.SmartContract,
      }],
      [metadata]
    );

    console.log(`📋 TX built, signing...`);
    const signedTx = await account.signTransaction(unsignedTx);

    console.log(`📋 TX signed, broadcasting...`);
    const broadcastRes = await account.broadcastTransactions([signedTx]);
    console.log(`📋 SC Broadcast response:`, JSON.stringify(broadcastRes));

    const txHash = broadcastRes?.data?.txsHashes?.[0]
                || broadcastRes?.data?.txHash
                || broadcastRes?.data?.tx_hash;

    if (txHash) {
      console.log(`✅ SC TX sent: ${txHash}`);
      return { success: true, txHash };
    } else if (broadcastRes?.error) {
      console.error('❌ SC Broadcast error:', broadcastRes.error);
      return { success: false, error: broadcastRes.error };
    } else {
      console.error('❌ SC Broadcast: no hash:', JSON.stringify(broadcastRes));
      return { success: false, error: 'no_hash_returned' };
    }

  } catch (err) {
    console.error('❌ sendSmartContract error:', err.message || err);
    return { success: false, error: err.message || 'sc_error' };
  }
}

// ============================================================================
// KSN — KLEVER SERVER NAMES RESOLUTION
// ============================================================================

const KSN_CONTRACT = process.env.KSN_CONTRACT || 'klv1qqqqqqqqqqqqqpgqpyt9gvhjmc7jvted2r0une8hsk6gpccul4yscfsv59';

/**
 * Extract name and TLD from a full KSN name (e.g. "chuse.klv" → { name: "chuse", tld: "klv" })
 */
function parseKSNName(fullName) {
  let clean = fullName.toLowerCase().trim();
  if (clean.endsWith('.klever')) return { name: clean.slice(0, -7), tld: 'klever' };
  if (clean.endsWith('.klv')) return { name: clean.slice(0, -4), tld: 'klv' };
  return { name: clean, tld: 'klv' }; // default TLD
}

/**
 * Resolve a .klv name to a Klever address via the KSN smart contract
 * @param {string} name - Name without suffix (e.g. "chuse") or with suffix ("chuse.klv")
 * @returns {string|null} - klv1... address or null if not found/expired
 */
async function resolveKSN(name) {
  try {
    const { name: cleanName, tld } = parseKSNName(name);
    
    if (!cleanName || cleanName.length === 0) return null;
    
    // Encode name and tld to hex
    const nameHex = Buffer.from(cleanName, 'utf8').toString('hex');
    const tldHex = Buffer.from(tld, 'utf8').toString('hex');
    
    // Call resolve view on the KSN contract
    const nodeUrl = process.env.KLEVER_NODE || 'https://node.testnet.klever.org';
    const resp = await fetch(`${nodeUrl}/vm/hex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scAddress: KSN_CONTRACT,
        funcName: 'resolve',
        args: [nameHex, tldHex],
      }),
    });
    
    const data = await resp.json();
    if (data.code !== 'successful' || !data.data?.data) return null;
    
    const addrHex = data.data.data;
    if (!addrHex || addrHex.length !== 64) return null;
    
    // Convert 32-byte hex to bech32 klv1... address
    return hexToBech32(addrHex);
  } catch (err) {
    console.error('❌ KSN resolve error:', err.message);
    return null;
  }
}

/**
 * Check if a string looks like a KSN name (ends with .klv or .klever)
 */
function isKSNName(str) {
  if (!str) return false;
  const lower = str.toLowerCase().trim();
  return lower.endsWith('.klv') || lower.endsWith('.klever');
}

/**
 * Call a KSN contract view function
 * @param {string} funcName
 * @param {string[]} args - hex-encoded arguments
 * @returns {string|null} - hex returnData from the VM
 */
async function callKSNView(funcName, args = []) {
  try {
    const nodeUrl = process.env.KLEVER_NODE || 'https://node.testnet.klever.org';
    const resp = await fetch(`${nodeUrl}/vm/hex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scAddress: KSN_CONTRACT,
        funcName,
        args,
      }),
    });

    const data = await resp.json();
    if (data.code !== 'successful' || !data.data?.data) return null;
    return data.data.data;
  } catch (err) {
    console.error(`❌ KSN view ${funcName} error:`, err.message);
    return null;
  }
}

/**
 * Check if a .klv name is available for registration
 * @param {string} name - Name with or without .klv suffix
 * @returns {boolean}
 */
async function checkKSNAvailable(name) {
  const { name: cleanName, tld } = parseKSNName(name);
  const nameHex = Buffer.from(cleanName, 'utf8').toString('hex');
  const tldHex = Buffer.from(tld, 'utf8').toString('hex');
  const result = await callKSNView('isAvailable', [nameHex, tldHex]);
  return result === '01';
}

/**
 * Get the base price for registering a .klv name (in raw KLV units)
 * @param {string} name - Name with or without .klv suffix
 * @param {number} years - Duration in years
 * @returns {number|null} - Price in raw units (divide by 1e6 for human-readable)
 */
async function getKSNPrice(name, years = 1) {
  const { name: cleanName } = parseKSNName(name);
  const nameHex = Buffer.from(cleanName, 'utf8').toString('hex');
  const yearsHex = numToHex(years);
  const result = await callKSNView('getPrice', [nameHex, yearsHex]);
  if (!result) return null;
  return parseInt(result, 16);
}

/**
 * Check if the contract is paused
 * @returns {boolean}
 */
async function isKSNPaused() {
  const result = await callKSNView('isPaused', []);
  return result === '01';
}

/**
 * Get how many names an address already has registered
 * @param {string} address - klv1... address
 * @returns {number}
 */
async function getKSNNameCount(address) {
  const addrHex = bech32ToHex(address);
  if (!addrHex) return 0;
  const result = await callKSNView('getNameCount', [addrHex]);
  if (!result) return 0;
  return parseInt(result, 16) || 0;
}

/**
 * Get max names allowed per address
 * @returns {number}
 */
async function getKSNMaxNames() {
  const result = await callKSNView('getMaxNamesPerAddress', []);
  if (!result) return 5;
  return parseInt(result, 16) || 5;
}

/**
 * Get all names owned by an address (non-expired)
 * Returns array of { name, tld } objects parsed from "name:tld" full keys
 * @param {string} address - klv1... address
 * @returns {Array<{name: string, tld: string, full: string}>}
 */
async function getKSNNamesByOwner(address) {
  const addrHex = bech32ToHex(address);
  if (!addrHex) return [];
  
  const result = await callKSNView('getNamesByOwner', [addrHex]);
  if (!result) return [];
  
  // Result is pipe-separated "name1:tld1|name2:tld2|..." in hex
  const decoded = Buffer.from(result, 'hex').toString('utf8');
  if (!decoded) return [];
  
  const names = [];
  const entries = decoded.split('|');
  for (const entry of entries) {
    const colonIdx = entry.lastIndexOf(':');
    if (colonIdx > 0) {
      names.push({
        name: entry.substring(0, colonIdx),
        tld: entry.substring(colonIdx + 1),
        full: `${entry.substring(0, colonIdx)}.${entry.substring(colonIdx + 1)}`,
      });
    }
  }
  
  return names;
}

/**
 * Local name validation (no contract call needed)
 * Rules: a-z and hyphens only, no leading/trailing/consecutive hyphens, 1-64 chars
 */
function validateKSNName(name) {
  if (!name || name.length === 0 || name.length > 64) {
    return { valid: false, reason: 'Longitud debe ser 1-64 caracteres' };
  }
  if (!/^[a-z-]+$/.test(name)) {
    return { valid: false, reason: 'Solo letras a-z y guión (-) permitidos' };
  }
  if (name.startsWith('-')) {
    return { valid: false, reason: 'No puede empezar con guión' };
  }
  if (name.endsWith('-')) {
    return { valid: false, reason: 'No puede terminar con guión' };
  }
  if (name.includes('--')) {
    return { valid: false, reason: 'No se permiten guiones consecutivos' };
  }
  return { valid: true };
}

/**
 * Convert a number to hex string (even length, zero-padded)
 */
function numToHex(n) {
  if (n === 0) return '00';
  let h = n.toString(16);
  return h.length % 2 ? '0' + h : h;
}

/**
 * Convert bech32 klv1... address to 32-byte hex string
 */
function bech32ToHex(addr) {
  try {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const HRP = 'klv';

    if (!addr || !addr.startsWith(HRP + '1')) return null;

    const dataStr = addr.slice(HRP.length + 1);
    const data5bit = [];
    for (const c of dataStr) {
      const idx = CHARSET.indexOf(c);
      if (idx < 0) return null;
      data5bit.push(idx);
    }

    // Remove 6-byte checksum
    const payload5bit = data5bit.slice(0, -6);

    // Convert 5-bit to 8-bit
    const bytes = convertBits(payload5bit, 5, 8, false);
    if (!bytes || bytes.length !== 32) return null;

    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Convert 32-byte hex address to bech32 klv1... format
 */
function hexToBech32(hex) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const HRP = 'klv';
  
  // hex → bytes
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  
  // Convert 8-bit to 5-bit groups
  const converted = convertBits(bytes, 8, 5, true);
  if (!converted) return null;
  
  // Compute checksum
  const hrpExpanded = [];
  for (let i = 0; i < HRP.length; i++) hrpExpanded.push(HRP.charCodeAt(i) >> 5);
  hrpExpanded.push(0);
  for (let i = 0; i < HRP.length; i++) hrpExpanded.push(HRP.charCodeAt(i) & 31);
  
  const values = hrpExpanded.concat(converted).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  
  let result = HRP + '1';
  for (let i = 0; i < converted.length; i++) result += CHARSET[converted[i]];
  for (let i = 0; i < 6; i++) result += CHARSET[(polymod >> (5 * (5 - i))) & 31];
  
  return result;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const result = [];
  const maxv = (1 << toBits) - 1;
  for (let i = 0; i < data.length; i++) {
    acc = (acc << fromBits) | data[i];
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) result.push((acc << (toBits - bits)) & maxv);
  return result;
}

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (let i = 0; i < values.length; i++) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[i];
    for (let j = 0; j < 5; j++) {
      if ((b >> j) & 1) chk ^= GEN[j];
    }
  }
  return chk;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatAddr(addr) {
  if (!addr || addr.length < 20) return addr || '';
  return addr.substring(0, 12) + '...' + addr.slice(-6);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  ensureCustodialTable,
  createWallet,
  getCustodialAddress,
  hasCustodialWallet,
  getPrivateKey,
  getBalance,
  sendTransfer,
  sendSmartContract,
  resolveKSN,
  isKSNName,
  parseKSNName,
  checkKSNAvailable,
  getKSNPrice,
  isKSNPaused,
  getKSNNameCount,
  getKSNMaxNames,
  getKSNNamesByOwner,
  validateKSNName,
  formatAddr,
  KSN_CONTRACT,
};
