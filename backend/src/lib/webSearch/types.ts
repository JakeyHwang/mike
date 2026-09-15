export type JurisdictionProfile = "SG" | "MY" | "AU" | "GB" | "US" | "general";
export type SourceTier =
    | "regulator"
    | "official"
    | "government"
    | "other"
    | "junk";

export interface WebSearchSource {
    id: string; // "web_" + sha1(url).slice(0,16)
    title: string;
    url: string; // resolved, https, never a vertexaisearch redirect
    domain: string; // lower-cased hostname
    snippet: string; // <= 1500 chars
    snippet_source: "search_summary" | "citation";
    tier: SourceTier;
}
export interface WebSearchSuggestion {
    label: string;
    url: string;
} // url starts with https://www.google.com/search?q=

export type WebSearchResult =
    | {
          success: true;
          results: WebSearchSource[];
          suggestions: WebSearchSuggestion[];
          result_count: number;
          dropped_sources: number;
          jurisdiction: JurisdictionProfile;
          from_cache: boolean;
      }
    | {
          success: false;
          reason: "rate_limited" | "timeout" | "unavailable" | "turn_limit";
          results: [];
          suggestions: [];
          jurisdiction: JurisdictionProfile;
      };

export type ReadPageReason =
    | "not_found"
    | "maintenance"
    | "blocked"
    | "unsupported_type"
    | "too_large"
    | "timeout"
    | "fetch_failed"
    | "turn_limit"
    | "unavailable";
export type ReadPageResult =
    | {
          success: true;
          url: string;
          final_url: string;
          title: string;
          kind: "html" | "pdf";
          text: string;
          char_count: number;
          truncated: boolean;
          bytes: number;
      }
    | { success: false; url: string; reason: ReadPageReason };

/** Per-assistant-turn state, constructed in streaming.ts, appended as the last param of runToolCalls. */
export interface WebSearchTurnState {
    jurisdiction: string | null; // user_profiles.jurisdiction display name, e.g. "Singapore"
    searchCalls: number; // cap 6
    readCalls: number; // cap 8
    bytesRead: number; // cap 12 * 1024 * 1024
    queryCache: Map<string, WebSearchResult>; // key = normalised query
    pageCache: Map<string, ReadPageResult>; // key = url
    results: Map<string, WebSearchSource>; // by id, for citation resolution
}
