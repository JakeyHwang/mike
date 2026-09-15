import { z } from "zod";
import type { WebSearchSuggestion } from "./types";

/**
 * Grounding with Google Search through the Gemini Developer API. Gemini's prose
 * is discarded: only `groundingMetadata` is used. The chat model that talks to
 * the lawyer is unaffected — Gemini only ever sees the search question.
 */
const GEMINI_ENDPOINT =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
const REQUEST_TIMEOUT_MS = 32_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_JITTER_MS = 250;
/** Hard ceiling on total sleep across one grounded search. */
const MAX_TOTAL_BACKOFF_MS = 9_000;

export type GroundingFailureReason = "rate_limited" | "timeout" | "unavailable";

export class GroundingError extends Error {
    readonly reason: GroundingFailureReason;

    constructor(reason: GroundingFailureReason, message: string) {
        super(message);
        this.name = "GroundingError";
        this.reason = reason;
    }
}

export interface GroundingChunk {
    /** Almost always a `vertexaisearch.cloud.google.com` redirect URL. */
    url: string;
    title: string;
}

export interface GroundingSupport {
    text: string;
    chunkIndices: number[];
}

export interface GroundingMetadata {
    chunks: GroundingChunk[];
    supports: GroundingSupport[];
    suggestions: WebSearchSuggestion[];
}

export interface GroundingOutcome {
    metadata: GroundingMetadata;
    /** HTTP calls made, including the extra empty-result pass. */
    attempts: number;
    retries: number;
}

export interface GroundingRequest {
    enrichedQuery: string;
    systemInstruction: string;
    apiKey: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SUGGESTION_ANCHOR_RE =
    /<a\b[^>]*\bhref="(https:\/\/www\.google\.com\/search\?q=[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

const HTML_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#39": "'",
    "#x27": "'",
};

function decodeEntities(value: string): string {
    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
        const key = String(name).toLowerCase();
        if (HTML_ENTITIES[key] !== undefined) return HTML_ENTITIES[key];
        const numeric = /^#x([0-9a-f]+)$/.exec(key)
            ? Number.parseInt(key.slice(2), 16)
            : /^#(\d+)$/.exec(key)
              ? Number.parseInt(key.slice(1), 10)
              : Number.NaN;
        return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : whole;
    });
}

/**
 * Pulls the label/href pairs out of `searchEntryPoint.renderedContent`. Google
 * ships that field as a styled HTML fragment; the HTML itself is never stored
 * or rendered, only the plain labels and their `google.com/search?q=` hrefs.
 */
export function parseSearchSuggestions(
    renderedContent: string,
): WebSearchSuggestion[] {
    const suggestions: WebSearchSuggestion[] = [];
    const seen = new Set<string>();
    for (const match of renderedContent.matchAll(SUGGESTION_ANCHOR_RE)) {
        const url = decodeEntities(match[1]);
        const label = decodeEntities(match[2].replace(/<[^>]*>/g, ""))
            .replace(/\s+/g, " ")
            .trim();
        if (!label || seen.has(url)) continue;
        seen.add(url);
        suggestions.push({ label, url });
    }
    return suggestions;
}

/**
 * The slice of the Developer API's `generateContent` response we consume. Every
 * field is optional: Google omits `groundingMetadata` entirely when the model
 * answered without searching, and a single malformed chunk must not discard the
 * rest of the response, so shape filtering happens after the parse.
 */
const GroundingResponseSchema = z.object({
    candidates: z
        .array(
            z.object({
                groundingMetadata: z
                    .object({
                        groundingChunks: z
                            .array(
                                z.object({
                                    web: z
                                        .object({
                                            uri: z.string().optional(),
                                            title: z.string().optional(),
                                        })
                                        .optional(),
                                }),
                            )
                            .optional(),
                        groundingSupports: z
                            .array(
                                z.object({
                                    segment: z
                                        .object({ text: z.string().optional() })
                                        .optional(),
                                    groundingChunkIndices: z
                                        .array(z.number())
                                        .optional(),
                                }),
                            )
                            .optional(),
                        searchEntryPoint: z
                            .object({ renderedContent: z.string().optional() })
                            .optional(),
                    })
                    .optional(),
            }),
        )
        .optional(),
});

