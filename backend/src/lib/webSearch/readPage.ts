// `read_page`: fetch one public web page or PDF and hand the model plain text.
//
// Every outbound request — the first one and every redirect hop — goes through
// `guardedFetch`, so the https-only / no-credentials / no-private-network guard
// runs per hop and a 3xx to an internal host cannot smuggle egress past it.
// Everything this module returns is untrusted data; fencing it
// (`spotlight(text, nonce)`) is the dispatcher's job, so the text is handed
// back byte-for-byte as extracted and is never rewritten here.

import { convert } from "html-to-text";

import { guardedFetch } from "../http/guardedFetch";
import { loadPdfjs } from "../pdfjs";
import type { ReadPageReason, ReadPageResult } from "./types";

export interface ReadPageOptions {
    /**
     * A provision the model is after ("157", "s 157"). Used for the
     * `sso.agc.gov.sg` provision view; ignored for every other host.
     */
    provisionHint?: string;
    /**
     * Bytes still available in the caller's per-turn budget. A page whose body
     * does not fit is refused with `too_large` rather than silently truncated,
     * so the dispatcher's 12 MB turn budget cannot be overrun by one read.
     */
    byteBudget?: number;
}

const MAX_REDIRECT_HOPS = 5;
const TOTAL_BUDGET_MS = 12_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHARS = 40_000;
const MAX_CONCURRENT_READS = 3;
const MAX_PDF_PAGES = 100;
// Casey's guard: a real judgment / statute ToC is far longer than this, so a
// short body plus an error phrase cannot be a false positive on real content.
const SHORT_PAGE_MAX_CHARS = 1500;
const TRUNCATION_MARKER = "[...document truncated...]";

const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const ACCEPT =
    "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8";

// Exact eLitigation / Singapore Statutes Online not-found copy (Casey's
// `_NOT_FOUND_PHRASES`): both serve HTTP 200 over an error page.
const NOT_FOUND_PHRASES = [
    "page you are trying to access cannot be found",
    "page you are looking for cannot be found",
];

// Casey's `_MAINTENANCE_PHRASES`: during a maintenance window eLitigation
// serves a short notice with HTTP 200 for every judgment URL.
const MAINTENANCE_PHRASES = [
    "undergoing a system maintenance",
    "system is currently undergoing maintenance",
    "scheduled maintenance",
    "under maintenance",
    "maintenance notice",
    "temporarily unavailable",
];

// Substrings of the guard's rejection messages (`lib/http/guardedFetch.ts`).
// A throw carrying one of these is a guard rejection → `blocked`, never
// retried; anything else is a transport failure → `fetch_failed`.
const GUARD_REJECTION_MARKERS = [
    "valid URL",
    "HTTPS",
    "credentials",
    "blocked host",
    "blocked network address",
];

const SKIPPED_SELECTORS = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "iframe",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "button",
];

const HTML_CONTENT_TYPES: Record<string, true> = {
    "text/html": true,
    "application/xhtml+xml": true,
    "application/xml": true,
    "text/xml": true,
};

const PDF_CONTENT_TYPES: Record<string, true> = {
    "application/pdf": true,
    "application/x-pdf": true,
};

const REDIRECT_STATUSES: Record<number, true> = {
    301: true,
    302: true,
    303: true,
    307: true,
    308: true,
};

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

// ---------------------------------------------------------------------------
// Module-level read slots: at most three page reads are in flight per process,
// however many turns are streaming. The 12 s budget starts after a slot is
// acquired so a queued read is not charged for someone else's fetch.
// ---------------------------------------------------------------------------

let activeReads = 0;
const waitingReads: (() => void)[] = [];

function acquireReadSlot(): Promise<void> {
    if (activeReads < MAX_CONCURRENT_READS) {
        activeReads += 1;
        return Promise.resolve();
    }
    // Executor form: the backend targets ES2022, where Promise.withResolvers
    // does not exist.
    return new Promise<void>((resolve) => waitingReads.push(resolve));
}

function releaseReadSlot(): void {
    const next = waitingReads.shift();
    // Hand the slot straight to the next waiter rather than freeing it, so the
    // count can never exceed MAX_CONCURRENT_READS between wake-ups.
    if (next) next();
    else activeReads -= 1;
}

// ---------------------------------------------------------------------------

