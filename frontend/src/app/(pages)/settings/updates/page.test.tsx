import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    MikeApiError,
    getUpdateInfo,
    getUpdateStatus,
    startUpdate,
    type UpdateInfo,
    type UpdateStatus,
} from "@/app/lib/mikeApi";
import UpdatesPage from "./page";

// The page owns the whole apply flow: check → confirm → poll → outcome. These
// tests pin what the lawyer sees at each stage; the sequence itself belongs to
// the updater container.

vi.mock("@/app/lib/mikeApi", () => {
    class MockMikeApiError extends Error {
        status: number;
        constructor({ message, status }: { message: string; status: number }) {
            super(message);
            this.name = "MikeApiError";
            this.status = status;
        }
    }
    return {
        MikeApiError: MockMikeApiError,
        getUpdateInfo: vi.fn(),
        getUpdateStatus: vi.fn(),
        startUpdate: vi.fn(),
    };
});

const mockedGetUpdateInfo = vi.mocked(getUpdateInfo);
const mockedGetUpdateStatus = vi.mocked(getUpdateStatus);
const mockedStartUpdate = vi.mocked(startUpdate);

const info = (overrides: Partial<UpdateInfo> = {}): UpdateInfo => ({
    current: "v1.1.0",
    latest: "v1.2.0",
    available: true,
    publishedAt: "2026-09-09T10:00:00.000Z",
    notes: "- Adds the in-app updater",
    url: "https://example.test/releases/v1.2.0",
    ...overrides,
});

const running = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
    state: "running",
    tag: "v1.2.0",
    fromTag: "v1.1.0",
    step: "download",
    completedSteps: ["backup"],
    startedAt: "2026-09-09T10:05:00.000Z",
    finishedAt: null,
    error: null,
    logTail: "",
    ...overrides,
});

const stepRow = (label: string) =>
    screen
        .getAllByRole("listitem")
        .find((item) => within(item).queryByText(label))!;

beforeEach(() => {
    vi.clearAllMocks();
    mockedGetUpdateInfo.mockResolvedValue(info());
    mockedGetUpdateStatus.mockResolvedValue(running());
    mockedStartUpdate.mockResolvedValue({ tag: "v1.2.0" });
});

describe("UpdatesPage", () => {
    it("shows both versions and offers the update", async () => {
        render(<UpdatesPage />);

        expect(await screen.findByText("v1.1.0")).toBeVisible();
        expect(screen.getByText("v1.2.0")).toBeVisible();
        expect(screen.getByText("- Adds the in-app updater")).toBeVisible();
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Update now/ }),
            ).toBeEnabled(),
        );
    });

    it("disables the update when the installed version is the latest", async () => {
        mockedGetUpdateInfo.mockResolvedValue(
            info({ current: "v1.2.0", latest: "v1.2.0", available: false }),
        );
        render(<UpdatesPage />);

        expect(await screen.findByText("Up to date")).toBeVisible();
        expect(
            screen.getByRole("button", { name: /Update now/ }),
        ).toBeDisabled();
    });

    it("says so when the release check failed", async () => {
        mockedGetUpdateInfo.mockResolvedValue(
            info({ latest: null, available: false, publishedAt: null, notes: null }),
        );
        render(<UpdatesPage />);

        expect(await screen.findByText("Could not check")).toBeVisible();
        expect(
            screen.getByRole("button", { name: /Update now/ }),
        ).toBeDisabled();
    });

    it("confirms first, then starts the update and tracks the steps", async () => {
        const user = userEvent.setup();
        render(<UpdatesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Update now/ }),
            ).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: /Update now/ }));

        expect(screen.getByText("Update Mike to v1.2.0?")).toBeVisible();
        expect(
            screen.getByText(
                "Mike will be unavailable for about two minutes. A database backup is taken first.",
            ),
        ).toBeVisible();
        expect(mockedStartUpdate).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Update" }));

        expect(mockedStartUpdate).toHaveBeenCalledTimes(1);
        await waitFor(() =>
            expect(mockedGetUpdateStatus).toHaveBeenCalled(),
        );
        await waitFor(() =>
            expect(stepRow("Back up the database")).toHaveTextContent("Done"),
        );
        expect(stepRow("Download the release")).toHaveTextContent("Running");
        expect(stepRow("Update the launcher")).toHaveTextContent("Pending");
    });

    it("polls an update that was already running elsewhere", async () => {
        const user = userEvent.setup();
        mockedStartUpdate.mockRejectedValue(
            new MikeApiError({ message: "API error: 409", status: 409 }),
        );
        render(<UpdatesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Update now/ }),
            ).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: /Update now/ }));
        await user.click(screen.getByRole("button", { name: "Update" }));

        expect(
            await screen.findByText("An update is already running"),
        ).toBeVisible();
        await waitFor(() =>
            expect(stepRow("Back up the database")).toHaveTextContent("Done"),
        );
    });

    it("reports a failed update with its log tail", async () => {
        const user = userEvent.setup();
        mockedGetUpdateStatus.mockResolvedValue(
            running({
                state: "failed",
                step: "pull",
                error: "pull failed: manifest unknown",
                logTail: "compose pull\nError: manifest unknown",
            }),
        );
        render(<UpdatesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Update now/ }),
            ).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: /Update now/ }));
        await user.click(screen.getByRole("button", { name: "Update" }));

        expect(
            await screen.findByText("pull failed: manifest unknown"),
        ).toBeVisible();
        expect(
            screen.getByText(/Error: manifest unknown/).tagName,
        ).toBe("PRE");
    });

    it("offers a reload once the update is done", async () => {
        const user = userEvent.setup();
        mockedGetUpdateStatus.mockResolvedValue(
            running({
                state: "done",
                step: "launcher",
                completedSteps: [
                    "backup",
                    "download",
                    "configure",
                    "pull",
                    "start",
                    "verify",
                    "launcher",
                ],
                finishedAt: "2026-09-09T10:09:00.000Z",
            }),
        );
        render(<UpdatesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Update now/ }),
            ).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: /Update now/ }));
        await user.click(screen.getByRole("button", { name: "Update" }));

        expect(await screen.findByText("Updated to v1.2.0")).toBeVisible();
        expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
        expect(
            screen.getByRole("button", { name: /Update now/ }),
        ).toBeDisabled();
    });

    it("keeps showing progress while the backend restarts mid-update", async () => {
        const user = userEvent.setup();
        mockedGetUpdateStatus
            .mockResolvedValueOnce(running())
            .mockResolvedValue({ state: "unknown" });
        mockedGetUpdateInfo
            .mockResolvedValueOnce(info())
            .mockResolvedValue(
                info({ current: "v1.2.0", latest: "v1.2.0", available: false }),
            );
        render(<UpdatesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Update now/ }),
            ).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: /Update now/ }));
        await user.click(screen.getByRole("button", { name: "Update" }));

        // The unknown status alone is not success: the version the backend
        // reports after its restart is what closes the update out.
        expect(await screen.findByText("Updated to v1.2.0")).toBeVisible();
        expect(mockedGetUpdateInfo).toHaveBeenCalledWith(true);
    });
});
