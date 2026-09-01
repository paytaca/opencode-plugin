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

// Store pending payment requests per wallet hash
// Each entry: { body, modelId, displayName, durationMinutes, tiers[], step }
// step: 'tier_select' (user must pick a tier) or 'approval' (yes/no)
const pendingPayments = new Map();

// Monotonic id per incoming request. A response may only clear the pending
// payment created by its own request — concurrent requests from opencode share
// the wallet hash, and a plain 200 finishing mid-payment must not clobber the
// pending entry another request just created (that made tier selections
// "2"/"3" fall through to a fresh 402 and re-show the prompt forever).
let requestCounter = 0;

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

// SSE helper: write a data line
function sseLine(res, data) {
  res.write('data: ' + JSON.stringify(data) + '\\n\\n');
}

// SSE helper: write [DONE]
function sseDone(res) {
  res.write('data: [DONE]\\n\\n');
}

// Zero-width marker prepended to every synthetic proxy message (tier
// prompts, credits/plans output, payment notices). The opencode plugin
// strips marker-carrying assistant messages from LLM context — proxy chatter
// is not relevant to the coding session — while the user still sees them in
// the UI (zero-width characters don't render).
const PROXY_MARKER = String.fromCharCode(0x200b, 0x200b, 0x200b, 0x200b);

// Stream the tier-selection prompt body (SSE lines) into an in-progress response.
// When includeRole is false the leading role delta is skipped, so the body can be
// appended to a stream that already emitted content (e.g. after a payment failure).
async function streamTierSelectionBody(res, walletHash, modelName, tiers, includeRole) {
  if (includeRole !== false) {
    sseLine(res, {
      id: 'tier-1',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  }

  // Loading sequence
  sseLine(res, {
    id: 'tier-2',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: PROXY_MARKER + '⏳ Initializing Paytaca AI provider...\\n' }, finish_reason: null }],
  });

  const hasCli = await checkPaytacaCli();
  sseLine(res, {
    id: 'tier-3',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'Checking Paytaca CLI... ' }, finish_reason: null }],
  });
  sseLine(res, {
    id: 'tier-4',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: hasCli ? '✅\\n' : '❌ Not found\\n' }, finish_reason: null }],
  });

  const hasWallet = hasCli ? await checkWallet() : false;
  sseLine(res, {
    id: 'tier-5',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'Checking wallet... ' }, finish_reason: null }],
  });
  sseLine(res, {
    id: 'tier-6',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: hasWallet ? '✅\\n' : '❌ Not found\\n' }, finish_reason: null }],
  });

  const balanceSats = hasWallet ? await getWalletBalance() : null;
  sseLine(res, {
    id: 'tier-7',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'Fetching balance... ' }, finish_reason: null }],
  });

  let balanceStr;
  if (balanceSats !== null) {
    const bch = (balanceSats / 100000000).toFixed(8);
    balanceStr = bch + ' BCH';
    sseLine(res, {
      id: 'tier-8',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '✅ — ' + balanceStr + '\\n\\n' }, finish_reason: null }],
    });
  } else {
    balanceStr = 'Unable to check';
    sseLine(res, {
      id: 'tier-8',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '\\n' + balanceStr + '\\n\\n' }, finish_reason: null }],
    });
  }

  // Tier selection
  sseLine(res, {
    id: 'tier-9',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '💳 Select a plan for **' + (modelName || 'AI Model') + '**\\n\\n' }, finish_reason: null }],
  });

  // Build all tier lines into one string so backtick markdown renders
  // consistently (same as the 'plans' command).
  let tiersContent = '';
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const bchAmount = (tier.price_sats / 100000000).toFixed(8);
    const label = '\`(' + String(i + 1) + ')\`  ';
    // Display USD price if available, fall back to PHP for legacy backends
    const priceDisplay = tier.price_usd !== undefined && tier.price_usd !== null
      ? 'USD ' + tier.price_usd.toFixed(4)
      : 'PHP ' + (tier.price_php ? tier.price_php.toFixed(2) : '?.??');
    tiersContent += label + tier.minutes + ' minutes — ' + priceDisplay + ' (' + bchAmount + ' BCH)\\n';
  }
  sseLine(res, {
    id: 'tier-10',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: tiersContent }, finish_reason: null }],
  });

  sseLine(res, {
    id: 'tier-11',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '\\nEnter a number (1-' + tiers.length + '), e.g. type ' + tiers[0].minutes + ':' }, finish_reason: 'stop' }],
  });

  sseLine(res, {
    id: 'tier-12',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// Build and stream a full tier-selection prompt (headers + body + [DONE]) to the client.
async function streamTierSelectionPrompt(res, walletHash, modelName, tiers) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Payment-Required': 'true',
      'Connection': 'keep-alive',
    });
  }
  await streamTierSelectionBody(res, walletHash, modelName, tiers, true);
  sseDone(res);
  res.end();
}

