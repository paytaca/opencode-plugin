import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import * as path from 'path';
import { WalletInfo } from './types';

const execAsync = promisify(require('child_process').exec);

function getGlobalNpmRoot(): string | null {
  try {
    return execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function getPaytacaCommand(): string {
  // Priority 1: Local node_modules (via require.resolve)
  try {
    const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
    return path.resolve(path.dirname(paytacaCliPkg), 'bin', 'paytaca.js');
  } catch {}

  // Priority 2: Local .bin symlink
  const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
  if (fs.existsSync(localPaytaca)) {
    return localPaytaca;
  }

  // Priority 3: Global npm root
  const globalRoot = getGlobalNpmRoot();
  if (globalRoot) {
    const globalPaytaca = path.join(globalRoot, 'paytaca-cli', 'bin', 'paytaca.js');
    if (fs.existsSync(globalPaytaca)) {
      return globalPaytaca;
    }
    const scopedPaytaca = path.join(globalRoot, '@paytaca', 'opencode-plugin', 'node_modules', 'paytaca-cli', 'bin', 'paytaca.js');
    if (fs.existsSync(scopedPaytaca)) {
      return scopedPaytaca;
    }
  }

  // Priority 4: Common global installation paths
  const commonPaths = [
    '/usr/lib/node_modules/paytaca-cli/bin/paytaca.js',
    '/usr/local/lib/node_modules/paytaca-cli/bin/paytaca.js',
    '/opt/homebrew/lib/node_modules/paytaca-cli/bin/paytaca.js',
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Priority 5: which/where on PATH
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} paytaca`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (result) {
      return result;
    }
  } catch {}

  // Priority 6: Bare command (rely on PATH at runtime)
  return 'paytaca';
}

const PAYTACA_CMD = getPaytacaCommand();

export async function checkWallet(): Promise<WalletInfo> {
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
  } catch (err) {
    return {
      exists: false
    };
  }
}

function addToPath(dir: string): void {
  if (dir && fs.existsSync(dir) && !process.env.PATH?.includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  }
}

export function ensurePaytacaOnPath(): string | null {
  // Priority 1: Local node_modules .bin dir
  try {
    const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
    const binDir = path.resolve(path.dirname(paytacaCliPkg), '..', '.bin');
    const paytacaBin = path.join(binDir, 'paytaca');
    if (fs.existsSync(paytacaBin)) {
      addToPath(binDir);
      return binDir;
    }
  } catch {}

  // Priority 2: Global npm root .bin dir
  const globalRoot = getGlobalNpmRoot();
  if (globalRoot) {
    const globalBinDir = path.resolve(globalRoot, '..', '.bin');
    const globalPaytaca = path.join(globalBinDir, 'paytaca');
    if (fs.existsSync(globalPaytaca)) {
      addToPath(globalBinDir);
      return globalBinDir;
    }
  }

  // Priority 3: Common global bin directories
  const commonBinDirs = [
    '/usr/local/bin',
    '/usr/bin',
    path.join(os.homedir(), '.npm-global', 'bin'),
    process.env.NVM_BIN,
  ].filter((p): p is string => !!p);

  for (const binDir of commonBinDirs) {
    const paytacaBin = path.join(binDir, 'paytaca');
    if (fs.existsSync(paytacaBin)) {
      addToPath(binDir);
      return binDir;
    }
  }

  return null;
}

export async function checkPaytacaCli(): Promise<boolean> {
  try {
    await execAsync(`"${PAYTACA_CMD}" --version`);
    return true;
  } catch {
    return false;
  }
}

export async function createWallet(): Promise<WalletInfo> {
  try {
    // Generate a new wallet using paytaca CLI
    // This will create a wallet and display the mnemonic
    const { stdout, stderr } = await execAsync(`"${PAYTACA_CMD}" wallet create`);
    
    let output = stdout.toString();
    if (!output && stderr) {
      output = stderr.toString();
    }
    
    // Parse from text output
    const hashMatch = output.match(/Wallet hash:\s*(.+)/i);
    const addressMatch = output.match(/Address:\s*(.+)/i);
    
    // Extract mnemonic from numbered seed phrase list
    const phraseSection = output.match(/Seed phrase:\s*\n([\s\S]*?)(?=\n\s*Wallet hash)/i);
    let mnemonic = undefined;
    if (phraseSection) {
      const words = [];
      for (const line of phraseSection[1].trim().split('\n')) {
        const m = line.match(/^\s*\d+\.\s+(\w+)/);
        if (m) words.push(m[1]);
      }
      if (words.length >= 12) mnemonic = words.join(' ');
    }
    
    if (mnemonic) {
      console.log('\\n⚠️  IMPORTANT: Your wallet has been created!');
      console.log('\\nSAVE THIS RECOVERY PHRASE SECURELY:');
      console.log('═'.repeat(60));
      console.log(mnemonic);
      console.log('═'.repeat(60));
      console.log('\\nWithout this phrase, you CANNOT recover your funds if you');
      console.log('lose access to this device. Write it down and store it safely.\\n');
    }
    
    return {
      exists: true,
      hash: hashMatch ? hashMatch[1].trim() : undefined,
      address: addressMatch ? addressMatch[1].trim() : undefined,
      balance: '0 BCH',
      mnemonic
    };
  } catch (err: any) {
    console.error('Failed to create wallet:', err.message || err);
    return {
      exists: false
    };
  }
}

export async function ensureWallet(): Promise<WalletInfo> {
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

export async function importWallet(mnemonic: string): Promise<WalletInfo> {
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
  } catch (err: any) {
    console.error('Failed to import wallet:', err.message || err);
    return {
      exists: false
    };
  }
}

export function extractWalletHash(output: string): string | undefined {
  const match = output.match(/Wallet hash:\s*(.+)/i);
  return match ? match[1].trim() : undefined;
}

export async function getReceivingAddress(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${PAYTACA_CMD}" wallet info`);
    const output = stdout.toString();
    const addressMatch = output.match(/Address:\s*(.+)/i);
    return addressMatch ? addressMatch[1].trim() : null;
  } catch {
    return null;
  }
}

export async function getWalletBalance(): Promise<{ bch: number; sats: number } | null> {
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
  } catch {
    return null;
  }
}
