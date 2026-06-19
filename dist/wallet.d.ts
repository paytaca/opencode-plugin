import { WalletInfo } from './types';
export declare function checkWallet(): Promise<WalletInfo>;
export declare function ensurePaytacaOnPath(): string | null;
export declare function checkPaytacaCli(): Promise<boolean>;
export declare function createWallet(): Promise<WalletInfo>;
export declare function ensureWallet(): Promise<WalletInfo>;
export declare function importWallet(mnemonic: string): Promise<WalletInfo>;
export declare function extractWalletHash(output: string): string | undefined;
export declare function getReceivingAddress(): Promise<string | null>;
export declare function getWalletBalance(): Promise<{
    bch: number;
    sats: number;
} | null>;
//# sourceMappingURL=wallet.d.ts.map