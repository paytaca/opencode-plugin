import { spawn } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import * as path from 'path';
import { WalletInfo } from './types';

const execAsync = promisify(require('child_process').exec);

// Get the path to paytaca binary (local or global)
function getPaytacaCommand(): string {
  const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
  return fs.existsSync(localPaytaca) ? localPaytaca : 'paytaca';
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

export async function checkPaytacaCli(): Promise<boolean> {
  try {
    // Check if paytaca binary exists
    const fs = require('fs');
    if (!fs.existsSync(PAYTACA_CMD)) {
      return false;
    }
    // Test if it runs
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
    } catch {
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
