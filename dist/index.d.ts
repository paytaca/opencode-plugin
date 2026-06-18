declare function OpencodePlugin(_input?: any, _options?: any): Promise<{
    config?: undefined;
    "chat.headers"?: undefined;
} | {
    config: (cfg: any) => Promise<void>;
    "chat.headers": (_input: any, output: any) => Promise<void>;
}>;
declare const _default: {
    id: string;
    server: typeof OpencodePlugin;
};
export = _default;
//# sourceMappingURL=index.d.ts.map