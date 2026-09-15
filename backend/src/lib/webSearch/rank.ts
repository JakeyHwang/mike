import { createHash } from "node:crypto";
import { isRedirectHost } from "./redirects";
import type { JurisdictionSources } from "./sources";
import type { SourceTier, WebSearchSource } from "./types";

export interface RankCandidate {
    /** Resolved final URL, or null when redirect resolution dropped it. */
    url: string | null;
    title: string;
    snippet: string;
}

const TIER_ORDER: Record<SourceTier, number> = {
    regulator: -1,
    official: 0,
    government: 1,
    other: 2,
    junk: 3,
};

export const MAX_RESULTS = 6;
/** Junk only trails when nothing at tier <= 0 was found at all. */
const MAX_JUNK_TRAIL = 2;
export const MAX_SNIPPET_CHARS = 1500;

export function sourceId(url: string): string {
    return `web_${createHash("sha1").update(url).digest("hex").slice(0, 16)}`;
}

function matchesDomain(hostname: string, domain: string): boolean {
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function classifyDomain(
    hostname: string,
    sources: JurisdictionSources,
    topicText: string,
): SourceTier {
    const leadRule = sources.topicRegulatorRules.find((rule) =>
        rule.pattern.test(topicText),
    );
    if (leadRule && matchesDomain(hostname, leadRule.domain)) {
        return "regulator";
    }
    if (sources.officialDomains.some((d) => matchesDomain(hostname, d))) {
        return "official";
    }
    // Checked before the government rule: these buckets carry a gov hostname
    // but are not the regulator's own authoritative page.
    if (sources.govCdnExclude.some((marker) => hostname.includes(marker))) {
        return "other";
    }
    // A ".gov" label anywhere in the hostname covers gov.sg, gov.uk, gov.au
    // and bare .gov without a per-jurisdiction suffix list.
    if (
        hostname.split(".").includes("gov") ||
        sources.governmentDomains.some((d) => matchesDomain(hostname, d))
    ) {
        return "government";
    }
    if (sources.lowAuthorityMarkers.some((marker) => hostname.includes(marker))) {
        return "junk";
    }
    return "other";
}

function usableUrl(raw: string | null): URL | null {
    if (!raw) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    // An unresolved grounding redirect must never reach the model.
    if (isRedirectHost(url.hostname)) return null;
    return url;
}

/**
 * Drops unusable URLs, dedupes by domain (first wins), orders by authority tier
 * and caps the list. `dropped` counts only sources lost because their URL never
 * resolved to a real https page — dedupe, junk suppression and the cap are not
 * failures and are not reported.
 */
export function rankSources(
    candidates: readonly RankCandidate[],
    sources: JurisdictionSources,
    topicText: string,
): { results: WebSearchSource[]; dropped: number } {
    let dropped = 0;
    const byDomain = new Map<string, WebSearchSource>();

    for (const candidate of candidates) {
        const url = usableUrl(candidate.url);
        if (!url) {
            dropped += 1;
            continue;
        }
        const domain = url.hostname.toLowerCase();
        if (byDomain.has(domain)) continue;
        const href = url.toString();
        byDomain.set(domain, {
            id: sourceId(href),
            title: candidate.title.trim() || domain,
            url: href,
            domain,
            snippet: candidate.snippet.slice(0, MAX_SNIPPET_CHARS),
            snippet_source: "search_summary",
            tier: classifyDomain(domain, sources, topicText),
        });
    }

    const scored = [...byDomain.values()];
    const hasAuthority = scored.some((source) => TIER_ORDER[source.tier] <= 0);
    let junkKept = 0;
    const kept = scored.filter((source) => {
        if (source.tier !== "junk") return true;
        if (hasAuthority) return false;
        junkKept += 1;
        return junkKept <= MAX_JUNK_TRAIL;
    });

    // Array#sort is stable, so equal tiers keep Gemini's own ordering.
    kept.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
    return { results: kept.slice(0, MAX_RESULTS), dropped };
}
