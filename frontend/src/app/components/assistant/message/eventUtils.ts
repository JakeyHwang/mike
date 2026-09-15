import type {
    AssistantEvent,
    ReadPageFailureReason,
    WebSourceTier,
} from "../../shared/types";

export function eventErrorMessage(event: AssistantEvent): string | null {
    if (event.type === "error") {
        return event.safe_to_display
            ? event.message
            : "Sorry, something went wrong.";
    }
    if ("error" in event && typeof event.error === "string" && event.error) {
        return "Sorry, something went wrong.";
    }
    return null;
}

/** Detail shown beside `Web search failed`, whatever the failure reason. */
export const WEB_SEARCH_FAILURE_DETAIL =
    "temporarily unavailable — answered from knowledge";

/** Failure reason → the parenthesised copy in a `Could not read …` row. */
export const READ_PAGE_FAILURE_COPY: Record<ReadPageFailureReason, string> = {
    not_found: "page not found",
    maintenance: "site under maintenance",
    blocked: "blocked",
    unsupported_type: "unsupported file type",
    too_large: "too large",
    timeout: "timed out",
    fetch_failed: "could not fetch",
    turn_limit: "could not fetch",
    unavailable: "could not fetch",
};

const READ_PAGE_PATH_MAX_CHARS = 32;

/**
 * Domain plus a truncated path and query string. The lawyer sees what was
 * fetched without the step row running away; the full URL stays in the row
 * `title` so an exfiltrating URL is never hidden.
 */
export function formatReadPageTarget(url: string, domain: string): string {
    let host = domain;
    let path = "";
    try {
        const parsed = new URL(url);
        host = domain || parsed.hostname.toLowerCase();
        path = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    } catch {
        path = "";
    }
    if (!path) return host;
    return `${host}${
        path.length > READ_PAGE_PATH_MAX_CHARS
            ? `${path.slice(0, READ_PAGE_PATH_MAX_CHARS)}…`
            : path
    }`;
}

/** Ranking used to list official web sources before the rest. */
export const WEB_TIER_RANK: Record<WebSourceTier, number> = {
    regulator: 0,
    official: 1,
    government: 2,
    other: 3,
    junk: 4,
};

export function toolCallLabel(name: string): string {
    if (name === "ask_inputs") return "Asking for input...";
    if (name === "generate_docx") return "Creating document...";
    if (name === "generate_excel") return "Creating spreadsheet...";
    if (name === "generate_ppt") return "Creating presentation...";
    if (name === "edit_document") return "Editing document...";
    if (name === "read_document") return "Reading document...";
    if (name === "fetch_documents") return "Reading documents...";
    if (name === "find_in_document") return "Searching document...";
    if (name === "replicate_document") return "Copying document...";
    if (name === "read_workflow") return "Reading workflow...";
    if (name === "list_workflows") return "Loading workflows...";
    if (name === "list_documents") return "Loading documents...";
    if (name === "courtlistener_search_case_law")
        return "Searching case law...";
    if (name === "courtlistener_get_cases") return "Fetching cases...";
    if (name === "courtlistener_find_in_case") return "Searching case...";
    if (name === "courtlistener_read_case") return "Reading case...";
    if (name === "courtlistener_verify_citations")
        return "Verifying citations...";
    if (name === "web_search") return "Searching the web...";
    if (name === "read_page") return "Reading page...";
    if (name.startsWith("mcp_")) return "Using connector...";
    return name ? `Running ${name}...` : "Working...";
}
