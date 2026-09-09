import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
    compareTags,
    currentVersion,
    fetchLatestRelease,
    updateRepo,
} from "../lib/updates";

export const systemRouter = Router();

// The updater sidecar is compose-network only and unauthenticated; the backend
// is its sole caller. Requests are short control calls, so a tight timeout is
// enough — the apply itself runs in a detached one-off container.
const UPDATER_TIMEOUT_MS = 5_000;

function updaterBaseUrl(): string {
    return (process.env.UPDATER_URL?.trim() || "http://updater:8085").replace(
        /\/+$/,
        "",
    );
}

// The version the update check offers, or null when GitHub told us nothing
// newer than what is running.
async function pendingRelease(refresh: boolean) {
    const current = currentVersion();
    const latest = await fetchLatestRelease(updateRepo(), { refresh });
    const available = latest ? compareTags(latest.tag, current) > 0 : false;
    return { current, latest, available };
}

// Current/latest version for the settings page and the sidebar notice. GitHub
// being unreachable or rate-limited is an expected state on a firm's box, so
// it reports "no update known" rather than an error.
systemRouter.get("/update", requireAuth, async (req, res) => {
    const { current, latest, available } = await pendingRelease(
        req.query.refresh === "1",
    );
    res.json({
        current,
        latest: latest?.tag ?? null,
        available,
        publishedAt: latest?.publishedAt ?? null,
        notes: latest?.notes ?? null,
        url: latest?.url ?? null,
    });
});

// Hands the apply to the updater sidecar. The tag comes from the same release
// lookup the UI saw, never from the request body: a client cannot choose which
// tag this box installs.
systemRouter.post("/update", requireAuth, async (_req, res) => {
    const { latest, available } = await pendingRelease(false);
    if (!latest || !available) {
        return void res
            .status(400)
            .json({ error: "no update available" });
    }

    let response: Response;
    try {
        response = await fetch(`${updaterBaseUrl()}/apply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag: latest.tag }),
            signal: AbortSignal.timeout(UPDATER_TIMEOUT_MS),
        });
    } catch (error) {
        console.error("[system/update] updater apply unreachable", {
            tag: latest.tag,
            error: error instanceof Error ? error.message : String(error),
        });
        return void res.status(503).json({ error: "updater unavailable" });
    }

    if (response.status === 409) {
        return void res.status(409).json({ error: "update already running" });
    }
    if (!response.ok) {
        console.error("[system/update] updater rejected the apply", {
            tag: latest.tag,
            status: response.status,
        });
        return void res.status(503).json({ error: "updater unavailable" });
    }
    res.status(202).json({ tag: latest.tag });
});

// Progress for the settings page's update view. The updater is recreated by
// the very compose run it is driving, so an unreachable sidecar mid-update is
// normal and reports as "unknown" instead of failing the poll.
systemRouter.get("/update/status", requireAuth, async (_req, res) => {
    try {
        const response = await fetch(`${updaterBaseUrl()}/status`, {
            signal: AbortSignal.timeout(UPDATER_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`updater status returned ${response.status}`);
        }
        const status = (await response.json()) as unknown;
        if (!status || typeof status !== "object" || Array.isArray(status)) {
            throw new Error("updater status was not an object");
        }
        const document = status as Record<string, unknown>;
        res.json({
            ...document,
            logTail:
                typeof document.logTail === "string" ? document.logTail : "",
        });
    } catch (error) {
        console.warn("[system/update] updater status unavailable", {
            error: error instanceof Error ? error.message : String(error),
        });
        res.json({ state: "unknown" });
    }
});
