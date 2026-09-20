export declare const ALLOWED_ORIGINS_ENV = "GIF_ALLOWED_ORIGINS";
export type ParseAllowedOriginsResult = {
    ok: true;
    hostnames: string[];
} | {
    ok: false;
    problem: string;
};
export declare function parseAllowedOrigins(raw: string | undefined): ParseAllowedOriginsResult;
//# sourceMappingURL=origin-allowlist.d.ts.map