export async function readPage(
    url: string,
    opts: ReadPageOptions = {},
): Promise<ReadPageResult> {
    const target = normaliseTarget(url, opts.provisionHint);
    if (!target) return failure(url, "blocked");

    await acquireReadSlot();
    const startedAt = Date.now();
    try {
        return await fetchAndExtract(
            url,
            target,
            startedAt + TOTAL_BUDGET_MS,
            opts.byteBudget,
        );
    } finally {
        releaseReadSlot();
    }
}

interface Target {
    url: URL;
    /** SSO provision the output should be focused on, if one was requested. */
    provision: string | null;
}

/**
 * Normalise the requested URL, or `null` when it can never be fetched.
 *
 * An `http://` input is retried once as `https://` (the guard is https-only);
 * userinfo is refused outright rather than stripped, so a credentialed URL is
 * never fetched with its credentials dropped and its host trusted.
 */
function normaliseTarget(raw: string, provisionHint?: string): Target | null {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    if (parsed.protocol !== "https:") return null;

    const provision = applySsoProvisionView(parsed, provisionHint);
    // The fragment is never sent on the wire; drop it so `final_url` is the URL
    // we actually requested.
    parsed.hash = "";
    return { url: parsed, provision };
}

const PROVISION_HINT_RE = /^\s*(?:s|sec|section)?\s*\.?\s*(\d+[A-Za-z]*)\s*$/i;
const HASH_PROVISION_RE =
    /^#(?:prov(?:ision)?|pr|sec(?:tion)?|s)[-_]?(\d+[A-Za-z]*)-?$/i;
const PATH_PROVISION_RE =
    /\/(?:prov(?:ision)?|sec(?:tion)?)[-_]?(\d+[A-Za-z]*)\/?$/i;
const SSO_PROV_IDS_RE = /^pr(\d+[A-Za-z]*)-/i;

/**
 * Singapore Statutes Online serves an Act's table of contents by default and
 * lazy-loads provision bodies, so the section text is simply absent from
 * `/Act/CoA1967`; it is present under `?ProvIds=pr157-` (verified against SSO
 * on 2026-09-15). When the caller names a provision — or the URL does, in its
 * fragment or a `/Section-157` tail — ask for that view and return the
 * provision id so the output can be focused on it: the requested section sits
 * ~44,000 characters into the rendered page, past the output cap.
 *
 * Deliberately not read from the path in general: SSO path slugs carry
 * subsidiary-legislation numbers (`/SL/LPA1966-S706-2015`) that look like
 * section references but are not, and guessing there would replace a valid
 * document with an empty provision view.
 */
function applySsoProvisionView(
    url: URL,
    provisionHint?: string,
): string | null {
    const host = url.hostname.toLowerCase();
    if (host !== "sso.agc.gov.sg" && !host.endsWith(".sso.agc.gov.sg")) {
        return null;
    }
    const existing = url.searchParams.get("ProvIds");
    if (existing) return SSO_PROV_IDS_RE.exec(existing)?.[1] ?? null;

    const provision =
        (provisionHint ? PROVISION_HINT_RE.exec(provisionHint)?.[1] : null) ??
        HASH_PROVISION_RE.exec(url.hash)?.[1] ??
        PATH_PROVISION_RE.exec(url.pathname)?.[1];
    if (!provision) return null;
    url.searchParams.set("ProvIds", `pr${provision.toLowerCase()}-`);
    return provision;
}

async function fetchAndExtract(
    requested: string,
    target: Target,
    deadline: number,
    byteBudget?: number,
): Promise<ReadPageResult> {
    let current = target.url;

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return failure(requested, "timeout");

        let response: Response;
        try {
            response = await guardedFetch(current, {
                signal: AbortSignal.timeout(remainingMs),
                headers: {
                    "User-Agent": BROWSER_USER_AGENT,
                    Accept: ACCEPT,
                    "Accept-Language": "en-SG,en;q=0.9",
                },
            });
        } catch (err) {
            const reason = classifyRequestError(err);
            devLog("[webSearch/readPage] request failed", {
                domain: current.hostname,
                hop,
                reason,
            });
            return failure(requested, reason);
        }

        if (REDIRECT_STATUSES[response.status] === true) {
            void response.body?.cancel();
            const location = response.headers.get("location");
            if (!location) return failure(requested, "fetch_failed");
            let next: URL;
            try {
                next = new URL(location, current);
            } catch {
                return failure(requested, "blocked");
            }
            if (next.username || next.password) {
                return failure(requested, "blocked");
            }
            next.hash = "";
            // The next iteration re-submits this hop through the guard, so a
            // redirect to a private, loopback or metadata host is rejected
            // there and surfaces as `blocked`.
            current = next;
            continue;
        }

        return await extract(
            requested,
            current,
            target.provision,
            response,
            deadline,
            byteBudget,
        );
    }

    return failure(requested, "fetch_failed");
}

