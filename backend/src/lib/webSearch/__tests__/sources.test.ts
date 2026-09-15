import { describe, expect, it } from "vitest";
import { profileFor, sourcesFor } from "../sources";

describe("jurisdiction display name -> profile", () => {
    it.each([
        ["Singapore", "SG"],
        ["singapore", "SG"],
        ["  United Kingdom  ", "GB"],
        ["united states", "US"],
        ["Malaysia", "MY"],
        ["Australia", "AU"],
    ] as const)("maps %s to %s", (name, profile) => {
        expect(profileFor(name)).toBe(profile);
    });

    it.each([null, "", "Other", "Ireland", "constructor", "toString"])(
        "falls back to the general profile for %s",
        (name) => {
            expect(profileFor(name)).toBe("general");
        },
    );
});

describe("Singapore citation -> URL builders", () => {
    const sg = sourcesFor("SG");
    const urlsFor = (text: string) =>
        sg.citationTargets(text).map((target) => target.url);

    it.each([
        ["[2024] SGCA 12", "https://www.elitigation.sg/gd/s/2024_SGCA_12"],
        ["[2023] SGHC(I) 5", "https://www.elitigation.sg/gd/s/2023_SGHCI_5"],
        ["[2023] SGHC(A) 38", "https://www.elitigation.sg/gd/s/2023_SGHCA_38"],
        ["[2022] sghc 100", "https://www.elitigation.sg/gd/s/2022_SGHC_100"],
        ["[2023] SGMC 92", "https://www.elitigation.sg/gd/s/2023_SGMC_92"],
    ])("resolves the neutral citation %s", (text, url) => {
        expect(urlsFor(text)).toEqual([url]);
    });

    it("normalises the citation text it reports", () => {
        expect(sg.citationTargets("[ 2023 ] sghc (i) 5")).toEqual([
            {
                citation: "[2023] SGHC(I) 5",
                url: "https://www.elitigation.sg/gd/s/2023_SGHCI_5",
            },
        ]);
    });

    it.each([
        ["s 157 Companies Act", "https://sso.agc.gov.sg/Act/CoA1967"],
        ["s157 Companies Act", "https://sso.agc.gov.sg/Act/CoA1967"],
        ["section 244 of the IRDA", "https://sso.agc.gov.sg/Act/IRDA2018"],
        [
            "section 300 of the Penal Code",
            "https://sso.agc.gov.sg/Act/PC1871",
        ],
        [
            "s 6 Conveyancing and Law of Property Act",
            "https://sso.agc.gov.sg/Act/CLPA1886",
        ],
    ])("resolves the known statute reference %s", (text, url) => {
        expect(urlsFor(text)).toEqual([url]);
    });

    it("falls back to the SSO search URL for an unknown Act slug", () => {
        expect(sg.citationTargets("s 12 Widget Registration Act")).toEqual([
            {
                citation: "s12 Widget Registration Act",
                url: "https://sso.agc.gov.sg/Search/Content?Phrase=s12%20Widget%20Registration%20Act",
            },
        ]);
    });

    it("keeps Rules of Court whole instead of truncating it at 'Rules'", () => {
        expect(sg.citationTargets("s 7 Rules of Court 2021")).toEqual([
            {
                citation: "s7 Rules of Court 2021",
                url: "https://sso.agc.gov.sg/SL/ROC2021",
            },
        ]);
    });

    it.each([
        "O 9 r 11 of the Rules of Court 2021",
        "O.9 r.11 Rules of Court 2021",
        "Order 9 Rule 11 of the Rules of Court",
    ])("resolves the Order/Rule citation %s", (text) => {
        expect(sg.citationTargets(text)).toEqual([
            {
                citation: "O.9 r.11 Rules of Court 2021",
                url: "https://sso.agc.gov.sg/SL/ROC2021",
            },
        ]);
    });

    it("does not match a bare Order/Rule without the Rules of Court anchor", () => {
        expect(sg.citationTargets("see O 9 r 11 of the agreement")).toEqual([]);
    });

    it("dedupes repeated citations", () => {
        expect(
            urlsFor("[2024] SGCA 12 was applied in [2024] SGCA 12 again"),
        ).toEqual(["https://www.elitigation.sg/gd/s/2024_SGCA_12"]);
    });
});

describe("profiles without citation builders", () => {
    it.each(["MY", "AU", "GB", "US", "general"] as const)(
        "%s builds no citation URLs",
        (profile) => {
            expect(
                sourcesFor(profile).citationTargets(
                    "[2024] SGCA 12 and s 157 Companies Act",
                ),
            ).toEqual([]);
        },
    );

    it("names the jurisdiction and its official domains in the enrichment cue", () => {
        const enriched = sourcesFor("GB").enrichQuery("filing fee", "2026-09-15");
        expect(enriched).toContain("filing fee");
        expect(enriched).toContain("Jurisdiction: United Kingdom.");
        expect(enriched).toContain("Today is 2026-09-15");
        expect(enriched).toContain("legislation.gov.uk");
    });

    it("keeps domain names out of the general profile's instruction and cue", () => {
        const general = sourcesFor("general");
        expect(general.systemInstruction).not.toMatch(/\.gov|\.org|\.com/);
        expect(general.enrichQuery("gst rate", "2026-09-15")).not.toMatch(
            /\.gov|\.org|\.com/,
        );
    });

    it.each(["MY", "AU", "GB", "US", "general"] as const)(
        "%s carries no topic rules or junk markers",
        (profile) => {
            const sources = sourcesFor(profile);
            expect(sources.topicRegulatorRules).toEqual([]);
            expect(sources.lowAuthorityMarkers).toEqual([]);
            expect(sources.govCdnExclude).toEqual([]);
        },
    );

    it("keeps Singapore's ported topic rules and junk markers", () => {
        const sg = sourcesFor("SG");
        expect(
            sg.topicRegulatorRules.find((rule) => rule.pattern.test("gst rate"))
                ?.domain,
        ).toBe("iras.gov.sg");
        expect(sg.lowAuthorityMarkers).toContain("propertyguru");
        expect(sg.govCdnExclude).toContain("isomer-user-content");
    });
});