// Build and stream SSE loading sequence + payment prompt
// Stream SSE notice when the upstream (OpenRouter) account lacks balance to fund
// the request. Replaces the old single-tier yes/no approval prompt.
async function streamLowBalanceNotice(res, modelName) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Payment-Required': 'true',
    'Connection': 'keep-alive',
  });

  sseLine(res, {
    id: 'lb-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelName || 'AI Model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  sseLine(res, {
    id: 'lb-2',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: PROXY_MARKER + '⚠️ OpenRouter balance is low — please top up before continuing.\\n' }, finish_reason: 'stop' }],
  });

  sseLine(res, {
    id: 'lb-3',
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

  let timeoutCleared = false;
  const djangoReq = REQUester.request(options, (djangoRes) => {
    // Response started; clear the connect/first-byte timeout so slow streams aren't killed.
    if (!timeoutCleared) {
      djangoReq.clearTimeout();
      timeoutCleared = true;
    }

    let responseBody = '';
    djangoRes.on('data', chunk => { responseBody += chunk; });
    djangoRes.on('end', () => {
      const elapsed = Date.now() - startTime;
      log('Django responded in ' + elapsed + 'ms: status=' + djangoRes.statusCode + ', bodyLen=' + responseBody.length);
      callback(null, djangoRes.statusCode, djangoRes.headers, responseBody);
    });
  });

  djangoReq.setTimeout(300000, () => {
    djangoReq.destroy();
    callback(new Error('Django request timed out after 300s'));
  });

  djangoReq.on('error', (err) => {
    if (!timeoutCleared) {
      djangoReq.clearTimeout();
      timeoutCleared = true;
    }
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

  let timeoutCleared = false;
  const djangoReq = REQUester.request(options, (djangoRes) => {
    // Response started; clear the connect/first-byte timeout so slow streams aren't killed.
    if (!timeoutCleared) {
      djangoReq.clearTimeout();
      timeoutCleared = true;
    }

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

    if (res.socket) {
      res.socket.setNoDelay(true);
    }

    // Buffer SSE data at event boundaries and inject keepalive between events.
    let sseBuffer = '';
    let lastActivity = Date.now();
    let streamingDone = false;
    let doneForwarded = false;

    // Watchdog: inject keepalive only when buffer is empty (between complete events)
    const keepaliveTimer = setInterval(() => {
      if (streamingDone || res.writableEnded || res.destroyed) {
        clearInterval(keepaliveTimer);
        return;
      }
      const now = Date.now();
      if (now - lastActivity >= 2000 && sseBuffer.length === 0) {
        try {
          res.write(': keepalive\\n\\n');
          lastActivity = now;
        } catch (err) {
          log('Keepalive write error: ' + err.message);
          clearInterval(keepaliveTimer);
        }
      }
    }, 500);

    const cleanup = () => {
      streamingDone = true;
      clearInterval(keepaliveTimer);
    };

    var diagCounter = 0;
    djangoRes.on('data', (chunk) => {
      var chunkStr = chunk.toString();
      var chunkIdx = ++diagCounter;
      sseBuffer += chunkStr;
      lastActivity = Date.now();

      var okCount = (sseBuffer.match(/:ok/g) || []).length;
      if (okCount > 0) {
        log('CHUNK#' + chunkIdx + ': ' + okCount + ' :ok in buffer (len=' + sseBuffer.length + ')');
      }

      // Strip upstream SSE ":ok" keepalive comments from anywhere in the buffer.
      sseBuffer = sseBuffer.replace(/:ok(?:\\n)?/g, '');
      if (okCount > 0) {
        log('AFTER: stripped ' + okCount + ' :ok, buffer len=' + sseBuffer.length);
      }

      var extractedCount = 0;
      let idx;
      while ((idx = sseBuffer.indexOf('\\n\\n')) !== -1) {
        const event = sseBuffer.substring(0, idx + 2);
        sseBuffer = sseBuffer.substring(idx + 2);
        const lines = event.split('\\n').filter(l => !/^:/.test(l) && l.length > 0);
        if (lines.length === 0) continue;
        const cleanEvent = lines.join('\\n') + '\\n\\n';
        extractedCount++;
        var dataContent = lines.map(function(l) { return l.replace(/^data: ?/, ''); }).join('');
        if (dataContent === '[DONE]') { doneForwarded = true; }
        var lastChar = dataContent.slice(-1);
        if (dataContent !== '[DONE]' && lastChar !== '}' && lastChar !== ']') {
          log('FLUSH: truncated event #' + extractedCount + ' (len=' + dataContent.length + ', end=' + JSON.stringify(dataContent.slice(-30)) + ')');
        }
        try {
          res.write(cleanEvent);
        } catch (err) {
          cleanup();
          log('Write error: ' + err.message);
          return;
        }
      }
      if (extractedCount > 0) {
        log('EXTRACT: forwarded ' + extractedCount + ' events in chunk#' + chunkIdx + ', buffer remaining len=' + sseBuffer.length);
      }
    });

    djangoRes.on('end', () => {
      if (streamingDone) {
        return;
      }
      sseBuffer = sseBuffer.replace(/:ok(?:\\n)?/g, '');
      if (sseBuffer) {
        // Ensure the final written data ends with \\n\\n so the client recognizes the event boundary
        if (sseBuffer.length < 2 || sseBuffer.substring(sseBuffer.length - 2) !== '\\n\\n') {
          sseBuffer += '\\n\\n';
        }
        log('END: writing remaining buffer len=' + sseBuffer.length + ' start=' + JSON.stringify(sseBuffer.substring(0, 80)));
        try { res.write(sseBuffer); } catch (e) {}
      }
      if (!doneForwarded) {
        log('Injecting [DONE] — upstream closed without sending it');
        try { res.write('data: [DONE]\\n\\n'); } catch (e) {}
      }
      cleanup();
      try { res.end(); } catch (e) {}
      log('Streaming response completed' + (doneForwarded ? '' : ' (injected [DONE])'));
      callback(null, djangoRes.statusCode, {}, '');
    });

    djangoRes.on('error', (err) => {
      log('Django stream error: ' + err.message);
      if (!streamingDone) {
        cleanup();
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch (e) {}
      }
      callback(null, 200, {}, '');
    });

    res.on('close', () => {
      cleanup();
      log('Client connection closed');
    });

    res.on('error', (err) => {
      cleanup();
      log('Client connection error: ' + err.message);
    });
  });

  djangoReq.setTimeout(300000, () => {
    djangoReq.destroy();
    callback(new Error('Django streaming request timed out after 300s'));
  });

  djangoReq.on('error', (err) => {
    if (!timeoutCleared) {
      djangoReq.clearTimeout();
      timeoutCleared = true;
    }
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
function jsonToSse(res, chatCompletion, opts) {
  opts = opts || {};
  if (res.destroyed || res.writableEnded) {
    log('jsonToSse: response already destroyed/ended, cannot send SSE');
    return;
  }
  const message = chatCompletion.choices?.[0]?.message || {};
  const content = message.content || '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null;
  const model = chatCompletion.model || chatCompletion.model_id || 'deepseek/deepseek-v4-flash';
  const created = chatCompletion.created || Math.floor(Date.now() / 1000);

  if (!res.headersSent) {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
    } catch (e) {
      log('jsonToSse writeHead failed: ' + e.message);
      return;
    }
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
    log('jsonToSse: failed to write role delta: ' + e.message);
  }

  const allContent = (opts.prependContent || '') + content;
  const chunkSize = 20;
  let chunksWritten = 0;
  for (let i = 0; i < allContent.length; i += chunkSize) {
    try {
      sseLine(res, {
        id: 'chatcmpl-' + (i + 2),
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: allContent.slice(i, i + chunkSize) }, finish_reason: null }],
      });
      chunksWritten++;
    } catch (e) {
      log('jsonToSse: failed to write content chunk ' + (i / chunkSize) + ': ' + e.message);
      break;
    }
  }

  let finishReason = 'stop';
  if (toolCalls && toolCalls.length > 0) {
    const toolCallDeltas = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i] || {};
      const fn = tc.function || {};
      let args = fn.arguments;
      if (args !== undefined && typeof args !== 'string') {
        try { args = JSON.stringify(args); } catch (e) { args = String(args); }
      }
      toolCallDeltas.push({
        index: i,
        id: tc.id || ('call_' + i),
        type: 'function',
        function: {
          name: fn.name || '',
          arguments: args === undefined || args === null ? '' : String(args),
        },
      });
    }
    try {
      sseLine(res, {
        id: 'chatcmpl-tools',
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { tool_calls: toolCallDeltas }, finish_reason: null }],
      });
    } catch (e) {
      log('jsonToSse: failed to write tool_calls: ' + e.message);
    }
    finishReason = 'tool_calls';
  }

  try {
    sseLine(res, {
      id: 'chatcmpl-done',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: chatCompletion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    log('jsonToSse: failed to write final delta: ' + e.message);
  }

  try {
    sseDone(res);
  } catch (e) {
    log('jsonToSse: failed to write [DONE]: ' + e.message);
  }

  try {
    res.end();
  } catch (e) {
    log('jsonToSse: res.end() failed: ' + e.message);
  }
}

// Stream a payment-failure message, then re-show the tier-selection prompt so the
// user can retry the same or a different plan without sending another message.
// The pending payment is restored to the tier-select step so the next tier pick is
// handled by the proxy instead of being forwarded fresh to Django.
async function streamPaymentFailureAndRetry(res, walletHash, pendingPayload, message) {
  try {
    sseLine(res, {
      id: 'pay-err',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek/deepseek-v4-flash',
      choices: [{ index: 0, delta: { content: PROXY_MARKER + message }, finish_reason: 'stop' }],
    });
  } catch (e) {
  }
  pendingPayload.step = 'tier_select';
  pendingPayload.durationMinutes = null;
  pendingPayments.set(walletHash, pendingPayload);
  try {
    const tiers = Array.isArray(pendingPayload.tiers) ? pendingPayload.tiers : [];
    if (tiers.length > 0) {
      await streamTierSelectionBody(res, walletHash, pendingPayload.displayName || pendingPayload.modelId || 'AI Model', tiers, false);
    }
    sseDone(res);
    res.end();
  } catch (e) {
    try { res.end(); } catch (e2) {}
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
      // Try to extract error from stdout (wrapper writes JSON errors to stdout, not stderr)
      let wrapperErr = stderr.trim();
      if (!wrapperErr) {
        try {
          const parsed = JSON.parse(stdout.trim());
          wrapperErr = parsed.error || 'Unknown error';
        } catch {
          wrapperErr = stdout.trim() || 'paytaca pay wrapper exited with code ' + code;
        }
      }
      callback(new Error(wrapperErr));
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

async function handleTimeCreditsCommand(res, walletHash) {
  log('Time command for wallet ' + walletHash?.substring(0, 16) + '...');
  const statusUrl = BACKEND_URL + '/v1/wallet/status';
  const statusRes = await fetch(statusUrl, {
    headers: { 'X-Wallet-Hash': walletHash }
  });
  let content;
  if (statusRes.ok) {
    const statusData = await statusRes.json();
    const sessions = statusData.sessions || [];
    const activeSessions = sessions.filter(s => s.time_remaining_seconds > 0 && s.model_active);
    const inactiveSessions = sessions.filter(s => s.time_remaining_seconds > 0 && !s.model_active);
    const parts = [];
    if (activeSessions.length > 0) {
      parts.push('**⏱️  Active Time Credits:**');
      activeSessions.forEach(s => {
        const total = formatDuration(s.time_credits_seconds);
        const remaining = formatDuration(s.time_remaining_seconds);
        const used = formatDuration(s.time_used_seconds);
        parts.push('  - **' + (s.display_name || s.ai_model) + '** — ' + remaining + ' remaining of ' + total + ' (' + used + ' used)');
      });
    }
    if (inactiveSessions.length > 0) {
      parts.push('\\n**⚠️  Inactive Model:**');
      inactiveSessions.forEach(s => {
        const remaining = formatDuration(s.time_remaining_seconds);
        parts.push('  - **' + (s.display_name || s.ai_model) + ' (Inactive)** — ' + remaining + ' remaining');
      });
    }
    content = parts.length > 0 ? parts.join('\\n') : '⏱️  No active time credits.';
  } else {
    content = '⏱️  Unable to check time credits.';
  }

  sseLine(res, {
    id: 'time-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek/deepseek-v4-flash',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  sseLine(res, {
    id: 'time-2',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: PROXY_MARKER + content + '\\n' }, finish_reason: 'stop' }],
  });
  sseLine(res, {
    id: 'time-3',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  sseDone(res);
  res.end();
}

const isTimeCmd = (s) => s === 'credits';
const isPricingCmd = (s) => s === 'plans';

// List all models grouped by tier (Budget / Premium / Frontier / Other) with prices
async function handlePricingCommand(res) {
  log('Pricing command requested');
  let content;
  try {
    const configRes = await fetch(BACKEND_URL + '/v1/config');
    if (!configRes.ok) {
      throw new Error('config status ' + configRes.status);
    }
    const config = await configRes.json();
    const models = Array.isArray(config.models) ? config.models : [];
    const groups = { budget: [], premium: [], frontier: [], other: [] };
    for (const m of models) {
      const key = String(m.tier || '').toLowerCase();
      const groupKey = (key === 'budget' || key === 'premium' || key === 'frontier') ? key : 'other';
      groups[groupKey].push(m);
    }
    const lines = ['📋 Paytaca AI — Model Pricing'];
    const order = [
      { key: 'budget', label: 'Budget' },
      { key: 'premium', label: 'Premium' },
      { key: 'frontier', label: 'Frontier' },
      { key: 'other', label: 'Other' },
    ];
    let any = false;
    for (const g of order) {
      if (groups[g.key].length === 0) continue;
      any = true;
      lines.push('');
      lines.push(g.label);
      for (const m of groups[g.key]) {
        lines.push('');
        const tiers = Array.isArray(m.price_tiers) ? m.price_tiers : [];
        if (tiers.length === 0) {
          lines.push('- **' + (m.display_name || m.id) + '**: — no pricing configured');
          continue;
        }
        const sorted = tiers.slice().sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
        lines.push('**' + (m.display_name || m.id) + '**:');
        sorted.forEach((t, i) => {
          const sats = typeof t.price_sats === 'number' ? t.price_sats : 0;
          const bch = (sats / 100000000).toFixed(8);
          const usd = typeof t.price_usd === 'number' ? t.price_usd.toFixed(4) : '?.??';
          lines.push('  \`(' + String(i + 1) + ')\`  ' + (t.minutes || 0) + ' minutes — USD ' + usd + ' (' + bch + ' BCH)');
        });
      }
    }
    if (!any) {
      lines.push('');
      lines.push('No models available.');
    }
    content = lines.join('\\n');
  } catch (err) {
    log('Pricing command failed: ' + err.message);
    content = '📋 Unable to fetch pricing.';
  }

  sseLine(res, {
    id: 'price-1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek/deepseek-v4-flash',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  sseLine(res, {
    id: 'price-2',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: PROXY_MARKER + content + '\\n' }, finish_reason: 'stop' }],
  });
  sseLine(res, {
    id: 'price-3',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  sseDone(res);
  res.end();
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
      default_model: 'deepseek/deepseek-v4-flash',
      default_duration_minutes: 30,
      models: [
        {
          id: 'deepseek/deepseek-v4-flash',
          object: 'model',
          display_name: 'DeepSeek V4 Flash',
          provider: 'openrouter',
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
      const proxyReqId = ++requestCounter;
      const lastContent = getLastUserMessageContent(body);
      
      log('Request received: wallet=' + (walletHash?.substring(0, 16) || 'none') + '..., bodyLen=' + body.length + ', pending=' + pendingPayments.has(walletHash));
      
      const stripSysRem = (s) => { let r = (s || ''), a = '<system-reminder>', b = '</system-reminder>', i = r.indexOf(a); while (i !== -1) { let j = r.indexOf(b, i); if (j === -1) break; r = r.substring(0, i) + r.substring(j + b.length); i = r.indexOf(a); } return r.trim(); };
      
      // Guard: wallet hash is required for payment flow
      if (!walletHash) {
        const redactedHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          redactedHeaders[k] = /authorization|payment-signature|api-?key|secret|token/i.test(lk)
            ? '<redacted>'
            : v;
        }
        log('MISSING X-Wallet-Hash. Received headers: ' + JSON.stringify(redactedHeaders));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'X-Wallet-Hash header missing',
          message: 'The X-Wallet-Hash header was not sent by the client. It is injected by the paytaca opencode plugin (provider options.headers / chat.headers). Reinstall or restart the plugin, or run paytaca wallet info and verify the plugin loaded.',
        }));
        return;
      }
      
      // Check if there's a pending payment for this wallet
      var pendingPayload = pendingPayments.get(walletHash);
      
      // If there's a pending payment for a different model, clear it so the
      // new request can be forwarded fresh to Django.  This prevents the
      // proxy from re-showing a stale payment prompt when the user switches
      // to a different model mid-conversation.
      if (pendingPayload) {
        var reqModel = '';
        try { reqModel = JSON.parse(body).model || ''; } catch (e) {}
        if (reqModel && pendingPayload.modelId && reqModel !== pendingPayload.modelId) {
          pendingPayments.delete(walletHash);
          pendingPayload = null;
        }
      }
      
      if (pendingPayload) {
        // Check for tier selection first
        if (pendingPayload.step === 'tier_select' && pendingPayload.tiers && pendingPayload.tiers.length > 0) {
          const userInput = stripSysRem(lastContent);
          const timeCmd = userInput?.trim().toLowerCase();
          if (isTimeCmd(timeCmd)) {
            await handleTimeCreditsCommand(res, walletHash);
            return;
          }
          if (isPricingCmd(timeCmd)) {
            await handlePricingCommand(res);
            return;
          }
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
            
            // Check wallet balance before attempting payment
            const currentBalanceSats = await getWalletBalance();
            if (currentBalanceSats !== null && selectedTier.price_sats && currentBalanceSats < selectedTier.price_sats) {
              log('Insufficient balance for wallet ' + walletHash?.substring(0, 16) + '...: ' + currentBalanceSats + ' sats < ' + selectedTier.price_sats + ' sats needed');
              pendingPayments.delete(walletHash);
              const addr = await getReceivingAddress();
              const neededBch = (selectedTier.price_sats - currentBalanceSats) / 100000000;
              const neededLine = addr ? '\\n\\n📥 **Fund your wallet:** \\\`' + addr + '\\\`\\nOr run: paytaca receive (in another terminal) for QR code' : '';
              sseLine(res, {
                id: 'balance-err',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: PROXY_MARKER + '\\n\\n❌ **Insufficient balance** — You have **' + (currentBalanceSats / 100000000).toFixed(8) + ' BCH** but need **' + (selectedTier.price_sats / 100000000).toFixed(8) + ' BCH** for this plan. Top up at least **' + neededBch.toFixed(8) + ' BCH** more.' + neededLine + '\\n\\nType \\\`balance\\\` to re-check or try a different plan:' }, finish_reason: 'stop' }],
              });
              sseLine(res, {
                id: 'balance-err-done',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              });
              sseDone(res);
              res.end();
              return;
            }
            
            // Keepalive during payment processing
            if (!res.headersSent) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Payment-Processing': 'true',
              });
            }
            const keepalive = setInterval(() => {
              if (res.destroyed || res.writableEnded) { clearInterval(keepalive); return; }
              res.write(': keepalive\\n\\n');
            }, 2000);

            runPaytacaPay(BACKEND_URL + '/v1', pendingPayload.body, walletHash, extraHeaders, async (err, responseJson) => {
              pendingPayments.delete(walletHash);
              clearInterval(keepalive);

              if (err) {
                log('paytaca pay failed: ' + err.message);
                if (res.headersSent && !res.destroyed && !res.writableEnded) {
                  await streamPaymentFailureAndRetry(res, walletHash, pendingPayload, '\\n\\n❌ Payment failed: ' + err.message + '\\n\\n');
                } else if (!res.headersSent) {
                  try {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Payment failed', message: err.message, details: 'Please check your wallet balance and try again.' }));
                  } catch (e) { log('Failed to send payment error response: ' + e.message); }
                } else {
                  log('Cannot send payment failure — response already ended or destroyed');
                }
                return;
              }
              
              if (!responseJson.success) {
                const isTimeout = responseJson.timeout;
                const sseContent = isTimeout ? '\\n\\n⏱️ Response timed out. Your payment was processed \\u2014 check credits with \\'credits\\' and try again' : '\\n\\n❌ Payment failed: ' + (responseJson.error || 'Unknown error') + '\\n\\n';
                const errLabel = isTimeout ? 'Response timeout' : 'Payment failed';
                const errMsg = isTimeout ? 'Response timed out. Payment was processed.' : responseJson.error;
                const errDetails = isTimeout ? 'Try again or check credits with \\'credits\\'.' : 'Please check your balance and try again.';
                if (res.headersSent && !res.destroyed && !res.writableEnded) {
                  if (isTimeout) {
                    try {
                      sseLine(res, { id: 'pay-err', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'deepseek/deepseek-v4-flash', choices: [{ index: 0, delta: { content: PROXY_MARKER + sseContent }, finish_reason: 'stop' }] });
                      sseLine(res, { id: 'pay-err-done', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                      sseDone(res);
                      res.end();
                    } catch (e) { log('Failed to send timeout error via SSE: ' + e.message); }
                  } else {
                    await streamPaymentFailureAndRetry(res, walletHash, pendingPayload, sseContent);
                  }
                } else if (!res.headersSent) {
                  try {
                    res.writeHead(responseJson.status || 500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: errLabel, message: errMsg, details: errDetails }));
                  } catch (e) { log('Failed to send payment error JSON: ' + e.message); }
                } else {
                  log('Cannot send payment error — response already ended or destroyed');
                }
                return;
              }
              
              const chatCompletion = responseJson?.data || responseJson;
              
              let wasStreaming = false;
              try {
                wasStreaming = JSON.parse(pendingPayload.body).stream === true;
              } catch {}
              
              log('paytaca pay succeeded. Returning chat response.');
              
              if (res.destroyed || res.writableEnded) {
                log('Payment succeeded but response connection is gone — cannot deliver chat response');
                return;
              }

              if (wasStreaming) {
                try {
                  jsonToSse(res, chatCompletion, { prependContent: '\\n💳 Payment successful — generating your response...\\n\\n' });
                } catch (e) { log('jsonToSse threw: ' + e.message); }
              } else {
                try {
                  if (!res.headersSent) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                  }
                  res.end(JSON.stringify(chatCompletion));
                } catch (e) { log('Failed to send non-streaming response: ' + e.message); }
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
        if (stripSysRem(lastContent) === 'yes') {
          log('Payment approved by wallet ' + walletHash?.substring(0, 16) + '...');
          pendingPayments.delete(walletHash);
          
          const extraHeaders = {};
          if (pendingPayload.modelId) {
            extraHeaders['X-Model-Id'] = pendingPayload.modelId;
          }
          if (pendingPayload.durationMinutes) {
            extraHeaders['X-Duration-Minutes'] = String(pendingPayload.durationMinutes);
          }
          
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Payment-Processing': 'true',
            });
          }
          const keepalive = setInterval(() => {
            if (res.destroyed || res.writableEnded) { clearInterval(keepalive); return; }
            res.write(': keepalive\\n\\n');
          }, 2000);

          runPaytacaPay(BACKEND_URL + '/v1', pendingPayload.body, walletHash, extraHeaders, (err, responseJson) => {
            clearInterval(keepalive);
            if (err) {
              log('paytaca pay failed: ' + err.message);
              if (res.headersSent && !res.destroyed && !res.writableEnded) {
                try {
                  sseLine(res, { id: 'pay-err', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'deepseek/deepseek-v4-flash', choices: [{ index: 0, delta: { content: PROXY_MARKER + '\\n\\n❌ Payment failed: ' + err.message }, finish_reason: 'stop' }] });
                  sseLine(res, { id: 'pay-err-done', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                  sseDone(res);
                  res.end();
                } catch (e) { log('Failed to send payment error via SSE: ' + e.message); }
              } else if (!res.headersSent) {
                try {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Payment failed', message: err.message, details: 'Please check your wallet balance and try again.' }));
                } catch (e) { log('Failed to send payment error JSON: ' + e.message); }
              } else {
                log('Cannot send payment failure — response already ended or destroyed');
              }
              return;
            }
            
            if (!responseJson.success) {
              const isTimeout = responseJson.timeout;
              const sseContent = isTimeout ? '\\n\\n⏱️ Response timed out. Your payment was processed \\u2014 check credits with \\'credits\\' and try again' : '\\n\\n❌ Payment failed: ' + (responseJson.error || 'Unknown error');
              const errLabel = isTimeout ? 'Response timeout' : 'Payment failed';
              const errMsg = isTimeout ? 'Response timed out. Payment was processed.' : responseJson.error;
              const errDetails = isTimeout ? 'Try again or check credits with \\'credits\\'.' : 'Please check your balance and try again.';
              if (res.headersSent && !res.destroyed && !res.writableEnded) {
                try {
                  sseLine(res, { id: 'pay-err', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'deepseek/deepseek-v4-flash', choices: [{ index: 0, delta: { content: PROXY_MARKER + sseContent }, finish_reason: 'stop' }] });
                  sseLine(res, { id: 'pay-err-done', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                  sseDone(res);
                  res.end();
                } catch (e) { log('Failed to send error via SSE: ' + e.message); }
              } else if (!res.headersSent) {
                try {
                  res.writeHead(responseJson.status || 500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: errLabel, message: errMsg, details: errDetails }));
                } catch (e) { log('Failed to send error JSON: ' + e.message); }
              } else {
                log('Cannot send payment error — response already ended or destroyed');
              }
              return;
            }
            
            const chatCompletion = responseJson?.data || responseJson;
            
            let wasStreaming = false;
            try {
              wasStreaming = JSON.parse(pendingPayload.body).stream === true;
            } catch {}
            
            log('paytaca pay succeeded. Returning chat response.');

            if (res.destroyed || res.writableEnded) {
              log('Payment succeeded but response connection is gone — cannot deliver chat response');
              return;
            }
            
            if (wasStreaming) {
              try {
                jsonToSse(res, chatCompletion, { prependContent: '\\n💳 Payment successful — generating your response...\\n\\n' });
              } catch (e) { log('jsonToSse threw: ' + e.message); }
            } else {
              try {
                if (!res.headersSent) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                }
                res.end(JSON.stringify(chatCompletion));
              } catch (e) { log('Failed to send non-streaming response: ' + e.message); }
            }
          });
          return;
          
        } else if (stripSysRem(lastContent) === 'no') {
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
            model: pendingPayload.modelId || 'deepseek/deepseek-v4-flash',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: PROXY_MARKER + 'Payment declined. Chat cannot continue without funding.\\n\\n' + fundMsg,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          jsonToSse(res, declineCompletion);
          return;
          
        } else {
          const innerCmd = stripSysRem(lastContent?.trim().toLowerCase());
          if (isTimeCmd(innerCmd)) {
            await handleTimeCreditsCommand(res, walletHash);
            return;
          }
          if (isPricingCmd(innerCmd)) {
            await handlePricingCommand(res);
            return;
          }
          log('New message while payment pending for wallet ' + walletHash?.substring(0, 16) + '...');
        }
      }
      
      // Handle credits command — show remaining time credits
      const cmd = stripSysRem(lastContent?.trim().toLowerCase());
      if (isTimeCmd(cmd)) {
        await handleTimeCreditsCommand(res, walletHash);
        return;
      }
      // Handle pricing command — show all models grouped by tier
      if (isPricingCmd(cmd)) {
        await handlePricingCommand(res);
        return;
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
          let requestModel = null;
          try { requestModel = JSON.parse(body).model || null; } catch (e) {}
          log('402 intercepted for wallet ' + walletHash?.substring(0, 16)
            + ' x-model-id=' + (req.headers['x-model-id'] || 'null')
            + ' body.model=' + (requestModel || 'null'));
          
          // Parse 402 response for model_id and price_tiers
          let modelId = null;
          let displayName = null;
          let tiers = null;
          try {
            const parsed = JSON.parse(responseBody);
            modelId = parsed.model_id || null;
            displayName = parsed.display_name || null;
            tiers = parsed.price_tiers || null;
            log('402 body: model=' + (modelId || 'null')
              + ' display=' + (displayName || 'null')
              + ' tiers=' + (Array.isArray(tiers) ? tiers.length : String(tiers))
              + ' reason=' + (parsed.reason || 'n/a')
              + ' bodyPrefix=' + responseBody.substring(0, 160).replace(/\\n/g, ' '));
          } catch (e) {
            log('Could not parse 402 body: ' + e.message);
          }
          
          pendingPayments.set(walletHash, {
            reqId: proxyReqId,
            body: body,
            modelId: modelId,
            displayName: displayName,
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
          let statusSnapshot = null;
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
              statusSnapshot = statusResponse;
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
          
          log('402 status model=' + (statusModelId || 'null')
            + ' snapshot=' + JSON.stringify(statusSnapshot)
            + ' isRenewal=' + isRenewal
            + ' timeRemaining=' + timeRemainingSeconds
            + ' tokensUsed=' + tokensUsed
            + ' tokenLimit=' + tokenLimit);
          
          await streamLowBalanceNotice(res, displayName || statusModelId || modelId || 'AI Model');
        } else {
          if (res.headersSent) {
            log('Streaming response completed and already sent');
            const settled = pendingPayments.get(walletHash);
            if (settled && settled.reqId === proxyReqId) {
              pendingPayments.delete(walletHash);
            }
            return;
          }

          log('Forwarding normal response to OpenCode: status=' + statusCode + ', bodyLen=' + responseBody.length);
          const settled = pendingPayments.get(walletHash);
          if (settled && settled.reqId === proxyReqId) {
            pendingPayments.delete(walletHash);
          }
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
  log('Forwarding to ' + BACKEND_URL);
  log('Discovery: http://localhost:' + PROXY_PORT + '/v1/config');
  log('Managed by OpenCode plugin');
});

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
