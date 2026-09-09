import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateInfo, type UpdateInfo } from "@/app/lib/mikeApi";
import { useUpdateStatus } from "./useUpdateStatus";

vi.mock("@/app/lib/mikeApi", () => ({
    getUpdateInfo: vi.fn(),
}));

const mockedGetUpdateInfo = vi.mocked(getUpdateInfo);

const info = (overrides: Partial<UpdateInfo> = {}): UpdateInfo => ({
    current: "v1.1.0",
    latest: "v1.2.0",
    available: true,
    publishedAt: "2026-09-09T10:00:00.000Z",
    notes: "Fixes",
    url: "https://example.test/releases/v1.2.0",
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockedGetUpdateInfo.mockResolvedValue(info());
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useUpdateStatus", () => {
    it("checks on mount and again every 30 minutes", async () => {
        vi.useFakeTimers();
        const { result, unmount } = renderHook(() => useUpdateStatus());

        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(mockedGetUpdateInfo).toHaveBeenCalledTimes(1);
        expect(mockedGetUpdateInfo).toHaveBeenLastCalledWith(false);
        expect(result.current.info?.latest).toBe("v1.2.0");
        expect(result.current.loading).toBe(false);

        await act(() => vi.advanceTimersByTimeAsync(29 * 60 * 1000));
        expect(mockedGetUpdateInfo).toHaveBeenCalledTimes(1);

        await act(() => vi.advanceTimersByTimeAsync(60 * 1000));
        expect(mockedGetUpdateInfo).toHaveBeenCalledTimes(2);

        unmount();
        await act(() => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
        expect(mockedGetUpdateInfo).toHaveBeenCalledTimes(2);
    });

    it("bypasses the cache on an explicit refresh", async () => {
        const { result } = renderHook(() => useUpdateStatus());
        await waitFor(() => expect(result.current.loading).toBe(false));

        mockedGetUpdateInfo.mockResolvedValue(
            info({ current: "v1.2.0", latest: "v1.2.0", available: false }),
        );
        await act(() => result.current.refresh());

        expect(mockedGetUpdateInfo).toHaveBeenLastCalledWith(true);
        await waitFor(() =>
            expect(result.current.info?.available).toBe(false),
        );
    });

    it("keeps the shell quiet when the check fails", async () => {
        mockedGetUpdateInfo.mockRejectedValue(new Error("offline"));
        const { result } = renderHook(() => useUpdateStatus());

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.info).toBeNull();
    });
});
