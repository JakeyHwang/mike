import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent, Citation } from "../shared/types";

const SUGGESTIONS = [
    {
        label: "current gst rate singapore",
        url: "https://www.google.com/search?q=current+gst+rate+singapore",
    },
];

function settledSearch(
    overrides: Partial<Extract<AssistantEvent, { type: "web_search" }>> = {},
): AssistantEvent {
    return {
        type: "web_search",
        query: "current GST rate",
        result_count: 2,
        results: [
            {
                id: "web_2",
                title: "GST rate change explained",
                url: "https://www.example.com/gst",
                domain: "www.example.com",
                tier: "other",
            },
            {
                id: "web_1",
                title: "Current GST rates",
                url: "https://www.iras.gov.sg/taxes/gst/current-rates",
                domain: "www.iras.gov.sg",
                tier: "official",
            },
        ],
        suggestions: SUGGESTIONS,
        ...overrides,
    };
}

describe("AssistantMessage web search events", () => {
    it("labels a streaming search with the model's query", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "web_search",
                        query: "current GST rate",
                        result_count: 0,
                        results: [],
                        suggestions: [],
                        isStreaming: true,
                    },
                ]}
            />,
        );

        expect(
            screen.getByText('Searching the web for "current GST rate"'),
        ).toBeInTheDocument();
    });

    it("lists official sources first in the expanded settled search", () => {
        render(<AssistantMessage events={[settledSearch()]} />);

        const row = screen.getByRole("button", {
            name: /Searched the web for "current GST rate" — 2 sources/,
        });
        fireEvent.click(row);

        const links = screen.getAllByRole("link");
        expect(links.map((link) => link.textContent)).toEqual([
            "Current GST rates — www.iras.gov.sg",
            "GST rate change explained — www.example.com",
            "current gst rate singapore",
        ]);
        expect(links[0]).toHaveAttribute(
            "href",
            "https://www.iras.gov.sg/taxes/gst/current-rates",
        );
        expect(links[0]).toHaveAttribute("target", "_blank");
    });

    it("renders the suggestions once: in the step row without a web citation, in the Citations card with one", () => {
        const suggestionLinks = () =>
            screen
                .queryAllByRole("link")
                .filter((link) =>
                    link
                        .getAttribute("href")
                        ?.startsWith("https://www.google.com/search"),
                );

        const { unmount } = render(
            <AssistantMessage events={[settledSearch()]} />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: /Searched the web/ }),
        );
        expect(
            screen.getByText("Related Google searches:"),
        ).toBeInTheDocument();
        expect(suggestionLinks()).toHaveLength(1);
        unmount();

        const webCitation = {
            type: "citation_data",
            kind: "web",
            ref: 1,
            id: "web_1",
            url: "https://www.iras.gov.sg/taxes/gst/current-rates",
            title: "Current GST rates",
            domain: "www.iras.gov.sg",
            snippet: "The GST rate is 9%.",
            snippet_source: "search_summary",
        } as Citation;
        render(
            <AssistantMessage
                events={[settledSearch()]}
                citations={[webCitation]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: /Searched the web/ }),
        );
        expect(screen.queryByText("Related Google searches:")).toBeNull();
        expect(suggestionLinks()).toHaveLength(1);
    });

    it("reports an empty search and a failed search without free text", () => {
        const { unmount } = render(
            <AssistantMessage
                events={[
                    settledSearch({
                        result_count: 0,
                        results: [],
                        suggestions: [],
                    }),
                ]}
            />,
        );
        expect(
            screen.getByText(
                'Searched the web for "current GST rate" — no sources found',
            ),
        ).toBeInTheDocument();
        unmount();

        render(
            <AssistantMessage
                events={[
                    settledSearch({
                        result_count: 0,
                        results: [],
                        suggestions: [],
                        reason: "rate_limited",
                    }),
                ]}
            />,
        );
        expect(screen.getByText("Web search failed")).toBeInTheDocument();
        expect(
            screen.getByText(
                "temporarily unavailable — answered from knowledge",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText(/something went wrong/i)).toBeNull();
    });

    it("shows domain plus truncated path while reading, full URL in the row title", () => {
        const url =
            "https://www.iras.gov.sg/taxes/goods-services-tax-gst/current-gst-rates?view=print";
        render(
            <AssistantMessage
                events={[
                    {
                        type: "read_page",
                        url,
                        domain: "www.iras.gov.sg",
                        char_count: 0,
                        isStreaming: true,
                    },
                ]}
            />,
        );

        expect(
            screen.getByText(/^Reading www\.iras\.gov\.sg\/taxes\/.*…$/),
        ).toBeInTheDocument();
        expect(screen.getByTitle(url)).toBeInTheDocument();
    });

    it("labels a read page and a read failure from the reason map", () => {
        const { unmount } = render(
            <AssistantMessage
                events={[
                    {
                        type: "read_page",
                        url: "https://www.iras.gov.sg/taxes/gst",
                        domain: "www.iras.gov.sg",
                        title: "Goods and Services Tax",
                        kind: "html",
                        char_count: 4200,
                    },
                ]}
            />,
        );
        expect(
            screen.getByText(
                "Read www.iras.gov.sg — Goods and Services Tax",
            ),
        ).toBeInTheDocument();
        unmount();

        render(
            <AssistantMessage
                events={[
                    {
                        type: "read_page",
                        url: "https://www.iras.gov.sg/gone",
                        domain: "www.iras.gov.sg",
                        char_count: 0,
                        reason: "not_found",
                    },
                ]}
            />,
        );
        expect(
            screen.getByText("Could not read www.iras.gov.sg (page not found)"),
        ).toBeInTheDocument();
    });
});
