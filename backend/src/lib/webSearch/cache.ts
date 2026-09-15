import type { JurisdictionProfile, WebSearchResult } from "./types";

/**
 * Insertion-ordered TTL cache. `set` re-inserts so the Map's iteration order is
 * oldest-write-first, which makes eviction a single `keys().next()` rather than
 * a scan. Expired entries are dropped lazily on read; the size cap bounds the
 * memory a never-read key can hold.
 */
export class TtlCache<V> {
    private readonly entries = new Map<string, { value: V; expiresAt: number }>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries: number,
    ) {}

    get(key: string): V | undefined {
        const hit = this.entries.get(key);
        if (!hit) return undefined;
        if (hit.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return hit.value;
    }

    set(key: string, value: V): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done) break;
            this.entries.delete(oldest.value);
        }
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}

export const SEARCH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const SEARCH_CACHE_MAX_ENTRIES = 2000;

/** Cache key normalisation: also the key the per-turn `queryCache` uses. */
export function normaliseQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
}

const searchCache = new TtlCache<WebSearchResult>(
    SEARCH_CACHE_TTL_MS,
    SEARCH_CACHE_MAX_ENTRIES,
);

function searchCacheKey(
    jurisdiction: JurisdictionProfile,
    query: string,
): string {
    return `${jurisdiction}|${normaliseQuery(query)}`;
}

export function getCachedSearch(
    jurisdiction: JurisdictionProfile,
    query: string,
): WebSearchResult | undefined {
    return searchCache.get(searchCacheKey(jurisdiction, query));
}

/**
 * Stores a successful search. A failure and an empty result set are never
 * cached: a rate limit or a bad search must not be replayed for 12 hours.
 */
export function setCachedSearch(
    jurisdiction: JurisdictionProfile,
    query: string,
    result: WebSearchResult,
): void {
    if (!result.success || result.results.length === 0) return;
    searchCache.set(searchCacheKey(jurisdiction, query), result);
}

export function clearSearchCache(): void {
    searchCache.clear();
}
