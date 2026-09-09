import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
}));

import { systemRouter } from "../system";
import { resetLatestReleaseCache } from "../../lib/updates";

const app = express();
app.use("/system", systemRouter);

const RELEASE = {
    tag_name: "v1.2.0",
    published_at: "2026-09-08T10:00:00Z",
    body: "Docs only.",
    html_url: "https://github.com/JakeyHwang/mike/releases/tag/v1.2.0",
    draft: false,
    prerelease: false,
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

// One mock for both upstreams: GitHub for the release lookup, the updater
// sidecar for apply/status.
function routeFetch(handlers: {
    github?: () => Response;
    updater?: () => Response;
}) {
    return vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
            if (!handlers.github) throw new Error("unexpected GitHub call");
            return handlers.github();
        }
        if (url.startsWith("http://updater:8085/")) {
            if (!handlers.updater) throw new Error("unexpected updater call");
            return handlers.updater();
        }
        throw new Error(`unexpected fetch to ${url}`);
    });
}

beforeEach(() => {
    resetLatestReleaseCache();
    process.env.MIKE_VERSION = "v1.1.0";
    process.env.MIKE_UPDATE_REPO = "acme/mike";
    delete process.env.UPDATER_URL;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.MIKE_VERSION;
    delete process.env.MIKE_UPDATE_REPO;
});

describe("GET /system/update", () => {
    it("reports a newer published release as available", async () => {
        vi.stubGlobal("fetch", routeFetch({ github: () => json(RELEASE) }));

        const response = await request(app).get("/system/update");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            current: "v1.1.0",
            latest: "v1.2.0",
            available: true,
            publishedAt: "2026-09-08T10:00:00Z",
            notes: "Docs only.",
            url: "https://github.com/JakeyHwang/mike/releases/tag/v1.2.0",
        });
    });

    it("is not available when the running tag is already the latest", async () => {
        process.env.MIKE_VERSION = "v1.2.0";
        vi.stubGlobal("fetch", routeFetch({ github: () => json(RELEASE) }));

        const response = await request(app).get("/system/update");

        expect(response.body.available).toBe(false);
        expect(response.body.latest).toBe("v1.2.0");
    });

    it("reports no update when GitHub is unreachable", async () => {
        // Offline or rate-limited is normal on a firm's box: the settings page
        // must still render, never a 5xx.
        vi.stubGlobal(
            "fetch",
            routeFetch({
                github: () => {
                    throw new Error("getaddrinfo ENOTFOUND");
                },
            }),
        );

        const response = await request(app).get("/system/update");

        expect(response.status).toBe(200);
        expect(response.body.latest).toBeNull();
        expect(response.body.available).toBe(false);
        expect(response.body.current).toBe("v1.1.0");
    });

    it("caches the lookup and bypasses the cache for refresh=1", async () => {
        const fetchMock = routeFetch({ github: () => json(RELEASE) });
        vi.stubGlobal("fetch", fetchMock);

        await request(app).get("/system/update");
        await request(app).get("/system/update");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await request(app).get("/system/update?refresh=1");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("POST /system/update", () => {
    it("forwards the latest tag to the updater and returns 202", async () => {
        let applyBody: string | undefined;
        const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith("https://api.github.com/")) return json(RELEASE);
            expect(url).toBe("http://updater:8085/apply");
            expect(init?.method).toBe("POST");
            applyBody = init?.body as string;
            return json({ tag: "v1.2.0" }, 202);
        });
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).post("/system/update");

        expect(response.status).toBe(202);
        expect(response.body).toEqual({ tag: "v1.2.0" });
        expect(JSON.parse(applyBody ?? "{}")).toEqual({ tag: "v1.2.0" });
    });

    it("returns 400 when there is nothing newer to install", async () => {
        process.env.MIKE_VERSION = "v1.2.0";
        const fetchMock = routeFetch({ github: () => json(RELEASE) });
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).post("/system/update");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: "no update available" });
        // The updater is never asked to apply a tag the box already runs.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns 400 when the release lookup failed", async () => {
        vi.stubGlobal(
            "fetch",
            routeFetch({
                github: () => {
                    throw new Error("offline");
                },
            }),
        );

        const response = await request(app).post("/system/update");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: "no update available" });
    });

    it("passes the updater's 409 through", async () => {
        vi.stubGlobal(
            "fetch",
            routeFetch({
                github: () => json(RELEASE),
                updater: () => json({ error: "update already running" }, 409),
            }),
        );

        const response = await request(app).post("/system/update");

        expect(response.status).toBe(409);
        expect(response.body).toEqual({ error: "update already running" });
    });

    it("returns 503 when the updater cannot be reached", async () => {
        vi.stubGlobal(
            "fetch",
            routeFetch({
                github: () => json(RELEASE),
                updater: () => {
                    throw new Error("ECONNREFUSED");
                },
            }),
        );

        const response = await request(app).post("/system/update");

        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: "updater unavailable" });
    });

    it("returns 503 when the updater refuses the apply", async () => {
        vi.stubGlobal(
            "fetch",
            routeFetch({
                github: () => json(RELEASE),
                updater: () => json({ error: "bad tag" }, 400),
            }),
        );

        const response = await request(app).post("/system/update");

        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: "updater unavailable" });
    });
});

describe("GET /system/update/status", () => {
    it("forwards the updater's status document with a log tail", async () => {
        const status = {
            state: "running",
            tag: "v1.2.0",
            fromTag: "v1.1.0",
            step: "pull",
            completedSteps: ["backup", "download", "configure"],
            startedAt: "2026-09-09T09:00:00Z",
            finishedAt: null,
            error: null,
            logTail: "pulling images\n",
        };
        vi.stubGlobal(
            "fetch",
            routeFetch({ updater: () => json(status) }),
        );

        const response = await request(app).get("/system/update/status");

        expect(response.status).toBe(200);
        expect(response.body).toEqual(status);
    });

    it("defaults logTail to an empty string", async () => {
        vi.stubGlobal(
            "fetch",
            routeFetch({ updater: () => json({ state: "idle" }) }),
        );

        const response = await request(app).get("/system/update/status");

        expect(response.body).toEqual({ state: "idle", logTail: "" });
    });

    it("reports unknown while the updater is being recreated", async () => {
        // compose up recreates the updater service mid-apply, so a refused
        // connection here is expected progress, not a failure.
        vi.stubGlobal(
            "fetch",
            routeFetch({
                updater: () => {
                    throw new Error("ECONNREFUSED");
                },
            }),
        );

        const response = await request(app).get("/system/update/status");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ state: "unknown" });
    });

    it("reports unknown when the updater answers with an error status", async () => {
        vi.stubGlobal(
            "fetch",
            routeFetch({ updater: () => json({ error: "boom" }, 500) }),
        );

        const response = await request(app).get("/system/update/status");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ state: "unknown" });
    });

    it("honors UPDATER_URL", async () => {
        process.env.UPDATER_URL = "http://updater:8085/";
        const fetchMock = vi
            .fn()
            .mockResolvedValue(json({ state: "idle" }));
        vi.stubGlobal("fetch", fetchMock);

        await request(app).get("/system/update/status");

        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
            "http://updater:8085/status",
        );
    });
});
