"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getUpdateInfo, type UpdateInfo } from "@/app/lib/mikeApi";

// A release check is not urgent: half an hour is often enough for the sidebar
// notice to appear during a working session without hitting GitHub (through
// the backend's own hourly cache) on every navigation.
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Latest-release state for the sidebar notice and the Updates settings page.
 * A failed check leaves the last known answer in place and never surfaces an
 * error: an unreachable GitHub must not put a red state in the app shell.
 */
export function useUpdateStatus() {
    const [info, setInfo] = useState<UpdateInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);

    const load = useCallback(async (bypassCache: boolean) => {
        try {
            const next = await getUpdateInfo(bypassCache);
            if (mountedRef.current) setInfo(next);
            return next;
        } catch {
            return null;
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        void load(false);
        const timer = setInterval(() => void load(false), CHECK_INTERVAL_MS);
        return () => {
            mountedRef.current = false;
            clearInterval(timer);
        };
    }, [load]);

    // An explicit refresh is a "check again now", so it bypasses the cache the
    // background poll is happy to read.
    const refresh = useCallback(() => load(true), [load]);

    return { info, loading, refresh };
}