async function extract(
    requested: string,
    final: URL,
    provision: string | null,
    response: Response,
    deadline: number,
    byteBudget?: number,
): Promise<ReadPageResult> {
    if (response.status === 404 || response.status === 410) {
        void response.body?.cancel();
        return failure(requested, "not_found");
    }
    if (response.status === 413) {
        void response.body?.cancel();
        return failure(requested, "too_large");
    }
    if (!response.ok) {
        void response.body?.cancel();
        return failure(requested, "fetch_failed");
    }

    const contentTypeHeader = response.headers.get("content-type") ?? "";
    const budget = Math.max(0, Math.min(MAX_BYTES, byteBudget ?? MAX_BYTES));
    const budgetBinding = budget < MAX_BYTES;

    const declared = Number(response.headers.get("content-length"));
    if (budgetBinding && Number.isFinite(declared) && declared > budget) {
        void response.body?.cancel();
        return failure(requested, "too_large");
    }

    let body: CappedBody;
    try {
        body = await readCapped(response, budget, deadline);
    } catch (err) {
        const reason = classifyRequestError(err);
        return failure(requested, reason === "blocked" ? "fetch_failed" : reason);
    }
    // pdfjs takes ownership of the array it is handed and detaches the backing
    // buffer, so the size is recorded before any extraction runs — the caller
    // meters its per-turn byte budget on it.
    const byteCount = body.bytes.length;
    // A body that does not fit the caller's remaining turn budget is refused
    // outright; only the 3 MB ceiling truncates.
    if (budgetBinding && body.truncated) return failure(requested, "too_large");
    if (body.timedOut && byteCount === 0) {
        return failure(requested, "timeout");
    }

    const flavour = resolveFlavour(contentTypeHeader, body.bytes);
    if (!flavour) {
        devLog("[webSearch/readPage] unsupported type", {
            domain: final.hostname,
            contentType: contentTypeHeader.split(";")[0]?.trim(),
        });
        return failure(requested, "unsupported_type");
    }

    let text: string;
    let title: string | null = null;
    let extractionTruncated = false;

    if (flavour === "pdf") {
        let pdf: ExtractedPdf;
        try {
            pdf = await pdfToText(body.bytes, deadline);
        } catch (err) {
            devLog("[webSearch/readPage] pdf parse failed", {
                domain: final.hostname,
                error: err instanceof Error ? err.name : "unknown",
            });
            // A PDF we cannot parse is, to the model, a file it cannot read.
            return failure(requested, "unsupported_type");
        }
        text = pdf.text;
        extractionTruncated = pdf.truncated;
    } else {
        const decoded = decodeBody(body.bytes, contentTypeHeader);
        if (flavour === "html") {
            title = htmlTitle(decoded);
            text = htmlToText(decoded);
        } else {
            // text/plain and friends are already the document: running them
            // through html-to-text would eat anything shaped like a tag.
            text = decoded;
        }
    }

    text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

    if (!text) {
        return failure(
            requested,
            body.timedOut || Date.now() >= deadline ? "timeout" : "not_found",
        );
    }
    // Soft-404 and maintenance stubs are HTTP 200 over markup; a PDF that
    // parsed is a real document.
    if (flavour !== "pdf") {
        if (isSoftNotFound(text)) return failure(requested, "not_found");
        if (isMaintenance(text)) return failure(requested, "maintenance");
    }

    const focused =
        flavour === "html" && provision
            ? focusProvision(text, provision)
            : { text, focused: false };
    const capped = capChars(focused.text);
    const result: ReadPageResult = {
        success: true,
        url: requested,
        final_url: final.toString(),
        title: title ?? titleFromUrl(final),
        kind: flavour === "pdf" ? "pdf" : "html",
        text: capped.text,
        char_count: capped.text.length,
        truncated:
            body.truncated ||
            extractionTruncated ||
            capped.truncated ||
            focused.focused,
        bytes: byteCount,
    };
    devLog("[webSearch/readPage] read", {
        domain: final.hostname,
        kind: result.kind,
        bytes: result.bytes,
        chars: result.char_count,
        truncated: result.truncated,
    });
    return result;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface CappedBody {
    bytes: Uint8Array;
    truncated: boolean;
    timedOut: boolean;
}

/**
 * Read at most `cap` bytes, stopping at the shared deadline. Streaming rather
 * than `arrayBuffer()` so a multi-gigabyte response never lands in memory.
 */
async function readCapped(
    response: Response,
    cap: number,
    deadline: number,
): Promise<CappedBody> {
    if (cap === 0) {
        void response.body?.cancel();
        return { bytes: new Uint8Array(0), truncated: true, timedOut: false };
    }
    if (!response.body) {
        const whole = new Uint8Array(await response.arrayBuffer());
        return whole.length > cap
            ? { bytes: whole.subarray(0, cap), truncated: true, timedOut: false }
            : { bytes: whole, truncated: false, timedOut: false };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;

    try {
        while (total < cap) {
            if (Date.now() >= deadline) {
                timedOut = true;
                truncated = true;
                break;
            }
            const next = await reader.read();
            if (next.done) {
                done = true;
                break;
            }
            const chunk = next.value;
            if (!chunk?.length) continue;
            const room = cap - total;
            if (chunk.length >= room) {
                chunks.push(chunk.subarray(0, room));
                total = cap;
                truncated = true;
                break;
            }
            chunks.push(chunk);
            total += chunk.length;
        }
        if (total >= cap) truncated = true;
    } finally {
        if (!done) void reader.cancel().catch(() => {});
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return { bytes, truncated, timedOut };
}

function decodeBody(bytes: Uint8Array, contentTypeHeader: string): string {
    const label = /charset\s*=\s*"?([^";]+)"?/i
        .exec(contentTypeHeader)?.[1]
        ?.trim();
    if (label) {
        try {
            return new TextDecoder(label).decode(bytes);
        } catch {
            // Unknown charset label: fall through to UTF-8.
        }
    }
    return new TextDecoder("utf-8").decode(bytes);
}

type Flavour = "html" | "text" | "pdf";

function resolveFlavour(
    contentTypeHeader: string,
    bytes: Uint8Array,
): Flavour | null {
    const mime = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
    if (PDF_CONTENT_TYPES[mime] === true) return "pdf";
    if (HTML_CONTENT_TYPES[mime] === true) return "html";
    if (mime.startsWith("text/")) return "text";
    // A server that sends no usable content type still tells us what it sent.
    if (!mime || mime === "application/octet-stream") {
        if (looksLikePdf(bytes)) return "pdf";
        if (looksLikeHtml(bytes)) return "html";
    }
    return null;
}

function looksLikePdf(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 5 &&
        bytes[0] === 0x25 && // %
        bytes[1] === 0x50 && // P
        bytes[2] === 0x44 && // D
        bytes[3] === 0x46 && // F
        bytes[4] === 0x2d //   -
    );
}

