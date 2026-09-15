import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guardedFetch = vi.hoisted(() => vi.fn());
vi.mock("../../http/guardedFetch", () => ({ guardedFetch }));

import { rankSources } from "../rank";
import { clearRedirectCache, resolveRedirect } from "../redirects";
import { sourcesFor } from "../sources";

const REDIRECT =
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG1";

function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
}

function ok(status = 200): Response {
    return new Response(null, { status });
}

/** Mirrors the guard's rejection messages, which all start "Request URL ". */
function guardRejection(message: string): Error {
    return new Error(message);
}

beforeEach(() => {
    guardedFetch.mockReset();
    clearRedirectCache();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("resolveRedirect", () => {
    it("walks the chain with HEAD and returns the final https URL", async () => {
        guardedFetch
            .mockResolvedValueOnce(redirectTo("https://hop.example/next"))
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/gst"))
            .mockResolvedValueOnce(ok());

        await expect(resolveRedirect(REDIRECT)).resolves.toBe(
            "https://iras.gov.sg/gst",
        );
        expect(guardedFetch).toHaveBeenCalledTimes(3);
        expect(guardedFetch.mock.calls[0][1].method).toBe("HEAD");
    });

    it("passes a URL that is not a grounding redirect through without a request", async () => {
        await expect(resolveRedirect("https://iras.gov.sg/gst")).resolves.toBe(
            "https://iras.gov.sg/gst",
        );
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("serves a repeat resolution from the cache", async () => {
        guardedFetch
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/gst"))
            .mockResolvedValueOnce(ok());

        await resolveRedirect(REDIRECT);
        guardedFetch.mockClear();

        await expect(resolveRedirect(REDIRECT)).resolves.toBe(
            "https://iras.gov.sg/gst",
        );
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("re-resolves once the 24 h cache entry has expired", async () => {
        vi.useFakeTimers();
        guardedFetch
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/gst"))
            .mockResolvedValueOnce(ok());
        await resolveRedirect(REDIRECT);

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
        guardedFetch
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/new"))
            .mockResolvedValueOnce(ok());

        await expect(resolveRedirect(REDIRECT)).resolves.toBe(
            "https://iras.gov.sg/new",
        );
    });

    it("falls back to one GET when the host refuses HEAD", async () => {
        guardedFetch
            .mockResolvedValueOnce(ok(405))
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/gst"))
            .mockResolvedValueOnce(ok());

        await expect(resolveRedirect(REDIRECT)).resolves.toBe(
            "https://iras.gov.sg/gst",
        );
        expect(guardedFetch.mock.calls[1][1].method).toBe("GET");
    });

    it("falls back to GET when HEAD throws a transport error", async () => {
        guardedFetch
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/gst"))
            .mockResolvedValueOnce(ok());

        await expect(resolveRedirect(REDIRECT)).resolves.toBe(
            "https://iras.gov.sg/gst",
        );
    });

    it("drops the source when the guard rejects a hop to a private address", async () => {
        guardedFetch
            .mockResolvedValueOnce(redirectTo("https://internal.example/x"))
            .mockRejectedValueOnce(
                guardRejection(
                    "Request URL resolves to a blocked network address.",
                ),
            );

        await expect(resolveRedirect(REDIRECT)).resolves.toBeNull();
        // A guard rejection is terminal: no GET retry behind it.
        expect(guardedFetch).toHaveBeenCalledTimes(2);
    });

    it("counts a guard-rejected source in dropped_sources", async () => {
        guardedFetch.mockRejectedValue(
            guardRejection("Request URL points to a blocked host."),
        );
        const resolved = await resolveRedirect(REDIRECT);

        const { results, dropped } = rankSources(
            [{ url: resolved, title: "t", snippet: "s" }],
            sourcesFor("SG"),
            "gst rate",
        );
        expect(results).toEqual([]);
        expect(dropped).toBe(1);
    });

    it("drops a redirect to a non-https location", async () => {
        guardedFetch.mockResolvedValueOnce(redirectTo("http://iras.gov.sg/gst"));
        await expect(resolveRedirect(REDIRECT)).resolves.toBeNull();
    });

    it("drops a chain that never leaves the grounding redirect host", async () => {
        guardedFetch.mockResolvedValue(ok());
        await expect(resolveRedirect(REDIRECT)).resolves.toBeNull();
    });

    it("drops a chain longer than five hops", async () => {
        guardedFetch.mockResolvedValue(
            redirectTo("https://hop.example/again"),
        );
        await expect(resolveRedirect(REDIRECT)).resolves.toBeNull();
        expect(guardedFetch).toHaveBeenCalledTimes(5);
    });

    it("does not cache a transient failure", async () => {
        guardedFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
        guardedFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
        await expect(resolveRedirect(REDIRECT)).resolves.toBeNull();

        guardedFetch
            .mockResolvedValueOnce(redirectTo("https://iras.gov.sg/gst"))
            .mockResolvedValueOnce(ok());
        await expect(resolveRedirect(REDIRECT)).resolves.toBe(
            "https://iras.gov.sg/gst",
        );
    });
});
