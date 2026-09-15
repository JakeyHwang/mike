import { afterEach, describe, expect, it } from "vitest";

import { mcpOAuthCallbackUrl } from "../client";

const originalNodeEnv = process.env.NODE_ENV;
const originalApiPublicUrl = process.env.API_PUBLIC_URL;
const originalBackendUrl = process.env.BACKEND_URL;

afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalApiPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = originalApiPublicUrl;
    if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = originalBackendUrl;
});

describe("mcpOAuthCallbackUrl", () => {
    it("routes provider callbacks through the public same-origin gateway", () => {
        process.env.NODE_ENV = "production";
        process.env.API_PUBLIC_URL = "https://app.example.test/api/";

        expect(mcpOAuthCallbackUrl()).toBe(
            "https://app.example.test/api/user/mcp-connectors/oauth/callback",
        );
    });

    it("does not fall back to an internal production host", () => {
        process.env.NODE_ENV = "production";
        delete process.env.API_PUBLIC_URL;
        delete process.env.BACKEND_URL;

        expect(() => mcpOAuthCallbackUrl()).toThrow(
            /API_PUBLIC_URL is required/,
        );
    });
});
