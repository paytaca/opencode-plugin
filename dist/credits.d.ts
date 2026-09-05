export interface CreditsToastDeps {
    client: any;
    backendUrl: () => string;
    walletHash: () => string;
}
export declare function createCreditsToastWatch(deps: CreditsToastDeps): {
    check: () => Promise<void>;
};
//# sourceMappingURL=credits.d.ts.map