"use strict";
// This file contains the bundled payment wrapper script as a string
// It gets written to ~/.opencode-paytaca/paytaca-pay-wrapper.mjs at runtime
// Uses the same approach as the original wrapper but finds paytaca-cli dynamically
Object.defineProperty(exports, "__esModule", { value: true });
exports.WRAPPER_SCRIPT_CONTENT = void 0;
exports.WRAPPER_SCRIPT_CONTENT = `#!/usr/bin/env node
/**
 * Paytaca Pay Wrapper — handles large request bodies by reading from a file.
 * Imports paytaca-cli modules directly (avoids CLI argument size limits).
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Find paytaca-cli installation
function findPaytacaCliPath() {
  const possiblePaths = [];
  
  // Try to get global npm root
  try {
    const globalPath = execSync('npm root -g', { encoding: 'utf8' }).trim();
    possiblePaths.push(
      join(globalPath, 'paytaca-cli'),
      join(globalPath, 'opencode-plugin', 'node_modules', 'paytaca-cli'),
    );
  } catch {}
  
  // Common global locations
  possiblePaths.push(
    '/usr/lib/node_modules/paytaca-cli',
    '/usr/local/lib/node_modules/paytaca-cli',
    '/opt/homebrew/lib/node_modules/paytaca-cli',
  );
  
  // Try current file's node_modules (for bundled installs)
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);
    possiblePaths.push(
      join(currentDir, '..', 'node_modules', 'paytaca-cli'),
      join(currentDir, '..', '..', 'node_modules', 'paytaca-cli'),
    );
  } catch {}
  
  // Find first valid path
  for (const basePath of possiblePaths) {
    try {
      const walletPath = join(basePath, 'dist', 'wallet', 'index.js');
      readFileSync(walletPath);
      return basePath;
    } catch {}
  }
  
  throw new Error('paytaca-cli not found. Please install: npm install -g paytaca-cli');
}

// Load paytaca-cli modules
let loadMnemonic, loadWallet, LibauthHDWallet, X402Payer, parsePaymentRequiredJson, selectBchPaymentRequirements, BCH_DERIVATION_PATH;

try {
  const basePath = findPaytacaCliPath();
  
  ({ loadMnemonic, loadWallet } = await import(join(basePath, 'dist', 'wallet', 'index.js')));
  ({ LibauthHDWallet } = await import(join(basePath, 'dist', 'wallet', 'keys.js')));
  ({ X402Payer } = await import(join(basePath, 'dist', 'wallet', 'x402.js')));
  ({ parsePaymentRequiredJson, selectBchPaymentRequirements } = await import(join(basePath, 'dist', 'utils', 'x402.js')));
  ({ BCH_DERIVATION_PATH } = await import(join(basePath, 'dist', 'utils', 'network.js')));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: 'Failed to load paytaca-cli: ' + err.message }));
  process.exit(1);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.log(JSON.stringify({ success: false, error: 'Usage: node paytaca-pay-wrapper.mjs <config.json>' }));
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const { url, method, headers, bodyFile, chipnet, confirmed } = config;

  const body = readFileSync(bodyFile, 'utf8');

  const data = loadMnemonic();
  if (!data) {
    console.log(JSON.stringify({ success: false, error: 'No wallet found. Run paytaca wallet create first.' }));
    process.exit(1);
  }

  const wallet = loadWallet();
  const isChipnet = Boolean(chipnet);
  const bchWallet = wallet.forNetwork(isChipnet);
  const hdWallet = new LibauthHDWallet(data.mnemonic, BCH_DERIVATION_PATH, isChipnet ? 'chipnet' : 'mainnet');
  const x402Payer = new X402Payer({ hdWallet, addressIndex: 0 });

  try {
    const result = await executePay(url, method, headers, body, bchWallet, x402Payer, isChipnet, confirmed);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message || String(err) }, null, 2));
    process.exit(1);
  }
}

async function executePay(url, method, headers, body, bchWallet, x402Payer, isChipnet, confirmed) {
  const response = await fetch(url, {
    method,
    headers,
    body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
  });

  const responseHeaders = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  const responseText = await response.text();
  let responseData;
  try { responseData = JSON.parse(responseText); } catch { responseData = responseText; }

  if (response.status === 402) {
    const paymentRequired = parsePaymentRequiredJson(responseData);
    if (!paymentRequired) {
      return { success: false, status: 402, error: 'Could not parse PaymentRequired from 402 response body' };
    }
    const requirements = selectBchPaymentRequirements(paymentRequired, isChipnet ? 'chipnet' : 'mainnet');
    if (!requirements) {
      return {
        success: false, status: 402, error: 'Server does not accept BCH payment',
        data: { acceptedSchemes: paymentRequired.accepts.map(a => ({ scheme: a.scheme, network: a.network })) },
      };
    }

    const payerAddress = x402Payer.getPayerAddress();
    const address = requirements.payTo;
    const amountBch = Number(requirements.amount) / 1e8;
    const changeAddressSet = bchWallet.getAddressSetAt(0);
    const changeAddress = changeAddressSet.change;

    if (!confirmed) {
      return {
        success: false, status: 402, error: 'Payment not confirmed.',
        payment: { required: true, amount: requirements.amount, payTo: address },
      };
    }

    const sendResult = await bchWallet.sendBch(amountBch, address, changeAddress);
    if (!sendResult.success) {
      return { success: false, status: 402, payment: { required: true, error: sendResult.error }, error: sendResult.error };
    }

    const txid = sendResult.txid;
    const paymentPayload = await x402Payer.createPaymentPayload(requirements, paymentRequired.resource.url, txid, 0, requirements.amount);
    headers['PAYMENT-SIGNATURE'] = JSON.stringify(paymentPayload);

    const retryResponse = await fetch(url, {
      method,
      headers,
      body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
    });
    const retryResponseHeaders = {};
    retryResponse.headers.forEach((value, key) => { retryResponseHeaders[key] = value; });
    const retryResponseText = await retryResponse.text();
    let retryResponseData;
    try { retryResponseData = JSON.parse(retryResponseText); } catch { retryResponseData = retryResponseText; }

    return {
      success: retryResponse.ok,
      status: retryResponse.status,
      statusText: retryResponse.statusText,
      headers: retryResponseHeaders,
      data: retryResponseData,
      payment: { required: true, txid, recipientAddress: address },
    };
  }

  return {
    success: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    data: responseData,
    payment: { required: false },
  };
}

main();
`;
//# sourceMappingURL=wrapper.js.map