export function parseGroundingMetadata(payload: unknown): GroundingMetadata {
    const parsed = GroundingResponseSchema.safeParse(payload);
    const metadata = parsed.success
        ? parsed.data.candidates?.[0]?.groundingMetadata
        : undefined;
    if (!metadata) return { chunks: [], supports: [], suggestions: [] };

    const chunks: GroundingChunk[] = [];
    for (const chunk of metadata.groundingChunks ?? []) {
        if (!chunk.web?.uri) continue;
        chunks.push({ url: chunk.web.uri, title: chunk.web.title ?? "" });
    }

    const supports: GroundingSupport[] = [];
    for (const support of metadata.groundingSupports ?? []) {
        const text = support.segment?.text;
        if (!text) continue;
        const chunkIndices = (support.groundingChunkIndices ?? []).filter(
            (index) => Number.isInteger(index) && index >= 0,
        );
        if (chunkIndices.length === 0) continue;
        supports.push({ text, chunkIndices });
    }

    const rendered = metadata.searchEntryPoint?.renderedContent;
    const suggestions = rendered ? parseSearchSuggestions(rendered) : [];

    return { chunks, supports, suggestions };
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

class GeminiHttpError extends Error {
    readonly status: number;
    readonly retryAfterMs: number | null;

    constructor(status: number, retryAfterMs: number | null, message: string) {
        super(message);
        this.name = "GeminiHttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

let keyRejectionLogged = false;
let monthKey = "";
let groundedCalls = 0;

/** Process-wide monthly counter of grounded calls, for the search log line. */
export function groundedCallsThisMonth(): number {
    return monthKey === new Date().toISOString().slice(0, 7) ? groundedCalls : 0;
}

function recordGroundedCall(): void {
    const month = new Date().toISOString().slice(0, 7);
    if (month !== monthKey) {
        monthKey = month;
        groundedCalls = 0;
    }
    groundedCalls += 1;
}

function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number.parseInt(header.trim(), 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function callGemini(request: GroundingRequest): Promise<unknown> {
    recordGroundedCall();
    const response = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-goog-api-key": request.apiKey,
        },
        body: JSON.stringify({
            systemInstruction: {
                parts: [{ text: request.systemInstruction }],
            },
            contents: [
                { role: "user", parts: [{ text: request.enrichedQuery }] },
            ],
            tools: [{ googleSearch: {} }],
            generationConfig: {
                temperature: 1.0,
                thinkingConfig: { thinkingLevel: "minimal" },
            },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        // The body is read and discarded: Google's error text can quote the
        // request and must never reach a log line or the UI.
        await response.text().catch(() => "");
        throw new GeminiHttpError(
            response.status,
            parseRetryAfter(response.headers.get("retry-after")),
            `Gemini grounding failed with status ${response.status}`,
        );
    }
    return response.json();
}

interface Failure {
    reason: GroundingFailureReason;
    retryable: boolean;
    retryAfterMs: number | null;
    message: string;
}

function classifyFailure(error: unknown): Failure {
    if (error instanceof GeminiHttpError) {
        if (error.status === 401 || error.status === 403) {
            if (!keyRejectionLogged) {
                keyRejectionLogged = true;
                console.error(
                    "[web_search] Gemini rejected WEB_SEARCH_GEMINI_API_KEY; web search is unavailable",
                    { status: error.status },
                );
            }
            return {
                reason: "unavailable",
                retryable: false,
                retryAfterMs: null,
                message: error.message,
            };
        }
        const throttled = error.status === 429 || error.status === 503;
        return {
            reason: throttled ? "rate_limited" : "unavailable",
            retryable: throttled,
            retryAfterMs: error.retryAfterMs,
            message: error.message,
        };
    }
    // AbortSignal.timeout rejects with TimeoutError; an explicit abort with
    // AbortError. Neither is retried — the 32 s budget is already spent.
    if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
        return {
            reason: "timeout",
            retryable: false,
            retryAfterMs: null,
            message: "Gemini grounding timed out",
        };
    }
    // Everything else reaching here is a transport failure from fetch.
    return {
        reason: "unavailable",
        retryable: true,
        retryAfterMs: null,
        message:
            error instanceof Error ? error.message : "Gemini grounding failed",
    };
}

/**
 * Backoff for the next attempt: 1 s, 2 s, 4 s plus jitter, or the server's own
 * `Retry-After` when it sent one. Returns null when sleeping would break the
 * total-sleep ceiling, which ends the retry loop.
 */
function nextBackoffMs(
    attempt: number,
    retryAfterMs: number | null,
    sleptSoFar: number,
): number | null {
    const base = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const delay =
        retryAfterMs !== null
            ? retryAfterMs
            : base + Math.random() * MAX_JITTER_MS;
    if (sleptSoFar + delay > MAX_TOTAL_BACKOFF_MS) return null;
    return delay;
}

/**
 * One grounded search with retries. 429, 503 and transient network failures are
 * retried up to three attempts; a timeout never is.
 */
export async function runGrounding(
    request: GroundingRequest,
): Promise<GroundingOutcome> {
    let slept = 0;
    let retries = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const metadata = parseGroundingMetadata(await callGemini(request));
            return { metadata, attempts: attempt, retries };
        } catch (error) {
            const failure = classifyFailure(error);
            const backoff =
                failure.retryable && attempt < MAX_ATTEMPTS
                    ? nextBackoffMs(attempt, failure.retryAfterMs, slept)
                    : null;
            if (backoff === null) {
                throw new GroundingError(failure.reason, failure.message);
            }
            slept += backoff;
            retries += 1;
            // Executor form: the backend targets ES2022, where
            // Promise.withResolvers does not exist.
            await new Promise<void>((resolve) => {
                setTimeout(resolve, backoff);
            });
        }
    }
    throw new GroundingError("unavailable", "Gemini grounding exhausted");
}

/**
 * The search entry point: one grounded call, plus a single extra pass when the
 * first returns no chunks at all. A failure on that extra pass keeps the first
 * (empty but valid) result rather than turning a zero-source search into an
 * error.
 */
export async function groundSearch(
    request: GroundingRequest,
): Promise<GroundingOutcome> {
    const first = await runGrounding(request);
    if (first.metadata.chunks.length > 0) return first;
    try {
        const second = await runGrounding(request);
        return {
            metadata: second.metadata,
            attempts: first.attempts + second.attempts,
            retries: first.retries + second.retries,
        };
    } catch {
        return first;
    }
}
