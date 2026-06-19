"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkWallet = checkWallet;
exports.ensurePaytacaOnPath = ensurePaytacaOnPath;
exports.checkPaytacaCli = checkPaytacaCli;
exports.createWallet = createWallet;
exports.ensureWallet = ensureWallet;
exports.importWallet = importWallet;
exports.extractWalletHash = extractWalletHash;
exports.getReceivingAddress = getReceivingAddress;
exports.getWalletBalance = getWalletBalance;
const fs = __importStar(require("fs"));
const util_1 = require("util");
const path = __importStar(require("path"));
const execAsync = (0, util_1.promisify)(require('child_process').exec);
function getPaytacaCommand() {
    try {
        const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
        return path.resolve(path.dirname(paytacaCliPkg), 'bin', 'paytaca.js');
    }
    catch { }
    const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
    if (fs.existsSync(localPaytaca)) {
        return localPaytaca;
    }
    return 'paytaca';
}
const PAYTACA_CMD = getPaytacaCommand();
async function checkWallet() {
    try {
        const { stdout } = await execAsync(`"${PAYTACA_CMD}" wallet info`);
        const output = stdout.toString();
        // Extract wallet hash
        const hashMatch = output.match(/Wallet hash:\s*(.+)/i);
        const hash = hashMatch ? hashMatch[1].trim() : undefined;
        if (!hash) {
            return { exists: false };
        }
        // Extract address
        const addressMatch = output.match(/Address:\s*(.+)/i);
        const address = addressMatch ? addressMatch[1].trim() : undefined;
        // Extract balance
        const balanceMatch = output.match(/Balance:\s*(.+)/i);
        const balance = balanceMatch ? balanceMatch[1].trim() : undefined;
        return {
            exists: true,
            hash,
            address,
            balance
        };
    }
    catch (err) {
        return {
            exists: false
        };
    }
}
function ensurePaytacaOnPath() {
    try {
        const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
        const binDir = path.resolve(path.dirname(paytacaCliPkg), '..', '.bin');
        const paytacaBin = path.join(binDir, 'paytaca');
        if (fs.existsSync(paytacaBin)) {
            if (!process.env.PATH?.includes(binDir)) {
                process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
            }
            return binDir;
        }
    }
    catch { }
    return null;
}
async function checkPaytacaCli() {
    try {
        await execAsync(`"${PAYTACA_CMD}" --version`);
        return true;
    }
    catch {
        return false;
    }
}
async function createWallet() {
    try {
        // Generate a new wallet using paytaca CLI
        // This will create a wallet and display the mnemonic
        const { stdout, stderr } = await execAsync(`"${PAYTACA_CMD}" wallet create --json`);
        let output = stdout.toString();
        if (!output && stderr) {
            output = stderr.toString();
        }
        // Try to parse JSON output if available
        try {
            const jsonOutput = JSON.parse(output);
            if (jsonOutput.mnemonic) {
                // Show warning to user
                console.log('\\n⚠️  IMPORTANT: Your wallet has been created!');
                console.log('\\nSAVE THIS RECOVERY PHRASE SECURELY:');
                console.log('═'.repeat(60));
                console.log(jsonOutput.mnemonic);
                console.log('═'.repeat(60));
                console.log('\\nWithout this phrase, you CANNOT recover your funds if you');
                console.log('lose access to this device. Write it down and store it safely.\\n');
                return {
                    exists: true,
                    hash: jsonOutput.hash,
                    address: jsonOutput.address,
                    balance: '0 BCH',
                    mnemonic: jsonOutput.mnemonic
                };
            }
        }
        catch {
            // Fall through to regex parsing
        }
        // Parse from text output
        const hashMatch = output.match(/Wallet hash:\s*(.+)/i);
        const addressMatch = output.match(/Address:\s*(.+)/i);
        const mnemonicMatch = output.match(/Recovery phrase[\s\S]*?([a-z]+(?:\s+[a-z]+){11,23})/i);
        if (mnemonicMatch) {
            console.log('\\n⚠️  IMPORTANT: Your wallet has been created!');
            console.log('\\nSAVE THIS RECOVERY PHRASE SECURELY:');
            console.log('═'.repeat(60));
            console.log(mnemonicMatch[1]);
            console.log('═'.repeat(60));
            console.log('\\nWithout this phrase, you CANNOT recover your funds if you');
            console.log('lose access to this device. Write it down and store it safely.\\n');
        }
        return {
            exists: true,
            hash: hashMatch ? hashMatch[1].trim() : undefined,
            address: addressMatch ? addressMatch[1].trim() : undefined,
            balance: '0 BCH',
            mnemonic: mnemonicMatch ? mnemonicMatch[1] : undefined
        };
    }
    catch (err) {
        console.error('Failed to create wallet:', err.message || err);
        return {
            exists: false
        };
    }
}
async function ensureWallet() {
    // First check if wallet exists
    const existingWallet = await checkWallet();
    if (existingWallet.exists) {
        return existingWallet;
    }
    // No wallet found - create one automatically
    console.log('🔧 No Paytaca wallet found. Creating a new wallet...');
    const newWallet = await createWallet();
    if (!newWallet.exists) {
        throw new Error(`Failed to automatically create wallet. Please create one manually: "${PAYTACA_CMD}" wallet create`);
    }
    // Wait a moment for wallet to be fully initialized
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Verify the wallet was created
    const verifyWallet = await checkWallet();
    if (!verifyWallet.exists) {
        throw new Error(`Wallet creation verification failed. Please check "${PAYTACA_CMD}" wallet status.`);
    }
    return verifyWallet;
}
async function importWallet(mnemonic) {
    try {
        // Import wallet using provided mnemonic
        const { stdout } = await execAsync(`echo "${mnemonic}" | "${PAYTACA_CMD}" wallet import --stdin`);
        const output = stdout.toString();
        const hashMatch = output.match(/Wallet hash:\s*(.+)/i);
        const addressMatch = output.match(/Address:\s*(.+)/i);
        return {
            exists: true,
            hash: hashMatch ? hashMatch[1].trim() : undefined,
            address: addressMatch ? addressMatch[1].trim() : undefined,
            balance: undefined
        };
    }
    catch (err) {
        console.error('Failed to import wallet:', err.message || err);
        return {
            exists: false
        };
    }
}
function extractWalletHash(output) {
    const match = output.match(/Wallet hash:\s*(.+)/i);
    return match ? match[1].trim() : undefined;
}
async function getReceivingAddress() {
    try {
        const { stdout } = await execAsync(`"${PAYTACA_CMD}" wallet info`);
        const output = stdout.toString();
        const addressMatch = output.match(/Address:\s*(.+)/i);
        return addressMatch ? addressMatch[1].trim() : null;
    }
    catch {
        return null;
    }
}
async function getWalletBalance() {
    try {
        const { stdout } = await execAsync(`"${PAYTACA_CMD}" wallet info`);
        const output = stdout.toString();
        const match = output.match(/Balance:\s*([\d.]+)\s*BCH/i);
        if (match) {
            const bch = parseFloat(match[1]);
            return {
                bch,
                sats: Math.floor(bch * 100000000)
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=wallet.js.map