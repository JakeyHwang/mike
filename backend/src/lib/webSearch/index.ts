import { getCachedSearch, normaliseQuery, setCachedSearch } from "./cache";
import {
    GroundingError,
    groundSearch,
    groundedCallsThisMonth,
    type GroundingMetadata,
} from "./geminiGrounding";
import {
    MAX_SNIPPET_CHARS,
    rankSources,
    sourceId,
    type RankCandidate,
} from "./rank";
import { resolveSourceUrls } from "./redirects";
import { profileFor, sourcesFor } from "./sources";
import type {
    JurisdictionProfile,
    WebSearchResult,
    WebSearchSource,
} from "./types";

/**
 * Read once at import, exactly like the CourtListener token gate. This is
 * deliberately NOT `GEMINI_API_KEY`: that variable is the env fallback for the
 * Gemini chat-model provider, and setting it would flip `hasEnvApiKey("gemini")`
 * for every user. A lawyer's own BYOK key is never billed for grounding.
 */
const GEMINI_API_KEY = process.env.WEB_SEARCH_GEMINI_API_KEY?.trim() ?? "";

export function isWebSearchConfigured(): boolean {
    return GEMINI_API_KEY.length > 0;
}

function failed(
    jurisdiction: JurisdictionProfile,
    reason: "rate_limited" | "timeout" | "unavailable",
): WebSearchResult {
    return { success: false, reason, results: [], suggestions: [], jurisdiction };
}

/**
 * Gemini's own sentence about each source: every grounding support segment that
 * cites the chunk, concatenated. Labelled "from search summary" in the UI.
 */
function snippetsByChunk(metadata: GroundingMetadata): string[] {
    const snippets = metadata.chunks.map(() => "");
    for (const support of metadata.supports) {
        for (const index of support.chunkIndices) {
            if (index >= snippets.length) continue;
            snippets[index] = snippets[index]
                ? `${snippets[index]} ${support.text}`
                : support.text;
        }
    }
    return snippets.map((snippet) => snippet.slice(0, MAX_SNIPPET_CHARS));
}

/**
 * A neutral citation, statute section or Rules of Court reference in the query
 * or a result title gets the direct primary-source URL appended, so `read_page`
 * can go straight to the authority instead of a search summary about it.
 */
function appendCitationTargets(
    results: WebSearchSource[],
    jurisdiction: JurisdictionProfile,
    citationText: string,
): WebSearchSource[] {
    const targets = sourcesFor(jurisdiction).citationTargets(citationText);
    if (targets.length === 0) return results;
    const seen = new Set(results.map((result) => result.url));
    const appended = [...results];
    for (const target of targets) {
        if (seen.has(target.url)) continue;
        seen.add(target.url);
        appended.push({
            id: sourceId(target.url),
            title: target.citation,
            url: target.url,
            domain: new URL(target.url).hostname.toLowerCase(),
            snippet: target.citation,
            snippet_source: "citation",
            tier: "official",
        });
    }
    return appended;
}

interface SearchLogFields {
    jurisdiction: JurisdictionProfile;
    groundedMs: number;
    resolveMs: number;
    resultCount: number;
    dropped: number;
    cacheHit: boolean;
    retries: number;
    reason?: string;
}

/**
 * One line per search. Never the query text and never a URL: the model's query
 * is already persisted in the settled `web_search` event, and the server must
 * not hold a second copy of anything a lawyer typed.
 */
function logSearch(fields: SearchLogFields): void {
    console.info("[web_search]", {
        jurisdiction: fields.jurisdiction,
        grounded_ms: fields.groundedMs,
        redirect_resolve_ms: fields.resolveMs,
        result_count: fields.resultCount,
        dropped_sources: fields.dropped,
        cache_hit: fields.cacheHit,
        retries: fields.retries,
        grounded_calls_month: groundedCallsThisMonth(),
        ...(fields.reason ? { reason: fields.reason } : {}),
    });
}

/**
 * Discover public-web sources for one query: enrich with the jurisdiction cue,
 * ground through Gemini, resolve every redirect through the SSRF guard, rank by
 * authority, append any direct citation URLs, and cache the result for 12 h.
 */
export async function webSearch(
    query: string,
    opts: { jurisdiction: string | null },
): Promise<WebSearchResult> {
    const jurisdiction = profileFor(opts.jurisdiction);
    const sources = sourcesFor(jurisdiction);
    const normalised = normaliseQuery(query);
    if (!normalised) {
        return {
            success: true,
            results: [],
            suggestions: [],
            result_count: 0,
            dropped_sources: 0,
            jurisdiction,
            from_cache: false,
        };
    }
    if (!isWebSearchConfigured()) return failed(jurisdiction, "unavailable");

    const cached = getCachedSearch(jurisdiction, normalised);
    if (cached?.success) {
        logSearch({
            jurisdiction,
            groundedMs: 0,
            resolveMs: 0,
            resultCount: cached.result_count,
            dropped: cached.dropped_sources,
            cacheHit: true,
            retries: 0,
        });
        return { ...cached, from_cache: true };
    }

    const today = new Date().toISOString().slice(0, 10);
    const groundedStart = Date.now();
    let outcome;
    try {
        outcome = await groundSearch({
            enrichedQuery: sources.enrichQuery(query.trim(), today),
            systemInstruction: sources.systemInstruction,
            apiKey: GEMINI_API_KEY,
        });
    } catch (error) {
        const reason =
            error instanceof GroundingError ? error.reason : "unavailable";
        logSearch({
            jurisdiction,
            groundedMs: Date.now() - groundedStart,
            resolveMs: 0,
            resultCount: 0,
            dropped: 0,
            cacheHit: false,
            retries: 0,
            reason,
        });
        return failed(jurisdiction, reason);
    }
    const groundedMs = Date.now() - groundedStart;

    const resolveStart = Date.now();
    const resolved = await resolveSourceUrls(
        outcome.metadata.chunks.map((chunk) => chunk.url),
    );
    const resolveMs = Date.now() - resolveStart;

    const snippets = snippetsByChunk(outcome.metadata);
    const candidates: RankCandidate[] = outcome.metadata.chunks.map(
        (chunk, index) => ({
            url: resolved[index],
            title: chunk.title,
            snippet: snippets[index] ?? "",
        }),
    );

    // Topic-regulator rules match on what the search was about, which is the
    // model's query plus the titles Google actually returned.
    const topicText = [
        query,
        ...outcome.metadata.chunks.map((chunk) => chunk.title),
    ].join(" ");
    const { results, dropped } = rankSources(candidates, sources, topicText);

    const citationText = [query, ...results.map((r) => r.title)].join("\n");
    const withCitations = appendCitationTargets(
        results,
        jurisdiction,
        citationText,
    );

    const result: WebSearchResult = {
        success: true,
        results: withCitations,
        suggestions: outcome.metadata.suggestions,
        result_count: withCitations.length,
        dropped_sources: dropped,
        jurisdiction,
        from_cache: false,
    };
    setCachedSearch(jurisdiction, normalised, result);
    logSearch({
        jurisdiction,
        groundedMs,
        resolveMs,
        resultCount: withCitations.length,
        dropped,
        cacheHit: false,
        retries: outcome.retries,
    });
    return result;
}
