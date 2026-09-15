import { mapWithConcurrency } from "../concurrency";
import { guardedFetch } from "../http/guardedFetch";
import { TtlCache } from "./cache";

/**
 * Gemini hands back `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
 * URLs. They are resolved to the real page here and never returned to the
 * model or persisted. Every hop goes back through `guardedFetch`, so the
 * https-only, credential, metadata-host and private-IP rejections run on each
 * one — a redirect chain cannot be used to smuggle egress to an internal host.
 */
export const REDIRECT_HOST = "vertexaisearch.cloud.google.com";

const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 2500;
const MAX_IN_FLIGHT = 12;
/** Enough to open the connection and read the status line; the body is dropped. */
const GET_PROBE_BYTES = 64;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;

const REDIRECT_STATUSES: Record<number, true> = {
    301: true,
    302: true,
    303: true,
    307: true,
    308: true,
};

const resolvedCache = new TtlCache<string>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);

export function isRedirectHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === REDIRECT_HOST || host.endsWith(`.${REDIRECT_HOST}`);
}

/**
 * True when the error came from the SSRF guard rather than the network. Guard
 * errors are terminal — the source is dropped and counted, never retried with
 * a different method. `fetch` wraps a connect-time rejection in a TypeError, so
 * the cause chain is walked too.
 */
function isGuardRejection(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
        if (current.message.startsWith("Request URL ")) return true;
        current = current.cause;
    }
    return false;
}

async function drainProbeBody(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    try {
        let read = 0;
        while (read < GET_PROBE_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) return;
            read += chunk.value.byteLength;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

type Hop =
    | { kind: "final" }
    | { kind: "redirect"; location: string }
    | { kind: "drop" };

async function walkOneHop(url: URL): Promise<Hop> {
    let response: Response | null = null;
    try {
        response = await guardedFetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        });
    } catch (error) {
        if (isGuardRejection(error)) return { kind: "drop" };
        response = null;
    }

    // A host that refuses HEAD (405/501) or dropped the request gets one GET
    // through the same guard, reading only enough to see the status line.
    if (!response || response.status >= 400) {
        try {
            response = await guardedFetch(url, {
                method: "GET",
                signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
            });
            await drainProbeBody(response);
        } catch {
            return { kind: "drop" };
        }
        if (response.status >= 400) return { kind: "drop" };
    }

    if (REDIRECT_STATUSES[response.status] !== true) return { kind: "final" };
    const location = response.headers.get("location");
    return location ? { kind: "redirect", location } : { kind: "final" };
}

async function walkChain(start: URL): Promise<string | null> {
    let current = start;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
        const step = await walkOneHop(current);
        if (step.kind === "drop") return null;
        if (step.kind === "final") {
            // A chain that never leaves the redirect host resolved nothing.
            if (isRedirectHost(current.hostname)) return null;
            current.hash = "";
            return current.toString();
        }
        let next: URL;
        try {
            next = new URL(step.location, current);
        } catch {
            return null;
        }
        if (next.protocol !== "https:") return null;
        current = next;
    }
    return null;
}

/**
 * Resolves one grounding URL to its final https page, or null when the guard,
 * the hop cap or the network drops it. A URL that is not a grounding redirect
 * is returned unchanged — there is nothing to follow and no request is made.
 */
export async function resolveRedirect(raw: string): Promise<string | null> {
    let start: URL;
    try {
        start = new URL(raw);
    } catch {
        return null;
    }
    if (start.protocol !== "https:") return null;
    if (!isRedirectHost(start.hostname)) return start.toString();

    const key = start.toString();
    const cached = resolvedCache.get(key);
    if (cached !== undefined) return cached;

    const final = await walkChain(start);
    // Only successes are cached: a transient network failure must not pin a
    // source as dropped for 24 hours.
    if (final !== null) resolvedCache.set(key, final);
    return final;
}

/** Resolves a whole grounding batch, at most 12 chains in flight. */
export function resolveSourceUrls(
    urls: readonly string[],
): Promise<(string | null)[]> {
    return mapWithConcurrency(urls, MAX_IN_FLIGHT, (url) =>
        resolveRedirect(url),
    );
}

export function clearRedirectCache(): void {
    resolvedCache.clear();
}
