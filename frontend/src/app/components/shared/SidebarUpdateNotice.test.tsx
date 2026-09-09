import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateInfo, type UpdateInfo } from "@/app/lib/mikeApi";

const navigation = vi.hoisted(() => ({ pathname: "/assistant" }));

vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getUpdateInfo: vi.fn(),
}));

import { SidebarUpdateNotice } from "./SidebarUpdateNotice";

const mockedGetUpdateInfo = vi.mocked(getUpdateInfo);

const info = (overrides: Partial<UpdateInfo> = {}): UpdateInfo => ({
    current: "v1.1.0",
    latest: "v1.2.0",
    available: true,
    publishedAt: "2026-09-09T10:00:00.000Z",
    notes: null,
    url: null,
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    navigation.pathname = "/assistant";
    mockedGetUpdateInfo.mockResolvedValue(info());
});

describe("SidebarUpdateNotice", () => {
    it("points at the Updates page when a release is available", async () => {
        render(<SidebarUpdateNotice isOpen />);

        expect(
            await screen.findByText("Mike v1.2.0 is available"),
        ).toBeVisible();
        expect(screen.getByRole("link", { name: "Update" })).toHaveAttribute(
            "href",
            "/settings/updates",
        );
    });

    it("names the destination when the sidebar is collapsed", async () => {
        render(<SidebarUpdateNotice isOpen={false} />);

        expect(
            await screen.findByRole("link", {
                name: "Mike v1.2.0 is available",
            }),
        ).toHaveAttribute("href", "/settings/updates");
    });

    it("stays hidden when the installed version is current", async () => {
        mockedGetUpdateInfo.mockResolvedValue(
            info({ current: "v1.2.0", available: false }),
        );
        const { container } = render(<SidebarUpdateNotice isOpen />);

        await waitFor(() => expect(mockedGetUpdateInfo).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it("stays hidden on the Updates page itself", async () => {
        navigation.pathname = "/settings/updates";
        const { container } = render(<SidebarUpdateNotice isOpen />);

        await waitFor(() => expect(mockedGetUpdateInfo).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });
});