function looksLikeHtml(bytes: Uint8Array): boolean {
    const head = new TextDecoder("utf-8")
        .decode(bytes.subarray(0, 512))
        .trimStart()
        .toLowerCase();
    return head.startsWith("<!doctype html") || head.startsWith("<html");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
    return convert(html, {
        wordwrap: false,
        baseElements: {
            // Prefer the article body over the chrome; `maxBaseElements: 1`
            // keeps the single best match so a page with both <article> and
            // <main> is not emitted twice, and `returnDomByDefault` falls back
            // to the whole document when neither exists.
            selectors: ["article", "main", "[role=main]"],
            orderBy: "selectors",
            returnDomByDefault: true,
        },
        selectors: [
            ...SKIPPED_SELECTORS.map((selector) => ({
                selector,
                format: "skip",
            })),
            { selector: "img", format: "skip" },
            { selector: "a", options: { ignoreHref: true } },
        ],
        limits: {
            maxInputLength: 3_000_000,
            maxBaseElements: 1,
            maxDepth: 60,
            maxChildNodes: 20_000,
            ellipsis: "",
        },
    });
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

function htmlTitle(html: string): string | null {
    const raw = TITLE_RE.exec(html)?.[1] ?? H1_RE.exec(html)?.[1];
    if (!raw) return null;
    // convert() decodes entities and drops any inline markup inside the title.
    const text = convert(raw, { wordwrap: false }).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 300) : null;
}

function titleFromUrl(url: URL): string {
    const segment = url.pathname.split("/").filter(Boolean).pop();
    if (!segment) return url.hostname;
    let decoded = segment;
    try {
        decoded = decodeURIComponent(segment);
    } catch {
        // Keep the raw segment when it is not valid percent-encoding.
    }
    const cleaned = decoded.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
    return cleaned || url.hostname;
}

