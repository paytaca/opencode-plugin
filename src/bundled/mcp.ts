// This file contains the bundled MCP server script as a string
// It gets written to ~/.opencode-paytaca/mcp-server.js at runtime

export const MCP_SERVER_CONTENT = `#!/usr/bin/env node
/**
 * Paytaca AI MCP Server
 *
 * Registers a small set of read-only tools (credits / balance / models / plans)
 * with opencode so the assistant can answer questions about the user's Paytaca
 * AI account instead of guessing. Loaded automatically via the plugin's
 * config hook (cfg.mcp['paytaca']).
 *
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
function runCommand(cmd, args) {
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
    }, 15000);
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

// Plan pricing grouped by tier, optionally filtered to one model
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
  const groups = { budget: [], premium: [], frontier: [], other: [] };
  for (const m of models) {
    const key = String(m.tier || '').toLowerCase();
    const groupKey = (key === 'budget' || key === 'premium' || key === 'frontier') ? key : 'other';
    groups[groupKey].push(m);
  }
  const lines = ['Paytaca AI — Model Pricing'];
  const order = [
    { key: 'budget', label: 'Budget' },
    { key: 'premium', label: 'Premium' },
    { key: 'frontier', label: 'Frontier' },
    { key: 'other', label: 'Other' },
  ];
  let any = false;
  for (const g of order) {
    const group = groups[g.key];
    if (group.length === 0) continue;
    any = true;
    lines.push('');
    lines.push(g.label);
    for (const m of group) {
      lines.push('');
      const tiers = Array.isArray(m.price_tiers) ? m.price_tiers : [];
      if (tiers.length === 0) {
        lines.push('- ' + (m.display_name || m.id) + ': no pricing configured');
        continue;
      }
      const sorted = tiers.slice().sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
      lines.push((m.display_name || m.id) + ':');
      for (const t of sorted) {
        const sats = typeof t.price_sats === 'number' ? t.price_sats : 0;
        const bch = (sats / 100000000).toFixed(8);
        const usd = typeof t.price_usd === 'number' ? t.price_usd.toFixed(4) : '?.??';
        lines.push('  ' + (t.minutes || 0) + ' minutes — USD ' + usd + ' (' + bch + ' BCH)');
      }
    }
  }
  if (!any) {
    lines.push('No models available.');
  }
  return lines.join('\\n');
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
];

// JSON-RPC over stdio (newline-delimited)
let buffer = '';
function handleMessage(msg) {
  if (msg.method === 'initialize') {
    const requestedVersion = msg.params && msg.params.protocolVersion;
    send(msg.id, {
      protocolVersion: requestedVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'paytaca', version: '1.0.0' },
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