import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GroundingError,
    groundSearch,
    parseGroundingMetadata,
    parseSearchSuggestions,
    runGrounding,
} from "../geminiGrounding";
import grounding from "./fixtures/grounding.json";

const REQUEST = {
    enrichedQuery: "what is the GST rate Jurisdiction: Singapore.",
    systemInstruction: "You are a legal research assistant.",
    apiKey: "test-key",
};

const EMPTY_PAYLOAD = { candidates: [{ groundingMetadata: {} }] };

function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("grounding metadata parsing", () => {
    const metadata = parseGroundingMetadata(grounding);

    it("keeps only chunks that carry a URI", () => {
        expect(metadata.chunks).toEqual([
            {
                url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG1iras",
                title: "iras.gov.sg",
            },
            {
                url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHmof",
                title: "mof.gov.sg",
            },
            {
                url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQJblog",
                title: "",
            },
        ]);
    });

    it("keeps the support segments that cite a chunk", () => {
        expect(metadata.supports).toEqual([
            {
                text: "The prevailing GST rate in Singapore is 9%, with effect from 1 January 2024.",
                chunkIndices: [0, 1],
            },
            {
                text: "Buyer's Stamp Duty is charged on a tiered scale.",
                chunkIndices: [0],
            },
        ]);
    });

    it("parses search suggestions out of renderedContent and keeps no HTML", () => {
        expect(metadata.suggestions).toEqual([
            {
                label: "current GST rate Singapore",
                url: "https://www.google.com/search?q=current+GST+rate+Singapore&client=app",
            },
            {
                label: "IRAS buyer's stamp duty rates",
                url: "https://www.google.com/search?q=IRAS+buyer%27s+stamp+duty+rates",
            },
        ]);
        for (const suggestion of metadata.suggestions) {
            expect(suggestion.url.startsWith("https://www.google.com/search?q=")).toBe(
                true,
            );
            expect(suggestion.label).not.toMatch(/[<>]/);
        }
    });

    it("ignores anchors that do not point at a Google search", () => {
        expect(
            parseSearchSuggestions(
                '<a href="https://evil.example/?q=x">click</a>' +
                    '<a href="https://www.google.com/search?q=ok">ok</a>',
            ),
        ).toEqual([{ label: "ok", url: "https://www.google.com/search?q=ok" }]);
    });

    it.each([null, {}, { candidates: [] }, { candidates: [{}] }])(
        "returns empty metadata for %j",
        (payload) => {
            expect(parseGroundingMetadata(payload)).toEqual({
                chunks: [],
                supports: [],
                suggestions: [],
            });
        },
    );
});

describe("the grounded request", () => {
    it("targets gemini-3.5-flash with the search tool and minimal thinking", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(grounding));
        await runGrounding(REQUEST);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        );
        expect(init.headers["x-goog-api-key"]).toBe("test-key");
        expect(JSON.parse(init.body)).toEqual({
            systemInstruction: {
                parts: [{ text: REQUEST.systemInstruction }],
            },
            contents: [
                { role: "user", parts: [{ text: REQUEST.enrichedQuery }] },
            ],
            tools: [{ googleSearch: {} }],
            generationConfig: {
                temperature: 1.0,
                thinkingConfig: { thinkingLevel: "minimal" },
            },
        });
    });
});

describe("retry classification", () => {
    it("retries a 429 and reports the retry count", async () => {
        vi.useFakeTimers();
        fetchMock
            .mockResolvedValueOnce(new Response(null, { status: 429 }))
            .mockResolvedValueOnce(jsonResponse(grounding));

        const pending = runGrounding(REQUEST);
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toMatchObject({
            attempts: 2,
            retries: 1,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a 503", async () => {
        vi.useFakeTimers();
        fetchMock
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(jsonResponse(grounding));

        const pending = runGrounding(REQUEST);
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toMatchObject({ retries: 1 });
    });

    it("retries a transient network failure", async () => {
        vi.useFakeTimers();
        fetchMock
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(jsonResponse(grounding));

        const pending = runGrounding(REQUEST);
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toMatchObject({ retries: 1 });
    });

    it("waits for Retry-After before the next attempt", async () => {
        vi.useFakeTimers();
        fetchMock
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 429,
                    headers: { "retry-after": "3" },
                }),
            )
            .mockResolvedValueOnce(jsonResponse(grounding));

        const pending = runGrounding(REQUEST);
        await vi.advanceTimersByTimeAsync(2_500);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toMatchObject({ retries: 1 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives up as rate_limited after three throttled attempts", async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue(new Response(null, { status: 429 }));

        const pending = runGrounding(REQUEST).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10_000);

        const error = await pending;
        expect(error).toBeInstanceOf(GroundingError);
        expect((error as GroundingError).reason).toBe("rate_limited");
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("never retries a timeout", async () => {
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        fetchMock.mockRejectedValue(timeout);

        await expect(runGrounding(REQUEST)).rejects.toMatchObject({
            reason: "timeout",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never retries a rejected key", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

        await expect(runGrounding(REQUEST)).rejects.toMatchObject({
            reason: "unavailable",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never leaks Google's error body into the thrown message", async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: "secret client name" } }),
                { status: 400 },
            ),
        );

        const error = await runGrounding(REQUEST).catch(
            (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(GroundingError);
        expect((error as GroundingError).message).toBe(
            "Gemini grounding failed with status 400",
        );
    });
});

describe("empty-result pass", () => {
    it("runs one extra pass when the first returns no chunks", async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(EMPTY_PAYLOAD))
            .mockResolvedValueOnce(jsonResponse(grounding));

        await expect(groundSearch(REQUEST)).resolves.toMatchObject({
            attempts: 2,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not run an extra pass when the first pass found chunks", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(grounding));

        await groundSearch(REQUEST);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the empty first result when the extra pass fails", async () => {
        const timeout = new Error("aborted");
        timeout.name = "TimeoutError";
        fetchMock
            .mockResolvedValueOnce(jsonResponse(EMPTY_PAYLOAD))
            .mockRejectedValueOnce(timeout);

        await expect(groundSearch(REQUEST)).resolves.toMatchObject({
            metadata: { chunks: [] },
        });
    });
});