interface ExtractedPdf {
    text: string;
    truncated: boolean;
}

/**
 * Text of at most the first {@link MAX_PDF_PAGES} pages, stopping at the read
 * budget or the character cap. A page-bomb PDF therefore comes back truncated
 * instead of pinning the process for minutes.
 */
async function pdfToText(
    bytes: Uint8Array,
    deadline: number,
): Promise<ExtractedPdf> {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
        data: bytes,
        // Never compile expressions out of an untrusted document.
        isEvalSupported: false,
    }).promise;

    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    let truncated = doc.numPages > pageCount;
    const pages: string[] = [];
    let chars = 0;

    for (let page = 1; page <= pageCount; page += 1) {
        if (chars >= MAX_CHARS || Date.now() >= deadline) {
            truncated = true;
            break;
        }
        const content = await (await doc.getPage(page)).getTextContent();
        const text = content.items
            .map((item) => item.str ?? "")
            .join(" ")
            .replace(/[ \t]+/g, " ")
            .trim();
        if (!text) continue;
        pages.push(text);
        chars += text.length + 2;
    }

    return { text: pages.join("\n\n"), truncated };
}

// Maximum run of preceding text kept with a provision: SSO prints the
// provision's marginal note on the line above its number, and that note is
// what tells the reader which section this is.
const PROVISION_NOTE_MAX_CHARS = 300;

/**
 * Drop everything before the requested provision.
 *
 * An SSO Act page is a long table of contents with the requested provision
 * appended after it — s 157 of the Companies Act sits ~44,000 characters in,
 * past the output cap — so without this the model receives a ToC and no
 * section text. Returns the text unchanged when the provision heading is not
 * found, so a page that does not follow SSO's layout is never mangled.
 */
function focusProvision(
    text: string,
    provision: string,
): { text: string; focused: boolean } {
    // SSO renders the provision as "157.—(1) …" on its own line.
    const heading = new RegExp(
        `(^|\\n)[ \\t]*${provision}\\.(?=[\\s\\u2014]|$)`,
        "i",
    );
    const match = heading.exec(text);
    if (!match) return { text, focused: false };

    const headingStart = match.index + match[1].length;
    if (headingStart === 0) return { text, focused: false };

    let noteEnd = headingStart;
    while (noteEnd > 0 && /\s/.test(text[noteEnd - 1])) noteEnd -= 1;
    const noteStart = text.lastIndexOf("\n", noteEnd - 1) + 1;
    const start =
        noteEnd > 0 && headingStart - noteStart <= PROVISION_NOTE_MAX_CHARS
            ? noteStart
            : headingStart;
    return { text: text.slice(start), focused: true };
}

// ---------------------------------------------------------------------------
// Soft failures served with HTTP 200
// ---------------------------------------------------------------------------

function isSoftNotFound(text: string): boolean {
    const low = text.toLowerCase();
    if (NOT_FOUND_PHRASES.some((phrase) => low.includes(phrase))) return true;
    return text.length < SHORT_PAGE_MAX_CHARS && low.includes("page not found");
}

function isMaintenance(text: string): boolean {
    if (text.length >= SHORT_PAGE_MAX_CHARS) return false;
    const low = text.toLowerCase();
    return MAINTENANCE_PHRASES.some((phrase) => low.includes(phrase));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capChars(text: string): { text: string; truncated: boolean } {
    if (text.length <= MAX_CHARS) return { text, truncated: false };
    const keep = MAX_CHARS - TRUNCATION_MARKER.length - 2;
    return {
        text: `${text.slice(0, keep).trimEnd()}\n\n${TRUNCATION_MARKER}`,
        truncated: true,
    };
}

function failure(url: string, reason: ReadPageReason): ReadPageResult {
    return { success: false, url, reason };
}

/**
 * Why a request threw: the read budget elapsed (`AbortSignal.timeout` rejects
 * with a `TimeoutError`), the guard refused the URL — those messages are the
 * contract with `lib/http/guardedFetch.ts` — or the transport failed.
 */
function classifyRequestError(
    err: unknown,
): "timeout" | "blocked" | "fetch_failed" {
    if (!(err instanceof Error)) return "fetch_failed";
    if (err.name === "TimeoutError" || err.name === "AbortError") {
        return "timeout";
    }
    const guarded = GUARD_REJECTION_MARKERS.some((marker) =>
        err.message.includes(marker),
    );
    return guarded ? "blocked" : "fetch_failed";
}
