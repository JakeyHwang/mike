import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    compareTags,
    currentVersion,
    fetchLatestRelease,
    parseLatestRelease,
    resetLatestReleaseCache,
    updateRepo,
} from "../updates";

function releaseResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const RELEASE = {
    tag_name: "v1.2.0",
    published_at: "2026-09-08T10:00:00Z",
    body: "Docs only.",
    html_url: "https://github.com/JakeyHwang/mike/releases/tag/v1.2.0",
    draft: false,
    prerelease: false,
};

beforeEach(() => {
    resetLatestReleaseCache();
    delete process.env.MIKE_VERSION;
    delete process.env.MIKE_UPDATE_REPO;
});

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MIKE_VERSION;
    delete process.env.MIKE_UPDATE_REPO;
});

describe("compareTags", () => {
    it("orders by major, then minor, then patch", () => {
        expect(compareTags("v2.0.0", "v1.9.9")).toBe(1);
        expect(compareTags("v1.2.0", "v1.10.0")).toBe(-1);
        expect(compareTags("v1.2.10", "v1.2.9")).toBe(1);
        expect(compareTags("v1.2.3", "v1.2.3")).toBe(0);
    });

    it("compares numerically rather than lexically", () => {
        // "v1.10.0" < "v1.9.0" as strings; a string compare would hide the
        // tenth minor release from every box running v1.9.x.
        expect(compareTags("v1.10.0", "v1.9.0")).toBe(1);
    });

    it("treats a non-version string as newer than nothing", () => {
        for (const invalid of [
            "dev",
            "1.2.3",
            "v1.2",
            "v1.2.3-rc1",
            "latest",
            "",
            null,
            undefined,
            42,
        ]) {
            expect(compareTags(invalid, "v1.2.3")).toBe(0);
            expect(compareTags("v1.2.3", invalid)).toBe(0);
        }
    });
});

describe("currentVersion", () => {
    it("falls back to dev when MIKE_VERSION is unset or blank", () => {
        expect(currentVersion()).toBe("dev");
        process.env.MIKE_VERSION = "   ";
        expect(currentVersion()).toBe("dev");
    });

    it("trims the tag the image was built at", () => {
        process.env.MIKE_VERSION = " v1.1.0 ";
        expect(currentVersion()).toBe("v1.1.0");
    });
});

describe("updateRepo", () => {
    it("defaults to the fork's repository", () => {
        expect(updateRepo()).toBe("JakeyHwang/mike");
    });

    it("ignores a value that is not owner/name", () => {
        // The repo is interpolated into the GitHub API path; a stray slash or
        // traversal segment must not be able to redirect the lookup.
        process.env.MIKE_UPDATE_REPO = "../../evil";
        expect(updateRepo()).toBe("JakeyHwang/mike");
    });

    it("uses a configured repository", () => {
        process.env.MIKE_UPDATE_REPO = "acme/mike";
        expect(updateRepo()).toBe("acme/mike");
    });
});

describe("parseLatestRelease", () => {
    it("maps the fields the settings page shows", () => {
        expect(parseLatestRelease(RELEASE)).toEqual({
            tag: "v1.2.0",
            publishedAt: "2026-09-08T10:00:00Z",
            notes: "Docs only.",
            url: "https://github.com/JakeyHwang/mike/releases/tag/v1.2.0",
        });
    });

    it("skips drafts and prereleases", () => {
        expect(parseLatestRelease({ ...RELEASE, draft: true })).toBeNull();
        expect(parseLatestRelease({ ...RELEASE, prerelease: true })).toBeNull();
    });

    it("returns null without a tag", () => {
        expect(parseLatestRelease({ ...RELEASE, tag_name: "" })).toBeNull();
        expect(parseLatestRelease({ ...RELEASE, tag_name: null })).toBeNull();
        expect(parseLatestRelease(null)).toBeNull();
        expect(parseLatestRelease([RELEASE])).toBeNull();
    });

    it("nulls empty optional fields instead of showing blanks", () => {
        expect(
            parseLatestRelease({ tag_name: "v1.2.0", body: "  ", html_url: 5 }),
        ).toEqual({
            tag: "v1.2.0",
            publishedAt: null,
            notes: null,
            url: null,
        });
    });
});

describe("fetchLatestRelease", () => {
    it("requests the repository's latest release as mike-updater", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(releaseResponse(RELEASE));

        const release = await fetchLatestRelease("acme/mike", { fetchImpl });

        expect(release?.tag).toBe("v1.2.0");
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://api.github.com/repos/acme/mike/releases/latest",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "User-Agent": "mike-updater",
                }),
            }),
        );
    });

    it("serves the cached release until refresh is requested", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(releaseResponse(RELEASE));

        await fetchLatestRelease("acme/mike", { fetchImpl });
        await fetchLatestRelease("acme/mike", { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await fetchLatestRelease("acme/mike", { fetchImpl, refresh: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed lookup", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"))
            .mockResolvedValue(releaseResponse(RELEASE));

        expect(await fetchLatestRelease("acme/mike", { fetchImpl })).toBeNull();
        expect((await fetchLatestRelease("acme/mike", { fetchImpl }))?.tag).toBe(
            "v1.2.0",
        );
    });

    it("returns null for a rate-limited or errored response", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(releaseResponse({ message: "rate limited" }, 403));

        expect(await fetchLatestRelease("acme/mike", { fetchImpl })).toBeNull();
    });

    it("returns null for a malformed body", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(new Response("<html>", { status: 200 }));

        expect(await fetchLatestRelease("acme/mike", { fetchImpl })).toBeNull();
    });

    it("never calls GitHub for a repository that is not owner/name", async () => {
        const fetchImpl = vi.fn();

        expect(
            await fetchLatestRelease("acme/mike/../../evil", { fetchImpl }),
        ).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
