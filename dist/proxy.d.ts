import { Config, ProxyInfo } from './types';
export declare function isPortAvailable(port: number): Promise<boolean>;
export declare function findAvailablePort(startPort?: number, endPort?: number): Promise<number>;
export declare function isProcessRunning(pid: number): boolean;
export declare function getProxyStatus(configDir: string): Promise<{
    running: boolean;
    port?: number;
    pid?: number;
}>;
export declare function startProxy(configDir: string, config: Config): Promise<ProxyInfo>;
export declare function stopProxy(configDir: string): Promise<void>;
export declare function getProxyConfig(configDir: string): Promise<{
    backendUrl: string;
    port: number;
} | null>;
//# sourceMappingURL=proxy.d.ts.map