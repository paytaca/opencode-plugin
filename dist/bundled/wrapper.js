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

// How long to wait for the server to respond before treating the payment as timed out.
// Default 240s so heavy non-streaming generations (large context / long output) can
// complete; override with PAYTACA_PAY_TIMEOUT_MS.
const PAY_TIMEOUT_MS = Number(process.env.PAYTACA_PAY_TIMEOUT_MS || 240000);

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
  
  throw new Error('paytaca-cli not found. Try reinstalling opencode-plugin: npm install @paytaca/opencode-plugin');
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

// Cauldron payment support (opt-in via config.paymentMethod === 'lift').
// The LIFT token is sold in a single swap transaction whose output pays the
// x402 payTo address directly. Uses the same machinery as paytaca-cli's
// "paytaca swap" command, imported via absolute paths because the wrapper runs
// outside any node_modules tree.
const LIFT_TOKEN_ID = process.env.PAYTACA_PAYMENT_TOKEN_ID || '5932b2fd4915d6a75d3ec53282cd49118149a2176ee67ed68b1111ff0786f7fc';
let cauldronLoaded = false;
let fetchPoolsForToken, apiPoolToMicroPool, microPoolToPoolV0, attemptTrade, watchtowerUtxosToSpendableCoins, ExchangeLab, PayoutAmountRuleType, cashAddressToLockingBytecode, binToHex;
try {
  const basePath = findPaytacaCliPath();
  const cauldronDir = join(basePath, 'dist', 'wallet', 'cauldron');
  const cashlabDir = join(basePath, 'node_modules', '@cashlab');
  ({ fetchPoolsForToken } = await import(join(cauldronDir, 'api.js')));
  ({ apiPoolToMicroPool, microPoolToPoolV0 } = await import(join(cauldronDir, 'pools.js')));
  ({ attemptTrade, watchtowerUtxosToSpendableCoins } = await import(join(cauldronDir, 'transact.js')));
  ({ default: ExchangeLab } = await import(join(cashlabDir, 'cauldron', 'out', 'exchange-lab.js')));
  ({ PayoutAmountRuleType } = await import(join(cashlabDir, 'common', 'out', 'constants.js')));
  ({ cashAddressToLockingBytecode, binToHex } = await import(join(cashlabDir, 'common', 'out', 'libauth.js')));
  cauldronLoaded = true;
} catch (err) {
  // Cauldron modules are only needed for LIFT payments; BCH payments still work.
  cauldronLoaded = false;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.log(JSON.stringify({ success: false, error: 'Usage: node paytaca-pay-wrapper.mjs <config.json>' }));
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const { url, method, headers, bodyFile, chipnet, confirmed, paymentMethod } = config;

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
    const result = await executePay(url, method, headers, body, bchWallet, hdWallet, x402Payer, isChipnet, confirmed, paymentMethod);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message || String(err) }, null, 2));
    process.exit(1);
  }
}

