import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  Citation,
  DocumentCitation,
  WebCitation,
} from "../../shared/types";
import {
  buildCitationAppendix,
  citationTooltip,
  CitationsBlock,
} from "./CitationSources";

function documentCitation(ref: number, verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref,
    doc_id: `doc-${ref}`,
    document_id: `document-${ref}`,
    filename: `source-${ref}.pdf`,
    page: ref,
    quote: `Quote ${ref}`,
    quotes: [{ page: ref, quote: `Quote ${ref}` }],
    ...(verified === undefined ? {} : { verified }),
  };
}

const webCitation: WebCitation = {
  type: "citation_data",
  kind: "web",
  ref: 5,
  id: "web_3f9a1c2b4d5e6f70",
  url: "https://www.iras.gov.sg/taxes/goods-services-tax",
  title: "Current GST rate",
  domain: "www.iras.gov.sg",
  snippet: "The GST rate is 9% from 1 January 2024.",
  snippet_source: "search_summary",
};

const suggestion = {
  label: "gst rate singapore",
  url: "https://www.google.com/search?q=gst+rate+singapore",
};

describe("CitationsBlock verification states", () => {
  it("marks unverified document citation buttons with the error colors", () => {
    render(
      <CitationsBlock
        citations={[documentCitation(1, false), documentCitation(2)]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Citation 1. Could not verify quote",
      }),
    ).toHaveClass(
      "!bg-red-100/85",
      "!text-red-800",
      "dark:!bg-red-950",
      "dark:!text-white",
    );
    const verifiedButton = screen.getByRole("button", {
      name: "Citation 2",
    });
    expect(verifiedButton).toHaveClass("bg-gray-200/80", "text-gray-800");
  });

  it("includes only unverified warnings in citation tooltips", () => {
    expect(citationTooltip(documentCitation(3, false))).toContain(
      "Quote could not be matched to the source text.",
    );
    expect(citationTooltip(documentCitation(3, true))).not.toContain("matched");
  });

  it("leaves case citations outside document verification styling", () => {
    const citation: Citation = {
      type: "citation_data",
      kind: "case",
      ref: 4,
      cluster_id: 99,
      case_name: "Example v Example",
      quotes: [],
    };
    render(<CitationsBlock citations={[citation]} />);

    const button = screen.getByRole("button", { name: "Citation 4" });
    expect(button).toHaveClass("bg-gray-200/80", "text-gray-800");
  });

  it("adds the selected quote background only to the active citation", () => {
    const inactive = documentCitation(1);
    const active = documentCitation(2);

    render(
      <CitationsBlock
        citations={[inactive, active]}
        activeCitation={active}
      />,
    );

    expect(screen.getByRole("button", { name: "Citation 2" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Citation 2" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "Citation 1" }),
    ).not.toHaveAttribute("data-active");
  });
});

describe("CitationsBlock web sources", () => {
  it("groups web rows by url and falls back to the domain as a label", () => {
    render(
      <CitationsBlock
        citations={[
          webCitation,
          { ...webCitation, ref: 6 },
          {
            ...webCitation,
            ref: 7,
            title: "  ",
            url: "https://sso.agc.gov.sg/Act/GSTA1993",
            domain: "sso.agc.gov.sg",
          },
        ]}
      />,
    );

    // Refs 5 and 6 share a url, so they share one row.
    expect(screen.getAllByRole("button", { name: /GST/ })).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "sso.agc.gov.sg" }),
    ).toBeInTheDocument();
  });

  it("says where a web snippet came from instead of claiming verification", () => {
    expect(citationTooltip(webCitation)).toBe(
      'From search summary: "The GST rate is 9% from 1 January 2024."',
    );
    expect(
      citationTooltip({ ...webCitation, snippet_source: "citation" as const }),
    ).toBe('Direct citation: "The GST rate is 9% from 1 January 2024."');
    expect(citationTooltip(webCitation)).not.toContain("matched");
  });

  it("appends a web source as title, domain and bare url", () => {
    const appendix = buildCitationAppendix([webCitation]);

    expect(appendix.text).toContain(
      "5 Current GST rate, www.iras.gov.sg — https://www.iras.gov.sg/taxes/goods-services-tax",
    );
    expect(appendix.text).not.toContain("goods-services-tax.");
  });

  it("renders related searches only when the answer cites a web source", () => {
    const { unmount } = render(
      <CitationsBlock
        citations={[documentCitation(1)]}
        suggestions={[suggestion]}
      />,
    );
    expect(screen.queryByText("Related Google searches")).toBeNull();
    unmount();

    render(
      <CitationsBlock citations={[webCitation]} suggestions={[suggestion]} />,
    );
    expect(screen.getByText("Related Google searches")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: suggestion.label });
    expect(link).toHaveAttribute("href", suggestion.url);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
