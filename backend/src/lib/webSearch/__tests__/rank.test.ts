import { describe, expect, it } from "vitest";
import { classifyDomain, rankSources, sourceId } from "../rank";
import { sourcesFor } from "../sources";
import type { RankCandidate } from "../rank";

const sg = sourcesFor("SG");

function candidate(url: string | null, title = "t"): RankCandidate {
    return { url, title, snippet: "s" };
}

describe("authority tiers", () => {
    it.each([
        ["iras.gov.sg", "regulator"],
        ["www.iras.gov.sg", "regulator"],
        ["sso.agc.gov.sg", "official"],
        ["www.elitigation.sg", "official"],
        ["mof.gov.sg", "government"],
        ["lawsociety.org.sg", "government"],
        ["example.com", "other"],
        ["propertyguru.com.sg", "junk"],
    ] as const)("classifies %s as %s for a GST query", (domain, tier) => {
        expect(classifyDomain(domain, sg, "what is the gst rate")).toBe(tier);
    });

    it("only leads with the regulator that administers the topic", () => {
        expect(classifyDomain("iras.gov.sg", sg, "current SORA rate")).toBe(
            "government",
        );
        expect(classifyDomain("mas.gov.sg", sg, "current SORA rate")).toBe(
            "regulator",
        );
    });

    it("demotes a gov-hosted CDN bucket below a real regulator page", () => {
        expect(
            classifyDomain("isomer-user-content.by.gov.sg", sg, "gst rate"),
        ).toBe("other");
    });

    it("does not junk a government host that contains a junk marker", () => {
        expect(classifyDomain("blog.mom.gov.sg", sg, "gst rate")).toBe(
            "government",
        );
    });
});

describe("rankSources", () => {
    it("orders regulator, official, government, other", () => {
        const { results } = rankSources(
            [
                candidate("https://example.com/a"),
                candidate("https://mof.gov.sg/b"),
                candidate("https://sso.agc.gov.sg/c"),
                candidate("https://iras.gov.sg/d"),
            ],
            sg,
            "gst rate",
        );
        expect(results.map((r) => r.domain)).toEqual([
            "iras.gov.sg",
            "sso.agc.gov.sg",
            "mof.gov.sg",
            "example.com",
        ]);
        expect(results.map((r) => r.tier)).toEqual([
            "regulator",
            "official",
            "government",
            "other",
        ]);
    });

    it("keeps Gemini's order within a tier", () => {
        const { results } = rankSources(
            [
                candidate("https://b.example.com/1"),
                candidate("https://a.example.com/2"),
            ],
            sg,
            "gst rate",
        );
        expect(results.map((r) => r.domain)).toEqual([
            "b.example.com",
            "a.example.com",
        ]);
    });

    it("suppresses junk entirely when an authoritative source exists", () => {
        const { results } = rankSources(
            [
                candidate("https://propertyguru.com.sg/x"),
                candidate("https://sso.agc.gov.sg/y"),
                candidate("https://seedly.sg/z"),
            ],
            sg,
            "gst rate",
        );
        expect(results.map((r) => r.domain)).toEqual(["sso.agc.gov.sg"]);
    });

    it("lets at most two junk sources trail when nothing authoritative was found", () => {
        const { results } = rankSources(
            [
                candidate("https://propertyguru.com.sg/x"),
                candidate("https://seedly.sg/y"),
                candidate("https://moneysmart.sg/z"),
                candidate("https://example.com/plain"),
            ],
            sg,
            "gst rate",
        );
        expect(results.map((r) => r.domain)).toEqual([
            "example.com",
            "propertyguru.com.sg",
            "seedly.sg",
        ]);
    });

    it("dedupes by domain, first result wins", () => {
        const { results } = rankSources(
            [
                candidate("https://iras.gov.sg/first", "first"),
                candidate("https://iras.gov.sg/second", "second"),
                candidate("https://IRAS.gov.sg/third", "third"),
            ],
            sg,
            "gst rate",
        );
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("first");
    });

    it("caps the list at six", () => {
        const { results } = rankSources(
            Array.from({ length: 9 }, (_, i) =>
                candidate(`https://site${i}.example/x`),
            ),
            sg,
            "gst rate",
        );
        expect(results).toHaveLength(6);
    });

    it.each([
        ["an unresolved redirect", null],
        [
            "a URL still on the grounding redirect host",
            "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
        ],
        ["a non-https URL", "http://iras.gov.sg/x"],
        ["an unparseable URL", "not a url"],
    ])("drops and counts %s", (_label, url) => {
        const { results, dropped } = rankSources(
            [candidate(url), candidate("https://iras.gov.sg/ok")],
            sg,
            "gst rate",
        );
        expect(results.map((r) => r.domain)).toEqual(["iras.gov.sg"]);
        expect(dropped).toBe(1);
    });

    it("does not count dedupe or the cap as dropped sources", () => {
        const { dropped } = rankSources(
            [
                candidate("https://iras.gov.sg/a"),
                candidate("https://iras.gov.sg/b"),
            ],
            sg,
            "gst rate",
        );
        expect(dropped).toBe(0);
    });

    it("derives a stable 16-hex id from the resolved URL", () => {
        const { results } = rankSources(
            [candidate("https://iras.gov.sg/gst")],
            sg,
            "gst rate",
        );
        expect(results[0].id).toBe(sourceId("https://iras.gov.sg/gst"));
        expect(results[0].id).toMatch(/^web_[0-9a-f]{16}$/);
    });

    it("truncates a long snippet to the contract's ceiling", () => {
        const { results } = rankSources(
            [
                {
                    url: "https://iras.gov.sg/gst",
                    title: "GST",
                    snippet: "x".repeat(2000),
                },
            ],
            sg,
            "gst rate",
        );
        expect(results[0].snippet).toHaveLength(1500);
    });

    it("falls back to the domain when Gemini returned no title", () => {
        const { results } = rankSources(
            [candidate("https://iras.gov.sg/gst", "  ")],
            sg,
            "gst rate",
        );
        expect(results[0].title).toBe("iras.gov.sg");
    });
});
