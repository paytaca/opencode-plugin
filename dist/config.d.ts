import { Config } from './types';
export declare const DEFAULT_BACKEND_URL = "https://api.paytaca.ai";
export declare const DEFAULT_PROXY_PORT = 8001;
export declare function getConfigDir(): string;
export declare function ensureConfigDir(configDir: string): void;
export declare function getConfigFile(configDir: string): string;
export declare function loadConfig(configDir: string): Config;
export declare function saveConfig(configDir: string, config: Config): void;
export declare function getPidFile(configDir: string): string;
export declare function getProxyScript(configDir: string): string;
export declare function getLogFile(configDir: string): string;
export declare function getWrapperScript(configDir: string): string;
export declare function getHeartbeatFile(configDir: string): string;
export declare function updateHeartbeat(configDir: string): void;
export declare function startHeartbeat(configDir: string): NodeJS.Timeout;
//# sourceMappingURL=config.d.ts.map