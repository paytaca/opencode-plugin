export default function OpencodePlugin(): Promise<{
    connect: {
        types: {
            name: string;
            description: string;
            connect(): Promise<{
                error: string;
            }>;
        }[];
    };
    onExit?: undefined;
} | {
    connect: {
        types: {
            name: string;
            description: string;
            connect(): Promise<{
                provider: {
                    'paytaca-ai': {
                        npm: string;
                        name: string;
                        options: {
                            baseURL: string;
                        };
                        models: {
                            'deepseek-ai/DeepSeek-V4-Flash': {
                                name: string;
                                limit: {
                                    context: number;
                                    output: number;
                                };
                            };
                        };
                    };
                };
            }>;
        }[];
    };
    onExit(): Promise<void>;
}>;
//# sourceMappingURL=index.d.ts.map