export interface Config {
    backendUrl: string;
    proxyPort: number;
    walletHash?: string;
    proxyPid?: number;
}
export interface WalletInfo {
    exists: boolean;
    hash?: string;
    address?: string;
    balance?: string;
    mnemonic?: string;
}
export interface ProxyStatus {
    running: boolean;
    port?: number;
    pid?: number;
    url?: string;
}
export interface ProxyInfo {
    port: number;
    pid: number;
}
//# sourceMappingURL=types.d.ts.map