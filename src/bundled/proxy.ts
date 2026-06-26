// This file contains the bundled proxy script as a string
// It gets written to ~/.opencode-paytaca/proxy.js at runtime

export const PROXY_SCRIPT_CONTENT = `#!/usr/bin/env node
/**
 * Paytaca AI Proxy
 * 
 * Sits between OpenCode and the Django backend.
 * - Auto-starts by OpenCode plugin
 * - On 402, returns SSE typewriter loading sequence + synthetic payment prompt
 * - Stores pending payments; handles "yes"/"no" approval internally
 * - Uses only Node.js built-in modules
 * 
 * Usage: node proxy.js [backend_url] [proxy_port]
 * Example: node proxy.js https://api.paytaca.ai 8001
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROXY_PORT = parseInt(process.argv[3]) || 8001;
const BACKEND_URL = process.argv[2] || 'https://api.paytaca.ai';
const parsedUrl = new URL(BACKEND_URL);
const DJANGO_HOST = parsedUrl.hostname;
const DJANGO_PORT = parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80);
const REQUester = parsedUrl.protocol === 'https:' ? https : http;

// Logging setup: write to file instead of console
const LOG_DIR = path.join(os.homedir(), '.opencode-paytaca');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(message) {
  const timestamp = new Date().toISOString();
  logStream.write(timestamp + ' [Proxy] ' + message + '\\n');
}

// Heartbeat monitoring - proxy exits if heartbeat is stale
const HEARTBEAT_FILE = path.join(LOG_DIR, 'heartbeat');
const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

function checkHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) {
      // No heartbeat file yet, wait a bit
      return true;
    }
    const heartbeat = parseInt(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    if (heartbeat === 0) {
      // Special value: plugin is stopping
      log('Heartbeat = 0, shutting down...');
      return false;
    }
    const elapsed = Date.now() - heartbeat;
    if (elapsed > HEARTBEAT_TIMEOUT) {
      log('Heartbeat stale (' + elapsed + 'ms), shutting down...');
      return false;
    }
    return true;
  } catch (err) {
    // If we can't read heartbeat, keep running (graceful degradation)
    return true;
  }
}

// Heartbeat checker reference (will be started after server creation)
let heartbeatChecker = null;

// Store pending payment requests per wallet hash
// Each entry: { body, modelId, displayName, durationMinutes, tiers[], step }
// step: 'tier_select' (user must pick a tier) or 'approval' (yes/no)
const pendingPayments = new Map();

// Utility: run shell command and return output
function runCommand(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || 'Command exited with code ' + code));
    });
    
    child.on('error', (err) => reject(err));
  });
}

// Get paytaca command from environment or default to 'paytaca'
const PAYTACA_CMD = process.env.PAYTACA_CMD || 'paytaca';

// Utility: check if paytaca CLI exists
async function checkPaytacaCli() {
  try {
    // Try to run version check
    await runCommand(PAYTACA_CMD, ['--version']);
    return true;
  } catch {
    return false;
  }
}

// Utility: get wallet balance in sats
async function getWalletBalance() {
  try {
    const output = await runCommand(PAYTACA_CMD, ['wallet', 'info']);
    const match = output.match(/Balance:\\s*([\\d.]+)\\s*BCH/i);
    if (match) {
      const bch = parseFloat(match[1]);
      return Math.floor(bch * 100000000);
    }
    return null;
  } catch (err) {
    log('Failed to get wallet balance: ' + err.message);
    return null;
  }
}

// Utility: get receiving address
async function getReceivingAddress() {
  try {
    const output = await runCommand(PAYTACA_CMD, ['wallet', 'info']);
    const match = output.match(/Address:\\s*(bitcoincash:[a-zA-Z0-9]+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Utility: check if wallet exists
async function checkWallet() {
  try {
    await runCommand(PAYTACA_CMD, ['wallet', 'info']);
    return true;
  } catch {
    return false;
  }
}

// SSE helper: write a data line
function sseLine(res, data) {
  res.write('data: ' + JSON.stringify(data) + '\\n\\n');
}

// SSE helper: write [DONE]
function sseDone(res) {
  res.write('data: [DONE]\\n\\n');
}

// Build and stream SSE tier selection prompt
async function streamTierSelectionPrompt(res, walletHash, modelName, tiers) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Payment-Required': 'true',
    'Connection': 'keep-alive',
  });

  sseLine(res, {
    id: 'tier-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  sseLine(res, {
    id: 'tier-2',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '💳 Select a plan for ' + (modelName || 'AI Model') + '\\n\\n' }, finish_reason: null }],
  });

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const label = String(i + 1) + '️⃣ ';
    sseLine(res, {
      id: 'tier-3-' + i,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: label + tier.minutes + ' minutes — ₱' + tier.price_php.toFixed(2) + '\\n' }, finish_reason: null }],
    });
  }

  sseLine(res, {
    id: 'tier-4',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '\\nEnter a number (1-' + tiers.length + '), e.g. type ' + tiers[0].minutes + ':' }, finish_reason: 'stop' }],
  });

  sseLine(res, {
    id: 'tier-5',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

  sseDone(res);
  res.end();
}

// Build and stream SSE loading sequence + payment prompt
async function streamPaymentPrompt(res, walletHash, isRenewal = false, tokensUsed = 0, tokenLimit = 50000, timeRemainingSeconds = 0) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Payment-Required': 'true',
    'Connection': 'keep-alive',
  });

  // Fetch dynamic pricing from backend config
  let costPhp = 10.00;
  let costBch = '0.00080000';
  let costSats = 80000;
  let usingDefaultRate = false;
  
  try {
    const configRes = await fetch(BACKEND_URL + '/v1/config');
    if (configRes.ok) {
      const config = await configRes.json();
      costPhp = config.cost_php || 10.00;
      costBch = config.cost_bch || '0.00080000';
      costSats = config.cost_sats || 80000;
    }
  } catch (e) {
    // Backend unreachable — will warn user below
    usingDefaultRate = true;
  }
  
  const baseId = isRenewal ? 'renewal' : 'payment';

  sseLine(res, {
    id: baseId + '-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  let balanceStr;
  let hasCli, hasWallet, balanceSats;

  if (isRenewal) {
    // For renewals, skip the full loading sequence and fetch balance quietly
    hasCli = await checkPaytacaCli();
    hasWallet = hasCli ? await checkWallet() : false;
    balanceSats = hasWallet ? await getWalletBalance() : null;
    if (balanceSats !== null) {
      balanceStr = (balanceSats / 100000000).toFixed(8) + ' BCH';
    } else {
      balanceStr = 'Unable to check (try restarting)';
    }
  } else {
    // First-time users: show full loading sequence
    sseLine(res, {
      id: baseId + '-2',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '⏳ Initializing Paytaca AI provider...\\n' }, finish_reason: null }],
    });

    hasCli = await checkPaytacaCli();
    sseLine(res, {
      id: baseId + '-3',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Checking Paytaca CLI... ' }, finish_reason: null }],
    });
    sseLine(res, {
      id: baseId + '-4',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: hasCli ? '✅\\n' : '❌ Not found\\n' }, finish_reason: null }],
    });

    hasWallet = hasCli ? await checkWallet() : false;
    sseLine(res, {
      id: baseId + '-5',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Checking wallet... ' }, finish_reason: null }],
    });
    sseLine(res, {
      id: baseId + '-6',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: hasWallet ? '✅\\n' : '❌ Not found\\n' }, finish_reason: null }],
    });

    balanceSats = hasWallet ? await getWalletBalance() : null;
    sseLine(res, {
      id: baseId + '-7',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Fetching balance... ' }, finish_reason: null }],
    });

    if (balanceSats !== null) {
      balanceStr = (balanceSats / 100000000).toFixed(8) + ' BCH';
      sseLine(res, {
        id: baseId + '-8',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: '✅\\n\\n' }, finish_reason: null }],
      });
    } else {
      balanceStr = 'Unable to check (try restarting)';
      sseLine(res, {
        id: baseId + '-8',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: '❌\\n\\n' }, finish_reason: null }],
      });
    }
  }

  let promptHeader = isRenewal
    ? '💳 Session Expired — Payment Required to Continue\\n\\n'
    : '💳 Paytaca AI — Payment Required\\n\\n';
  
  sseLine(res, {
    id: baseId + '-9',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: promptHeader }, finish_reason: null }],
  });
  
  sseLine(res, {
    id: baseId + '-10',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'Cost: ' + costPhp.toFixed(2) + ' PHP (~' + costBch + ' BCH)\\n' }, finish_reason: null }],
  });
  
  if (usingDefaultRate) {
    sseLine(res, {
      id: baseId + '-10b',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '⚠️ Could not reach backend for live pricing. Using default rate.\\n' }, finish_reason: null }],
    });
  }
  
  if (isRenewal) {
    const usedMinutes = Math.round(timeRemainingSeconds / 60);
    const remainingAttr = usedMinutes > 0 ? usedMinutes + ' min remaining' : 'depleted';
    sseLine(res, {
      id: baseId + '-11',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Previous Session: ' + tokensUsed.toLocaleString() + ' / ' + tokenLimit.toLocaleString() + ' tokens used\\n' }, finish_reason: null }],
    });
    sseLine(res, {
      id: baseId + '-12',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '⏱ Time Credits: ' + remainingAttr + '\\n' }, finish_reason: null }],
    });
  }
  
  sseLine(res, {
    id: baseId + '-13',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'Wallet Balance: ' + balanceStr + '\\n' }, finish_reason: null }],
  });
  
  if (balanceSats !== null) {
    const affordable = Math.floor(balanceSats / costSats);
    sseLine(res, {
      id: baseId + '-14',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'You could afford about ~' + affordable + ' sessions\\n\\n' }, finish_reason: null }],
    });
  }
  
  if (balanceSats !== null && balanceSats < costSats) {
    const addr = await getReceivingAddress();
    if (addr) {
      sseLine(res, {
        id: baseId + '-15',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: '⚠️ Insufficient balance for a session.\\nFund your wallet: ' + addr + '\\nOr run: paytaca receive (in another terminal) for QR code\\n\\n' }, finish_reason: null }],
      });
    }
  }
  
  if (balanceSats === null || balanceSats > 0) {
    sseLine(res, {
      id: baseId + '-16',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Approve payment? (yes/no)' }, finish_reason: 'stop' }],
    });
  }
  
  sseLine(res, {
    id: baseId + '-17',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  
  sseDone(res);
  res.end();
}

// Forward request to Django and return response (buffered, for non-streaming)
function forwardToDjango(req, body, callback) {
  const options = {
    hostname: DJANGO_HOST,
    port: DJANGO_PORT,
    path: req.url,
    method: req.method,
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'X-Wallet-Hash': req.headers['x-wallet-hash'] || '',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const startTime = Date.now();
  log('forwardToDjango -> ' + options.method + ' ' + options.hostname + ':' + options.port + options.path);

  const djangoReq = REQUester.request(options, (djangoRes) => {
    let responseBody = '';
    djangoRes.on('data', chunk => { responseBody += chunk; });
    djangoRes.on('end', () => {
      const elapsed = Date.now() - startTime;
      log('Django responded in ' + elapsed + 'ms: status=' + djangoRes.statusCode + ', bodyLen=' + responseBody.length);
      callback(null, djangoRes.statusCode, djangoRes.headers, responseBody);
    });
  });

  djangoReq.setTimeout(30000, () => {
    djangoReq.destroy();
    callback(new Error('Django request timed out after 30s'));
  });

  djangoReq.on('error', (err) => {
    log('Django request error: ' + err.message);
    callback(err);
  });

  djangoReq.write(body);
  djangoReq.end();
}

// Forward streaming request to Django
function forwardStreaming(req, res, body, callback) {
  const options = {
    hostname: DJANGO_HOST,
    port: DJANGO_PORT,
    path: req.url,
    method: req.method,
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'X-Wallet-Hash': req.headers['x-wallet-hash'] || '',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const startTime = Date.now();
  log('forwardStreaming -> ' + options.method + ' ' + options.hostname + ':' + options.port + options.path);

  const djangoReq = REQUester.request(options, (djangoRes) => {
    const elapsed = Date.now() - startTime;
    log('Django response started in ' + elapsed + 'ms: status=' + djangoRes.statusCode);

    if (djangoRes.statusCode === 402) {
      let responseBody = '';
      djangoRes.on('data', chunk => { responseBody += chunk; });
      djangoRes.on('end', () => {
        callback(null, 402, djangoRes.headers, responseBody);
      });
      return;
    }

    res.writeHead(djangoRes.statusCode, {
      'Content-Type': djangoRes.headers['content-type'] || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    djangoRes.pipe(res);
    
    res.on('close', () => {
      log('Client connection closed');
    });
    
    djangoRes.on('end', () => {
      callback(null, djangoRes.statusCode, {}, '');
    });
  });

  djangoReq.setTimeout(30000, () => {
    djangoReq.destroy();
    callback(new Error('Django streaming request timed out after 30s'));
  });

  djangoReq.on('error', (err) => {
    log('Django streaming request error: ' + err.message);
    callback(err);
  });

  djangoReq.write(body);
  djangoReq.end();
}

// Force stream=false in body because paytaca pay reads the response as text
function forceNonStreaming(body) {
  try {
    const data = JSON.parse(body);
    data.stream = false;
    return JSON.stringify(data);
  } catch {
    return body;
  }
}

// Convert a chat.completion JSON object to SSE format
function jsonToSse(res, chatCompletion) {
  const content = chatCompletion.choices?.[0]?.message?.content || '';
  const model = chatCompletion.model || chatCompletion.model_id || 'deepseek-ai/DeepSeek-V4-Flash';
  const created = chatCompletion.created || Math.floor(Date.now() / 1000);


  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  } catch (e) {
    return;
  }

  try {
    sseLine(res, {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  } catch (e) {
  }

  const chunkSize = 20;
  let chunksWritten = 0;
  for (let i = 0; i < content.length; i += chunkSize) {
    try {
      sseLine(res, {
        id: 'chatcmpl-' + (i + 2),
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
      });
      chunksWritten++;
    } catch (e) {
      break;
    }
  }

  try {
    sseLine(res, {
      id: 'chatcmpl-done',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: chatCompletion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
  }

  try {
    sseDone(res);
  } catch (e) {
  }

  try {
    res.end();
  } catch (e) {
  }
}

// Run paytaca pay internally and return the response
function runPaytacaPay(djangoUrl, body, walletHash, extraHeaders, callback) {
  const url = djangoUrl + '/chat/completions?wallet_hash=' + encodeURIComponent(walletHash || '');
  const payBody = forceNonStreaming(body);

  // Write body to a temp file to avoid CLI arg length limits
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paytaca-pay-'));
  const bodyFile = path.join(tmpDir, 'body.json');
  const configFile = path.join(tmpDir, 'config.json');

  try {
    fs.writeFileSync(bodyFile, payBody, 'utf8');
  } catch (err) {
    return callback(new Error('Failed to write temp body file: ' + err.message));
  }

  const config = {
    url,
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    bodyFile,
    confirmed: true,
  };

  try {
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf8');
  } catch (err) {
    return callback(new Error('Failed to write temp config file: ' + err.message));
  }

  // Path to the wrapper script
  const wrapperScript = path.join(LOG_DIR, 'paytaca-pay-wrapper.mjs');
  log('Running paytaca pay via wrapper script...');

  const child = spawn('node', [wrapperScript, configFile], { shell: false });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => { 
    stdout += data.toString(); 
  });
  child.stderr.on('data', (data) => { 
    stderr += data.toString(); 
  });

  child.on('close', (code) => {
    // Clean up temp files
    try {
      fs.unlinkSync(bodyFile);
      fs.unlinkSync(configFile);
      fs.rmdirSync(tmpDir);
    } catch {}

    if (code === 0) {
      try {
        const responseJson = JSON.parse(stdout.trim());
        callback(null, responseJson);
      } catch (err) {
        callback(new Error('Could not parse paytaca pay response: ' + err.message));
      }
    } else {
      callback(new Error(stderr.trim() || 'paytaca pay wrapper exited with code ' + code));
    }
  });

  child.on('error', (err) => {
    // Clean up temp files on error
    try {
      fs.unlinkSync(bodyFile);
      fs.unlinkSync(configFile);
      fs.rmdirSync(tmpDir);
    } catch {}
    callback(new Error('Failed to run paytaca pay wrapper: ' + err.message));
  });
}

// Extract the last user message content from a chat payload
function getLastUserMessageContent(body) {
  try {
    const data = JSON.parse(body);
    const messages = data.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        if (Array.isArray(content)) {
          const parts = [];
          for (const part of content) {
            if (part && typeof part === 'object' && part.type === 'text') {
              parts.push(part.text || '');
            } else if (typeof part === 'string') {
              parts.push(part);
            } else {
              parts.push(JSON.stringify(part));
            }
          }
          return parts.join('').trim().toLowerCase();
        }
        return String(content || '').trim().toLowerCase();
      }
    }
    return '';
  } catch {
    return '';
  }
}

// Main proxy server
const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Wallet-Hash, X-Model-Id, X-Duration-Minutes, Payment-Signature, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Discovery endpoint - fetch from backend to get actual config
  if (req.url === '/v1/config' && req.method === 'GET') {
    try {
      const backendConfig = await fetch(BACKEND_URL + '/v1/config');
      if (backendConfig.ok) {
        const config = await backendConfig.json();
        // Add proxy-specific info
        config.proxy_url = 'http://localhost:' + PROXY_PORT + '/v1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }
    } catch (err) {
      log('Failed to fetch backend config: ' + err.message);
    }
    
    // Fallback to static values if backend unavailable
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      proxy_url: 'http://localhost:' + PROXY_PORT + '/v1',
      django_url: BACKEND_URL + '/v1',
      payment_address: '',
      default_model: 'deepseek-ai/DeepSeek-V4-Flash',
      default_duration_minutes: 30,
      models: [
        {
          id: 'deepseek-ai/DeepSeek-V4-Flash',
          object: 'model',
          display_name: 'DeepSeek V4 Flash',
          provider: 'gmi',
          price_tiers: [
            { minutes: 10, price_php: 5.0, price_sats: 45000 },
            { minutes: 30, price_php: 12.0, price_sats: 108000 },
            { minutes: 60, price_php: 20.0, price_sats: 180000 },
          ],
        },
      ],
      context_retention_hours: 2,
    }));
    return;
  }
  
  // All other endpoints — read body and forward to Django
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const walletHash = req.headers['x-wallet-hash'];
      const lastContent = getLastUserMessageContent(body);
      
      // DEBUG: Log full body and parsed content
      
      log('Request received: wallet=' + (walletHash?.substring(0, 16) || 'none') + '..., bodyLen=' + body.length + ', pending=' + pendingPayments.has(walletHash));
      
      // Guard: wallet hash is required for payment flow
      if (!walletHash) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'X-Wallet-Hash header required' }));
        return;
      }
      
      // Check if there's a pending payment for this wallet
      const pendingPayload = pendingPayments.get(walletHash);
      
      
      if (pendingPayload) {
        // Check for tier selection first
        if (pendingPayload.step === 'tier_select' && pendingPayload.tiers && pendingPayload.tiers.length > 0) {
          const userInput = lastContent.trim();
          let selectedIndex = -1;
          
          // Try to parse user input as a number (1-based)
          const num = parseInt(userInput, 10);
          if (!isNaN(num) && num >= 1 && num <= pendingPayload.tiers.length) {
            selectedIndex = num - 1;
          } else {
            // Try to match by duration minutes
            for (let i = 0; i < pendingPayload.tiers.length; i++) {
              if (userInput === String(pendingPayload.tiers[i].minutes) ||
                  userInput === pendingPayload.tiers[i].minutes + ' minutes' ||
                  userInput === pendingPayload.tiers[i].minutes + ' min') {
                selectedIndex = i;
                break;
              }
            }
          }
          
          if (selectedIndex >= 0) {
            const selectedTier = pendingPayload.tiers[selectedIndex];
            pendingPayload.durationMinutes = selectedTier.minutes;
            pendingPayload.step = 'processing';
            
            log('Tier selected: ' + selectedTier.minutes + ' min for wallet ' + walletHash?.substring(0, 16) + '...');
            
            // Build extra headers for payment wrapper
            const extraHeaders = {};
            if (pendingPayload.modelId) {
              extraHeaders['X-Model-Id'] = pendingPayload.modelId;
            }
            extraHeaders['X-Duration-Minutes'] = String(selectedTier.minutes);
            
            runPaytacaPay(BACKEND_URL + '/v1', pendingPayload.body, walletHash, extraHeaders, (err, responseJson) => {
              pendingPayments.delete(walletHash);
              
              if (err) {
                log('paytaca pay failed: ' + err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  error: 'Payment failed', 
                  message: err.message,
                  details: 'Please check your wallet balance and try again.'
                }));
                return;
              }
              
              if (!responseJson.success) {
                res.writeHead(responseJson.status || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  error: 'Payment failed', 
                  message: responseJson.error,
                  details: 'Payment was not successful. Please check your balance and try again.'
                }));
                return;
              }
              
              const chatCompletion = responseJson?.data || responseJson;
              
              let wasStreaming = false;
              try {
                wasStreaming = JSON.parse(pendingPayload.body).stream === true;
              } catch {}
              
              log('paytaca pay succeeded. Returning chat response.');
              
              if (wasStreaming) {
                try {
                  jsonToSse(res, chatCompletion);
                } catch (e) {}
              } else {
                try {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(chatCompletion));
                } catch (e) {}
              }
            });
            return;
          } else {
            // Invalid selection — reshow the prompt
            log('Invalid tier selection for wallet ' + walletHash?.substring(0, 16) + '...');
            await streamTierSelectionPrompt(res, walletHash, pendingPayload.displayName || pendingPayload.modelId || 'AI Model', pendingPayload.tiers);
            return;
          }
        }
        
        // Old flow: user responded to a yes/no payment prompt
        if (lastContent === 'yes') {
          log('Payment approved by wallet ' + walletHash?.substring(0, 16) + '...');
          pendingPayments.delete(walletHash);
          
          const extraHeaders = {};
          if (pendingPayload.modelId) {
            extraHeaders['X-Model-Id'] = pendingPayload.modelId;
          }
          if (pendingPayload.durationMinutes) {
            extraHeaders['X-Duration-Minutes'] = String(pendingPayload.durationMinutes);
          }
          
          runPaytacaPay(BACKEND_URL + '/v1', pendingPayload.body, walletHash, extraHeaders, (err, responseJson) => {
            if (err) {
              log('paytaca pay failed: ' + err.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                error: 'Payment failed', 
                message: err.message,
                details: 'Please check your wallet balance and try again.'
              }));
              return;
            }
            
            if (!responseJson.success) {
              res.writeHead(responseJson.status || 500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                error: 'Payment failed', 
                message: responseJson.error,
                details: 'Payment was not successful. Please check your balance and try again.'
              }));
              return;
            }
            
            const chatCompletion = responseJson?.data || responseJson;
            
            let wasStreaming = false;
            try {
              wasStreaming = JSON.parse(pendingPayload.body).stream === true;
            } catch {}
            
            log('paytaca pay succeeded. Returning chat response.');
            
            if (wasStreaming) {
              try {
                jsonToSse(res, chatCompletion);
              } catch (e) {}
            } else {
              try {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(chatCompletion));
              } catch (e) {}
            }
          });
          return;
          
        } else if (lastContent === 'no') {
          log('Payment declined by wallet ' + walletHash?.substring(0, 16) + '...');
          pendingPayments.delete(walletHash);

          const addr = await getReceivingAddress();
          const fundMsg = addr
            ? 'Fund your wallet: ' + addr
            : 'You can fund your wallet by running: paytaca receive';

          const declineCompletion = {
            id: 'payment-declined',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: pendingPayload.modelId || 'deepseek-ai/DeepSeek-V4-Flash',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'Payment declined. Chat cannot continue without funding.\\n\\n' + fundMsg,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          jsonToSse(res, declineCompletion);
          return;
          
        } else {
          log('New message while payment pending for wallet ' + walletHash?.substring(0, 16) + '...');
        }
      }
      
      let isStreaming = true;
      try { isStreaming = JSON.parse(body).stream !== false; } catch {}

      const handleResponse = async (err, statusCode, headers, responseBody) => {
        if (err) {
          if (!res.headersSent) {
            log('Django connection error: ' + err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Backend unavailable', details: err.message }));
          }
          return;
        }

        if (statusCode === 402) {
          log('402 intercepted for wallet ' + walletHash?.substring(0, 16) + '...');
          
          // Parse 402 response for model_id and price_tiers
          let modelId = null;
          let displayName = null;
          let tiers = null;
          try {
            const parsed = JSON.parse(responseBody);
            modelId = parsed.model_id || null;
            displayName = parsed.display_name || null;
            tiers = parsed.price_tiers || null;
          } catch (e) {
            log('Could not parse 402 body: ' + e.message);
          }
          
          pendingPayments.set(walletHash, {
            body: body,
            modelId: modelId,
            durationMinutes: null,
            tiers: tiers,
            step: tiers ? 'tier_select' : 'approval'
          });
          
          if (tiers && tiers.length > 0) {
            // New flow: show tier selection prompt
            await streamTierSelectionPrompt(res, walletHash, displayName || modelId || 'AI Model', tiers);
            return;
          }
          
          // Check session status to determine if this is a renewal
          let isRenewal = false;
          let tokensUsed = 0;
          let tokenLimit = 50000;
          let timeRemainingSeconds = 0;
          
          let statusModelId = modelId;
          try {
            // Extract model from the original request body if not in 402
            if (!statusModelId) {
              try {
                const bodyParsed = JSON.parse(body);
                statusModelId = bodyParsed.model || null;
              } catch (e) {}
            }
            
            const statusPath = '/v1/wallet/status' + (statusModelId ? '?model_id=' + encodeURIComponent(statusModelId) : '');
            const statusResponse = await new Promise((resolve, reject) => {
              const statusReq = REQUester.get({
                hostname: DJANGO_HOST,
                port: DJANGO_PORT,
                path: statusPath,
                headers: { 'X-Wallet-Hash': walletHash }
              }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                  try {
                    resolve(JSON.parse(data));
                  } catch {
                    resolve({});
                  }
                });
              });
              statusReq.on('error', reject);
              statusReq.setTimeout(5000, () => reject(new Error('timeout')));
            });
            
            if (statusResponse) {
              tokensUsed = statusResponse.tokens_used || 0;
              tokenLimit = statusResponse.token_limit || 50000;
              timeRemainingSeconds = statusResponse.time_remaining_seconds || 0;
              
              // Renewal if session has been used (tokens > 0 or time > 0) but is now exhausted
              isRenewal = (tokensUsed > 0 || statusResponse.time_used_seconds > 0) &&
                          (!statusResponse.session_active || timeRemainingSeconds <= 0);
            }
          } catch (err) {
            log('Failed to check session status: ' + err.message);
          }
          
          await streamPaymentPrompt(res, walletHash, isRenewal, tokensUsed, tokenLimit, timeRemainingSeconds);
        } else {
          if (res.headersSent) {
            log('Streaming response completed and already sent');
            pendingPayments.delete(walletHash);
            return;
          }

          log('Forwarding normal response to OpenCode: status=' + statusCode + ', bodyLen=' + responseBody.length);
          pendingPayments.delete(walletHash);
          res.writeHead(statusCode, {
            'Content-Type': headers['content-type'] || 'application/json',
          });
          res.end(responseBody);
        }
      };

      if (isStreaming) {
        forwardStreaming(req, res, body, handleResponse);
      } else {
        forwardToDjango(req, body, handleResponse);
      }
      
    } catch (err) {
      log('Error: ' + err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal proxy error' }));
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('Port ' + PROXY_PORT + ' is already in use. Another proxy instance may be running.');
    log('Exiting cleanly (code 0) so the plugin can detect the existing proxy.');
    process.exit(0);
  }
  log('Server error: ' + err.message);
  process.exit(1);
});

server.listen(PROXY_PORT, () => {
  log('Paytaca AI Proxy running on http://localhost:' + PROXY_PORT);
  log('Forwarding to Django at ' + BACKEND_URL);
  log('Discovery: http://localhost:' + PROXY_PORT + '/v1/config');
  log('Managed by OpenCode plugin');
});

// Start heartbeat checker after server is created
heartbeatChecker = setInterval(() => {
  if (!checkHeartbeat()) {
    clearInterval(heartbeatChecker);
    log('Closing server due to missing heartbeat');
    server.close(() => {
      process.exit(0);
    });
    // Force exit after 2 seconds if graceful shutdown fails
    setTimeout(() => process.exit(0), 2000);
  }
}, 5000);

// Graceful shutdown
process.on('SIGTERM', () => {
  log('Shutting down proxy...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('Shutting down proxy...');
  server.close(() => process.exit(0));
});
`;