// Sell LIFT tokens via Cauldron in a single swap transaction that pays the
// x402 payTo address directly. Returns { txid, vout } for the payment payload.
async function payWithLift(bchWallet, hdWallet, requirements, changeAddress) {
  if (!cauldronLoaded) {
    throw new Error('Cauldron payment modules unavailable. Update paytaca-cli to 0.5.0+ to pay with LIFT.');
  }
  const tokenId = LIFT_TOKEN_ID;
  const amountSats = BigInt(requirements.amount);

  const [apiPools, allUtxos, tokenUtxos] = await Promise.all([
    fetchPoolsForToken(tokenId),
    bchWallet.getUtxos(),
    bchWallet.getUtxos({ category: tokenId }),
  ]);
  if (!apiPools || apiPools.length === 0) {
    throw new Error('No active Cauldron pools for the payment token.');
  }
  const pools = apiPools.map(apiPoolToMicroPool).map(microPoolToPoolV0);

  const tokenBalance = (tokenUtxos || []).reduce((sum, u) => sum + BigInt(u.amount || 0), 0n);
  if (tokenBalance <= 0n) {
    throw new Error('No LIFT tokens in the wallet. Add LIFT to pay this plan with tokens, or pay with BCH.');
  }

  const bchUtxos = allUtxos.filter((utxo) => !utxo.is_cashtoken);
  const spendableCoins = watchtowerUtxosToSpendableCoins({
    utxos: [...bchUtxos, ...(tokenUtxos || [])],
    wallet: hdWallet,
  });
  if (spendableCoins.length === 0) {
    throw new Error('No spendable UTXOs available.');
  }

  const payToDecoded = cashAddressToLockingBytecode(requirements.payTo);
  if (!payToDecoded || typeof payToDecoded === 'string' || !payToDecoded.bytecode) {
    throw new Error('Invalid payment address: ' + requirements.payTo);
  }
  const changeDecoded = cashAddressToLockingBytecode(changeAddress);
  if (!changeDecoded || typeof changeDecoded === 'string' || !changeDecoded.bytecode) {
    throw new Error('Invalid change address: ' + changeAddress);
  }

  const exlab = new ExchangeLab();
  const payoutRules = [
    { type: PayoutAmountRuleType.FIXED, locking_bytecode: payToDecoded.bytecode, amount: amountSats },
    { type: PayoutAmountRuleType.CHANGE, locking_bytecode: changeDecoded.bytecode, allow_mixing_native_and_token: false, allow_mixing_native_and_token_when_bch_change_is_dust: false, add_change_to_txfee_when_bch_change_is_dust: true },
  ];

  // Back-compute the token supply for a demand target slightly above the plan
  // cost so the received BCH covers the fixed payout plus fees (excess becomes
  // change). Retry with a bigger buffer if the first target leaves no change.
  let trade = null;
  let tradeTx = null;
  let lastError = null;
  for (const buffer of [2000n, 20000n, 100000n]) {
    try {
      trade = attemptTrade({ pools, isBuyingToken: false, supply: undefined, demand: amountSats + buffer });
      tradeTx = exlab.createTradeTx(trade.entries, spendableCoins, payoutRules, null, 1n);
      exlab.verifyTradeTx(tradeTx);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!tradeTx) {
    const supply = trade?.summary?.supply;
    if (supply && tokenBalance < supply) {
      throw new Error('Insufficient LIFT balance: this payment needs ' + supply + ' base units but the wallet has ' + tokenBalance + '.');
    }
    throw new Error('Could not fund the payment by selling LIFT: ' + (lastError?.message || 'unknown error'));
  }

  const tx = tradeTx.libauth_generated_transaction;
  const payToHex = binToHex(payToDecoded.bytecode);
  const vout = tx.outputs.findIndex((o) => binToHex(o.lockingBytecode) === payToHex);
  if (vout === -1) {
    throw new Error('Payment output missing from built transaction.');
  }

  const txHex = binToHex(tradeTx.txbin);
  const broadcastResponse = await bchWallet.watchtower.BCH._api.post('broadcast/', { transaction: txHex });
  const data = broadcastResponse.data;
  if (data?.result) {
    data[data.success ? 'txid' : 'error'] = data.result;
    delete data.result;
  }
  if (!data?.success || !data?.txid) {
    throw new Error(data?.error || 'Broadcast failed');
  }
  return { txid: data.txid, vout };
}

async function executePay(url, method, headers, body, bchWallet, hdWallet, x402Payer, isChipnet, confirmed, paymentMethod) {
  // Tell the backend the payment method so it can apply the LIFT discount and
  // record how the plan was paid. Set once here — the same headers object is
  // reused for the 402 fetch and the PAYMENT-SIGNATURE retry.
  if (paymentMethod === 'lift') {
    headers['X-Payment-Method'] = 'lift';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
    signal: AbortSignal.timeout(PAY_TIMEOUT_MS),
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

    let txid, vout = 0;
    if (paymentMethod === 'lift') {
      // Sell LIFT via Cauldron; the swap transaction pays the plan directly.
      const liftPayment = await payWithLift(bchWallet, hdWallet, requirements, changeAddress);
      txid = liftPayment.txid;
      vout = liftPayment.vout;
    } else {
      const sendResult = await bchWallet.sendBch(amountBch, address, changeAddress);
      if (!sendResult.success) {
        return { success: false, status: 402, payment: { required: true, error: sendResult.error }, error: sendResult.error };
      }
      txid = sendResult.txid;
    }

    const paymentPayload = await x402Payer.createPaymentPayload(requirements, paymentRequired.resource.url, txid, vout, requirements.amount);
    headers['PAYMENT-SIGNATURE'] = JSON.stringify(paymentPayload);

    let retryResponse;
    try {
      retryResponse = await fetch(url, {
        method,
        headers,
        body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
        signal: AbortSignal.timeout(PAY_TIMEOUT_MS),
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        return { success: false, timeout: true, error: 'Response timed out from server.' };
      }
      throw e;
    }
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
      payment: { required: true, txid, recipientAddress: address, method: paymentMethod === 'lift' ? 'lift' : 'bch' },
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