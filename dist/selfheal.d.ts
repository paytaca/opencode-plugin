export interface SelfHealOptions {
    home?: string;
    cwd?: string;
    registryUrl?: string;
    latestVersion?: string;
}
export declare function compareVersions(a: string, b: string): number;
export declare function readOwnVersion(packageRoot: string): string | null;
export declare function updateDependencySpecs(exactVersion: string, opts: SelfHealOptions): string[];
export declare function deleteStaleLockfiles(opts: SelfHealOptions): string[];
export declare function cleanStaleCaches(targetVersion: string, opts: SelfHealOptions): string[];
export declare function runSelfHeal(opts?: SelfHealOptions): Promise<void>;
//# sourceMappingURL=selfheal.d.ts.map