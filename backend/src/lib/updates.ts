// Release lookup for the in-app updater. The backend only reads GitHub's
// "latest release" for the fork's repository and compares it against the tag
// this container was built at; applying an update is the updater sidecar's
// job (see docs/superpowers/specs/2026-09-09-in-app-updater-design.md).

export type ReleaseInfo = {
    tag: string;
    publishedAt: string | null;
    notes: string | null;
    url: string | null;
};

export const DEFAULT_UPDATE_REPO = "JakeyHwang/mike";

// Releases are tagged vMAJOR.MINOR.PATCH. Anything else is not a version we
// know how to order, and the updater rejects it outright.
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

function parseTag(value: unknown): [number, number, number] | null {
    if (typeof value !== "string") return null;
    const match = TAG_PATTERN.exec(value.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Orders two release tags: 1 when `a` is strictly newer, -1 when `b` is
 * strictly newer, 0 otherwise. A string that is not a `vX.Y.Z` tag never
 * counts as newer than anything, so an unparseable tag on either side is
 * reported as "neither is newer" rather than being sorted arbitrarily.
 */
export function compareTags(a: unknown, b: unknown): number {
    const left = parseTag(a);
    const right = parseTag(b);
    if (!left || !right) return 0;
    for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) {
            return left[index] > right[index] ? 1 : -1;
        }
    }
    return 0;
}

/** The tag this backend image was built at; "dev" outside a release. */
export function currentVersion(): string {
    return process.env.MIKE_VERSION?.trim() || "dev";
}

/** The repository releases are published to, `owner/name`. */
export function updateRepo(): string {
    const configured = process.env.MIKE_UPDATE_REPO?.trim();
    if (configured && REPOSITORY_PATTERN.test(configured)) return configured;
    return DEFAULT_UPDATE_REPO;
}

function optionalString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * Narrows GitHub's release payload. Drafts and prereleases are not offered to
 * lawyers, so they parse as "no release".
 */
export function parseLatestRelease(payload: unknown): ReleaseInfo | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
    }
    const release = payload as Record<string, unknown>;
    if (release.draft === true || release.prerelease === true) return null;
    const tag = optionalString(release.tag_name);
    if (!tag) return null;
    return {
        tag,
        publishedAt: optionalString(release.published_at),
        notes: optionalString(release.body),
        url: optionalString(release.html_url),
    };
}

type CacheEntry = { value: ReleaseInfo | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/** Test seam: drops the in-memory release cache. */
export function resetLatestReleaseCache(): void {
    cache.clear();
}

export type FetchLatestReleaseOptions = {
    /** Ignore a cached answer and re-query GitHub. */
    refresh?: boolean;
    fetchImpl?: typeof fetch;
};

/**
 * The repository's latest published release, cached for an hour so the
 * settings page and the 30-minute frontend poll cannot burn through GitHub's
 * unauthenticated rate limit. Offline, rate-limited or malformed responses
 * resolve to null: a missing update check must never break the page.
 */
export async function fetchLatestRelease(
    repo: string,
    options: FetchLatestReleaseOptions = {},
): Promise<ReleaseInfo | null> {
    if (!REPOSITORY_PATTERN.test(repo)) return null;
    const now = Date.now();
    if (!options.refresh) {
        const cached = cache.get(repo);
        if (cached && cached.expiresAt > now) return cached.value;
    }

    const fetchImpl = options.fetchImpl ?? fetch;
    try {
        const response = await fetchImpl(
            `https://api.github.com/repos/${repo}/releases/latest`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "User-Agent": "mike-updater",
                },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            },
        );
        if (!response.ok) {
            console.warn("[system/update] GitHub release lookup failed", {
                repo,
                status: response.status,
            });
            return null;
        }
        const release = parseLatestRelease(await response.json());
        // Only successful lookups are cached; a transient outage must not
        // pin "no update" for the next hour.
        cache.set(repo, { value: release, expiresAt: Date.now() + CACHE_TTL_MS });
        return release;
    } catch (error) {
        console.warn("[system/update] GitHub release lookup threw", {
            repo,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}
