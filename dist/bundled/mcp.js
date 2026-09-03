"use strict";
// This file contains the bundled MCP server script as a string
// It gets written to ~/.opencode-paytaca/mcp-server.js at runtime
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_SERVER_CONTENT = void 0;
exports.MCP_SERVER_CONTENT = `#!/usr/bin/env node
/**
 * Paytaca MCP Server
 *
 * Registers Paytaca tools with opencode so the assistant can work with real
 * data instead of guessing. Two groups:
 * - Paytaca AI account (backend): credits, models, plan pricing
 * - Paytaca wallet (paytaca CLI): balance, transactions, receiving address,
 *   token holdings, and sending funds
 *
 * The send tool moves real funds — opencode is configured (via the plugin's
 * config hook) to require explicit user approval before it runs.
 *
 * Loaded automatically via the plugin's config hook (cfg.mcp['paytaca']).
 * Uses only Node.js built-in modules.
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.PAYTACA_CONFIG_DIR || path.join(os.homedir(), '.opencode-paytaca');
const PAYTACA_CMD = process.env.PAYTACA_CMD || 'paytaca';
const DEFAULT_BACKEND = process.env.PAYTACA_BACKEND_URL || 'https://api.paytaca.ai';

// LIFT is the Paytaca token users can pay AI plans with (sold via Cauldron).
// The same token id is used by the payment wrapper's payWithLift().
const LIFT_TOKEN_ID = '5932b2fd4915d6a75d3ec53282cd49118149a2176ee67ed68b1111ff0786f7fc';

const PROTOCOL_VERSION = '2025-06-18';

// Logging setup
const LOG_FILE = path.join(CONFIG_DIR, 'mcp.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(message) {
  const timestamp = new Date().toISOString();
  logStream.write(timestamp + ' [MCP] ' + message + '\\n');
}

// Load fresh config on every call so walletHash/backendUrl never go stale
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

let BACKEND_URL = DEFAULT_BACKEND;
let WALLET_HASH = '';
function refreshConfig() {
  const cfg = loadConfig();
  BACKEND_URL = process.env.PAYTACA_BACKEND_URL || cfg.backendUrl || DEFAULT_BACKEND;
  WALLET_HASH = cfg.walletHash || '';
}

// Fetch a JSON payload over HTTP(S)
function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + url));
    }
    const requester = u.protocol === 'https:' ? https : http;
    const req = requester.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.substring(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

// Run a shell command with a timeout
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) {}
      reject(new Error('Command timed out'));
    }, timeoutMs || 15000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || 'Command exited with code ' + code));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Format seconds as MM:SS or HH:MM:SS
function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }
  return minutes + ':' + String(secs).padStart(2, '0');
}

// Remaining time credits per model session
async function getCredits() {
  const data = await getJson(BACKEND_URL + '/v1/wallet/status', { 'X-Wallet-Hash': WALLET_HASH });
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const active = sessions.filter((s) => s.time_remaining_seconds > 0 && s.model_active);
  const inactive = sessions.filter((s) => s.time_remaining_seconds > 0 && !s.model_active);
  const parts = [];
  if (active.length > 0) {
    parts.push('Active time credits:');
    for (const s of active) {
      const total = formatDuration(s.time_credits_seconds);
      const remaining = formatDuration(s.time_remaining_seconds);
      const used = formatDuration(s.time_used_seconds);
      parts.push('- ' + (s.display_name || s.ai_model) + ': ' + remaining + ' remaining of ' + total + ' (' + used + ' used)');
    }
  }
  if (inactive.length > 0) {
    parts.push('');
    parts.push('Inactive models (credits but session not active):');
    for (const s of inactive) {
      parts.push('- ' + (s.display_name || s.ai_model) + ': ' + formatDuration(s.time_remaining_seconds) + ' remaining');
    }
  }
  if (parts.length === 0) {
    return 'No active time credits.';
  }
  return parts.join('\\n');
}

// Wallet BCH balance via the paytaca CLI
async function getBalance() {
  const out = await runCommand(PAYTACA_CMD, ['wallet', 'info']);
  const match = out.match(/Balance:\\s*([\\d.]+)\\s*BCH/i);
  if (match) {
    return 'Wallet balance: ' + match[1] + ' BCH.';
  }
  return 'Could not parse balance. Raw output:\\n' + out.split('\\n').slice(0, 5).join('\\n');
}

// List all available models
async function getModels() {
  const data = await getJson(BACKEND_URL + '/v1/config', {});
  const models = Array.isArray(data.models) ? data.models : [];
  const lines = ['Available models:'];
  for (const m of models) {
    let line = m.id || 'unknown';
    if (m.display_name && m.display_name !== m.id) line += ' (' + m.display_name + ')';
    if (m.tier) line += ' [' + m.tier + ']';
    lines.push('- ' + line);
  }
  return lines.join('\\n');
}

// Plan pricing as a markdown table per model, optionally filtered to one model
async function getPlans(filterModel) {
  const data = await getJson(BACKEND_URL + '/v1/config', {});
  let models = Array.isArray(data.models) ? data.models : [];
  if (filterModel) {
    const f = String(filterModel).toLowerCase();
    models = models.filter((m) => {
      const id = String(m.id || '').toLowerCase();
      const name = String(m.display_name || '').toLowerCase();
      return id.indexOf(f) !== -1 || name.indexOf(f) !== -1;
    });
  }
  if (models.length === 0) {
    return 'No models available.';
  }
  const lines = [];
  for (const m of models) {
    const name = m.display_name || m.id;
    const tier = m.tier ? String(m.tier).charAt(0).toUpperCase() + String(m.tier).slice(1) : '';
    const tierInName = tier && name.toLowerCase().indexOf(tier.toLowerCase()) !== -1;
    if (lines.length > 0) lines.push('');
    lines.push('**' + name + (tier && !tierInName ? ' (' + tier + ')' : '') + '**');
    lines.push('');
    const tiers = Array.isArray(m.price_tiers) ? m.price_tiers : [];
    if (tiers.length === 0) {
      lines.push('No pricing configured.');
      continue;
    }
    lines.push('| Duration | USD | BCH | Sats |');
    lines.push('|---|---|---|---|');
    const sorted = tiers.slice().sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
    for (const t of sorted) {
      const sats = typeof t.price_sats === 'number' ? t.price_sats : 0;
      const bch = (sats / 100000000).toFixed(8);
      const usd = typeof t.price_usd === 'number' ? '$' + t.price_usd.toFixed(2) : '?.??';
      const satsStr = Number(sats).toLocaleString('en-US');
      lines.push('| ' + (t.minutes || 0) + ' min | ' + usd + ' | ' + bch + ' | ' + satsStr + ' |');
    }
  }
  return lines.join('\\n');
}

// Resolve a model (by id or display name) and its price tier by minutes.
// Uses the same /v1/config data as get_plans.
async function resolvePlan(modelFilter, minutes) {
  const data = await getJson(BACKEND_URL + '/v1/config', {});
  const models = Array.isArray(data.models) ? data.models : [];
  const f = String(modelFilter || '').toLowerCase();
  const matches = models.filter((m) => {
    const id = String(m.id || '').toLowerCase();
    const name = String(m.display_name || '').toLowerCase();
    return id.indexOf(f) !== -1 || name.indexOf(f) !== -1;
  });
  if (matches.length === 0) {
    const ids = models.map((m) => m.id).join(', ');
    throw new Error('Model not found: ' + modelFilter + '. Available models: ' + ids);
  }
  const model = matches[0];
  const tiers = Array.isArray(model.price_tiers) ? model.price_tiers : [];
  const want = Number(minutes);
  const tier = tiers.find((t) => Number(t.minutes) === want);
  if (!tier) {
    const avail = tiers.map((t) => t.minutes).join(', ');
    throw new Error('No ' + minutes + '-minute plan for ' + (model.display_name || model.id) + '. Available minutes: ' + avail);
  }
  return { model, tier };
}

// Wallet balance in sats (mirrors the proxy's pre-payment check)
async function getBalanceSats() {
  const out = await runCommand(PAYTACA_CMD, ['wallet', 'info'], 20000);
  const match = out.match(/Balance:\s*([\d.]+)\s*BCH/i);
  if (!match) return null;
  return Math.floor(parseFloat(match[1]) * 100000000);
}

// LIFT token balance in base units (2 decimals), null when the CLI output
// cannot be parsed.
async function getLiftBalanceUnits() {
  const out = await runCommand(PAYTACA_CMD, ['token', 'info', LIFT_TOKEN_ID], 20000);
  const match = out.match(/Balance:\s*([\d.]+)\s*LIFT/i);
  if (!match) return null;
  return BigInt(Math.round(parseFloat(match[1]) * 100));
}

// Purchase time credits for a specific model and plan duration. Reuses the
// same payment wrapper the proxy runs on a 402 (x402 payment + retry with the
// PAYMENT-SIGNATURE header), but works for ANY model/tier the user picks —
// not just the model active in the current session. Spends real BCH.
async function buyPlan(args) {
  const modelFilter = String(args.model || '').trim();
  const minutes = Number(args.minutes);
  const paymentMethod = args.payment_method === 'lift' ? 'lift' : 'bch';
  if (!modelFilter) {
    throw new Error('Missing model. Pass the model id or display name (e.g. deepseek/deepseek-v4-flash).');
  }
  if (isNaN(minutes) || minutes <= 0) {
    throw new Error('Missing or invalid minutes. Pass the plan duration, e.g. 30 for the 30-minute plan.');
  }

  const { model, tier } = await resolvePlan(modelFilter, minutes);
  const priceSats = Number(tier.price_sats) || 0;

  // Fail fast on insufficient balance instead of sending a txn that cannot
  // fund the plan (mirrors the proxy's 402 flow). Only applies to BCH — the
  // LIFT path funds the plan by selling tokens, so no BCH balance is required.
  if (paymentMethod === 'bch') {
    const balanceSats = await getBalanceSats();
    if (balanceSats !== null && balanceSats < priceSats) {
      const addr = await getReceivingAddress({});
      const shortfall = (priceSats - balanceSats) / 100000000;
      throw new Error('Insufficient balance: ' + (balanceSats / 100000000).toFixed(8) + ' BCH available but the ' + minutes + '-minute plan costs ' + (priceSats / 100000000).toFixed(8) + ' BCH. Top up at least ' + shortfall.toFixed(8) + ' BCH to: ' + addr);
    }
  } else {
    // LIFT path: fail fast if the wallet holds no LIFT, instead of prompting
    // for approval and then failing inside the wrapper.
    const liftBalanceUnits = await getLiftBalanceUnits();
    if (liftBalanceUnits !== null && liftBalanceUnits <= 0n) {
      throw new Error('No LIFT tokens in the wallet. Add LIFT to pay this plan with tokens, or call again with payment_method "bch".');
    }
  }

  const wrapper = path.join(CONFIG_DIR, 'paytaca-pay-wrapper.mjs');
  if (!fs.existsSync(wrapper)) {
    throw new Error('Payment wrapper not found at ' + wrapper + '. Restart opencode so the plugin writes it.');
  }

  // Minimal chat request for the target model; the payment flow only needs a
  // valid request that triggers the x402 PaymentRequired for that model.
  const body = JSON.stringify({
    model: model.id,
    messages: [{ role: 'user', content: 'Purchase plan' }],
    stream: false,
  });

  const url = BACKEND_URL + '/v1/chat/completions?wallet_hash=' + encodeURIComponent(WALLET_HASH || '');
  const extraHeaders = {
    'X-Model-Id': model.id,
    'X-Duration-Minutes': String(tier.minutes),
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paytaca-buy-plan-'));
  const bodyFile = path.join(tmpDir, 'body.json');
  const configFile = path.join(tmpDir, 'config.json');
  try {
    fs.writeFileSync(bodyFile, body, 'utf8');
    const config = {
      url: url,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders),
      bodyFile: bodyFile,
      confirmed: true,
    };
    if (paymentMethod === 'lift') {
      config.paymentMethod = 'lift';
    }
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf8');
  } catch (e) {
    try { fs.rmdirSync(tmpDir); } catch (e2) {}
    throw new Error('Failed to write payment files: ' + e.message);
  }

  log('Buy plan requested: ' + model.id + ' ' + tier.minutes + ' min (' + paymentMethod + ')');
  let stdout;
  try {
    stdout = await runCommand('node', [wrapper, configFile], 250000);
  } finally {
    try { fs.unlinkSync(bodyFile); } catch (e2) {}
    try { fs.unlinkSync(configFile); } catch (e2) {}
    try { fs.rmdirSync(tmpDir); } catch (e2) {}
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch (e) {
    throw new Error('Could not parse payment result: ' + stdout.substring(0, 200));
  }

  if (result.timeout) {
    return 'Payment was processed but the response timed out. Check your credits with get_credits.';
  }
  if (!result.success) {
    throw new Error(result.error || 'Payment failed (status ' + result.status + ').');
  }

  const lines = ['Plan purchased for ' + (model.display_name || model.id) + ': ' + tier.minutes + ' minutes' + (paymentMethod === 'lift' ? ' (paid with LIFT).' : '.')];
  if (result.payment && result.payment.txid) {
    lines.push('Transaction: ' + result.payment.txid);
  }
  try {
    const status = await getJson(BACKEND_URL + '/v1/wallet/status', { 'X-Wallet-Hash': WALLET_HASH });
    const sessions = Array.isArray(status.sessions) ? status.sessions : [];
    const found = sessions.find((s) => s.ai_model === model.id);
    if (found && found.time_remaining_seconds > 0) {
      lines.push('Credits: ' + formatDuration(found.time_remaining_seconds) + ' remaining.');
    }
  } catch (e) {}
  return lines.join('\\n');
}

// Recent wallet transactions via the paytaca CLI
async function getTransactions(args) {
  const cmdArgs = ['history'];
  if (args.type === 'incoming' || args.type === 'outgoing') {
    cmdArgs.push('--type', args.type);
  }
  const page = parseInt(args.page, 10);
  if (!isNaN(page) && page > 0) {
    cmdArgs.push('--page', String(page));
  }
  const out = await runCommand(PAYTACA_CMD, cmdArgs, 30000);
  return out || 'No transactions found.';
}

// Receiving address via the paytaca CLI (QR art suppressed)
async function getReceivingAddress(args) {
  const cmdArgs = ['receive', '--no-qr'];
  const amount = parseFloat(args.amount);
  if (!isNaN(amount) && amount > 0) {
    cmdArgs.push('--amount', String(amount));
  }
  const out = await runCommand(PAYTACA_CMD, cmdArgs, 30000);
  return out.trim() || 'Could not get receiving address.';
}

// CashToken holdings via the paytaca CLI (all tokens, or one category)
async function getTokens(args) {
  const category = args.category ? String(args.category).trim() : '';
  const cmdArgs = category ? ['token', 'info', category] : ['token', 'list'];
  const out = await runCommand(PAYTACA_CMD, cmdArgs, 30000);
  return out.trim() || (category ? 'Token not found: ' + category : 'No tokens found.');
}

// Send BCH or CashTokens. This spends real funds — opencode requires manual
// user approval for this tool (permission 'paytaca_send' set to 'ask' by the
// plugin's config hook), so it must never be called without the user asking
// for the send.
async function sendFunds(args) {
  const address = String(args.address || '').trim();
  const amount = String(args.amount || '').trim();
  const unit = args.unit === 'sats' ? 'sats' : 'bch';
  const tokenCategory = args.token_category ? String(args.token_category).trim() : '';
  if (!address) {
    throw new Error('Missing recipient address.');
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    throw new Error('Missing or invalid amount.');
  }
  const cmdArgs = tokenCategory
    ? ['token', 'send', address, amount, '--token', tokenCategory]
    : ['send', address, amount];
  if (!tokenCategory && unit === 'sats') {
    cmdArgs.push('--unit', 'sats');
  }
  log('Send requested: ' + cmdArgs.join(' '));
  const out = await runCommand(PAYTACA_CMD, cmdArgs, 90000);
  log('Send completed');
  return 'Transaction sent.\\n\\n' + out;
}

// Tool schemas (concise descriptions so MCP tool context stays small)
const TOOLS = [
  {
    name: 'get_credits',
    description: 'Get remaining Paytaca AI time credits (active model sessions, time left). Use when the user asks about credits, remaining time, session status, or how much usage they have left.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_balance',
    description: 'Get the BCH balance of the user\\'s Paytaca wallet. Use when the user asks about wallet balance or funds.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_models',
    description: 'List the AI models available on Paytaca AI (id, display name, tier). Use when the user asks which models are available.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_plans',
    description: 'Get Paytaca AI plan pricing: time tiers in minutes with USD and BCH prices, grouped by tier. Optionally pass a model id/name to filter one model. Use when the user asks about plans, pricing, costs, or how much a model costs.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Optional model id or display name to filter pricing to a single model.' },
      },
    },
  },
  {
    name: 'buy_plan',
    description: 'Purchase Paytaca AI time credits for a specific model and plan duration. SPENDS FUNDS FROM THE WALLET (BCH, or LIFT tokens sold via Cauldron when payment_method=lift) — only call when the user explicitly asks to buy, purchase, or pay for a plan; opencode prompts the user for approval. Show pricing with get_plans first, then call with the model and minutes the user picked. Works for any model, even one not active in the current session. IMPORTANT — LIFT phrasing: when the user says "pay with LIFT", "pay with LIFT tokens", "use LIFT", or mentions paying a plan with their LIFT token balance, set payment_method to "lift". LIFT is the Paytaca token users hold to pay for AI plans; "pay with LIFT" is NOT asking to buy a plan called LIFT. Default to "bch" unless the user explicitly mentions LIFT/tokens.',
    inputSchema: {
      type: 'object',
      required: ['model', 'minutes'],
      properties: {
        model: { type: 'string', description: 'Model id or display name, e.g. deepseek/deepseek-v4-flash or DeepSeek V4 Flash.' },
        minutes: { type: 'number', description: 'Plan duration in minutes, e.g. 30 for the 30-minute tier.' },
        payment_method: { type: 'string', enum: ['bch', 'lift'], description: 'Payment method. bch (default) pays from the BCH balance. Set to lift when the user says "pay with LIFT" or "pay with LIFT tokens" — this sells the wallet LIFT token balance via Cauldron to fund the plan. Use lift when the wallet lacks BCH but holds LIFT, or when the user explicitly asks to pay with LIFT.' },
      },
    },
  },
  {
    name: 'get_transactions',
    description: 'Get recent Paytaca wallet transactions (sent/received BCH). Use when the user asks about transaction history or latest transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['incoming', 'outgoing'], description: 'Optional direction filter.' },
        page: { type: 'number', description: 'Optional 1-based page number for older history.' },
      },
    },
  },
  {
    name: 'get_receiving_address',
    description: 'Get a Paytaca wallet receiving address for depositing BCH, optionally as a BIP21 URI with an amount. Use when the user wants to fund the wallet or needs their address.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Optional BCH amount to embed in a BIP21 payment URI.' },
      },
    },
  },
  {
    name: 'get_tokens',
    description: 'List CashToken holdings of the Paytaca wallet, or get details (name, symbol, balance, NFTs) for one token category. Use when the user asks about tokens or NFTs.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional token category id for details of a single token.' },
      },
    },
  },
  {
    name: 'send',
    description: 'Send BCH or CashTokens from the Paytaca wallet to an address. SPENDS REAL FUNDS — only call when the user explicitly asks to send; opencode will prompt the user for approval and that prompt must never be bypassed. Token amounts are in base units; recipients of tokens should use token-aware (z-prefix) addresses.',
    inputSchema: {
      type: 'object',
      required: ['address', 'amount'],
      properties: {
        address: { type: 'string', description: 'Recipient CashAddr (e.g. bitcoincash:qp...).' },
        amount: { type: 'string', description: 'Amount to send.' },
        unit: { type: 'string', enum: ['bch', 'sats'], description: 'Amount unit, default bch. Ignored for token sends.' },
        token_category: { type: 'string', description: 'Token category id to send CashTokens instead of BCH.' },
      },
    },
  },
];

// JSON-RPC over stdio (newline-delimited)
let buffer = '';
function handleMessage(msg) {
  if (msg.method === 'initialize') {
    const requestedVersion = msg.params && msg.params.protocolVersion;
    send(msg.id, {
      protocolVersion: requestedVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'paytaca', version: '1.2.0' },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    return;
  }
  if (msg.method === 'ping') {
    send(msg.id, {});
    return;
  }
  if (msg.method === 'tools/list') {
    send(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    refreshConfig();
    (async () => {
      let text;
      try {
        switch (name) {
          case 'get_credits': text = await getCredits(); break;
          case 'get_balance': text = await getBalance(); break;
          case 'get_models': text = await getModels(); break;
          case 'get_plans': text = await getPlans(args.model); break;
          case 'buy_plan': text = await buyPlan(args); break;
          case 'get_transactions': text = await getTransactions(args); break;
          case 'get_receiving_address': text = await getReceivingAddress(args); break;
          case 'get_tokens': text = await getTokens(args); break;
          case 'send': text = await sendFunds(args); break;
          default: throw new Error('Unknown tool: ' + name);
        }
        send(msg.id, { content: [{ type: 'text', text: text }] });
      } catch (e) {
        log('Tool ' + name + ' failed: ' + e.message);
        send(msg.id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    })();
    return;
  }
  // Unknown request — respond with an empty result so the client never hangs
  if (typeof msg.id !== 'undefined' && msg.id !== null) {
    send(msg.id, {});
  }
}

function send(id, result) {
  const payload = { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.substring(0, idx).trim();
    buffer = buffer.substring(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    try {
      handleMessage(msg);
    } catch (e) {
      log('handleMessage error: ' + e.message);
    }
  }
});

refreshConfig();
log('MCP server started (backend=' + BACKEND_URL + ')');
`;
//# sourceMappingURL=mcp.js.map