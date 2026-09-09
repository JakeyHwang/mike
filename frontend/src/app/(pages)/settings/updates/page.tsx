"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { PillButton } from "@/app/components/ui/pill-button";
import { useUpdateStatus } from "@/app/hooks/useUpdateStatus";
import {
    MikeApiError,
    getUpdateInfo,
    getUpdateStatus,
    startUpdate,
    type UpdateStatus,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsSection } from "../SettingsSection";
import { UpdateStepList } from "./UpdateStepList";

// The update recreates the backend, so the poll has to be frequent enough to
// notice the restart window. Tests drive the same loop far faster.
const POLL_MS = process.env.NODE_ENV === "test" ? 10 : 3000;

function formatDate(iso: string) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export default function UpdatesPage() {
    const { info, loading } = useUpdateStatus();
    const [confirming, setConfirming] = useState(false);
    const [starting, setStarting] = useState(false);
    const [notice, setNotice] = useState<{
        tone: "info" | "error";
        text: string;
    } | null>(null);
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [polling, setPolling] = useState(false);
    const [expectedTag, setExpectedTag] = useState<string | null>(null);

    useEffect(() => {
        if (!polling) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const tick = async () => {
            let next: UpdateStatus;
            try {
                next = await getUpdateStatus();
            } catch {
                // The backend itself goes away while it is being recreated.
                next = { state: "unknown" };
            }
            if (cancelled) return;

            // Keep the steps the updater last reported while the backend is
            // unreachable, so the progress list does not blank out mid-update.
            setStatus((previous) =>
                next.state === "unknown" && previous
                    ? { ...previous, state: "unknown" }
                    : next,
            );

            if (next.state === "done" || next.state === "failed") {
                setPolling(false);
                return;
            }

            if (next.state === "unknown" && expectedTag) {
                // The status file lives with the updater; if it is gone the
                // version the backend reports is the only proof of success.
                const fresh = await getUpdateInfo(true).catch(() => null);
                if (cancelled) return;
                if (fresh?.current === expectedTag) {
                    setStatus((previous) => ({
                        ...(previous ?? {}),
                        state: "done",
                        tag: expectedTag,
                    }));
                    setPolling(false);
                    return;
                }
            }

            timer = setTimeout(() => void tick(), POLL_MS);
        };

        void tick();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [polling, expectedTag]);

    const handleConfirm = async () => {
        setConfirming(false);
        setStarting(true);
        setNotice(null);
        try {
            const { tag } = await startUpdate();
            setExpectedTag(tag);
            setStatus({ state: "running", tag });
            setPolling(true);
        } catch (error) {
            if (error instanceof MikeApiError && error.status === 409) {
                setNotice({
                    tone: "info",
                    text: "An update is already running",
                });
                setExpectedTag(info?.latest ?? null);
                setPolling(true);
            } else {
                setNotice({
                    tone: "error",
                    text: userFacingApiError(
                        error,
                        "Could not start the update.",
                    ),
                });
            }
        } finally {
            setStarting(false);
        }
    };

    const latestLabel = !info
        ? "—"
        : info.latest === null
          ? "Could not check"
          : info.available
            ? info.latest
            : "Up to date";
    const finished = status?.state === "done";
    const failed = status?.state === "failed";
    const finishedTag = status?.tag ?? expectedTag ?? info?.current ?? "";

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="font-serif text-2xl font-medium text-gray-900">
                    Updates
                </h2>
                <SettingsSection>
                    <dl className="divide-y divide-gray-100 px-4">
                        <UpdateRow label="Current version">
                            {loading && !info ? (
                                <SkeletonLine className="w-20" />
                            ) : (
                                (info?.current ?? "—")
                            )}
                        </UpdateRow>
                        <UpdateRow label="Latest version">
                            {loading && !info ? (
                                <SkeletonLine className="w-20" />
                            ) : (
                                latestLabel
                            )}
                        </UpdateRow>
                        <UpdateRow label="Released">
                            {loading && !info ? (
                                <SkeletonLine className="w-24" />
                            ) : info?.publishedAt ? (
                                formatDate(info.publishedAt)
                            ) : (
                                "—"
                            )}
                        </UpdateRow>
                    </dl>
                    <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-4 py-3">
                        {notice && (
                            <p
                                className={
                                    notice.tone === "error"
                                        ? "text-sm text-red-600"
                                        : "text-sm text-gray-500"
                                }
                                aria-live="polite"
                            >
                                {notice.text}
                            </p>
                        )}
                        <PillButton
                            tone="black"
                            size="sm"
                            onClick={() => setConfirming(true)}
                            disabled={
                                !info?.available ||
                                starting ||
                                polling ||
                                finished
                            }
                        >
                            {starting ? (
                                <Loader2
                                    className="h-4 w-4 shrink-0 animate-spin"
                                    aria-hidden
                                />
                            ) : (
                                <ArrowDownToLine
                                    className="h-4 w-4 shrink-0"
                                    aria-hidden
                                />
                            )}
                            Update now
                        </PillButton>
                    </div>
                </SettingsSection>
            </section>

            {info?.notes && (
                <section className="space-y-3">
                    <h3 className="font-serif text-xl font-medium text-gray-900">
                        Release notes
                    </h3>
                    <SettingsSection>
                        <pre className="overflow-x-auto p-4 font-sans text-sm whitespace-pre-wrap text-gray-700">
                            {info.notes}
                        </pre>
                    </SettingsSection>
                </section>
            )}

            {status && (
                <section className="space-y-3">
                    <h3 className="font-serif text-xl font-medium text-gray-900">
                        Progress
                    </h3>
                    <SettingsSection>
                        <div className="space-y-3 p-4" aria-live="polite">
                            {finished ? (
                                <>
                                    <p className="text-sm font-medium text-gray-900">
                                        Updated to {finishedTag}
                                    </p>
                                    <p className="text-sm text-gray-500">
                                        Reload Mike to pick up the new version.
                                    </p>
                                    <PillButton
                                        tone="black"
                                        size="sm"
                                        onClick={() =>
                                            window.location.reload()
                                        }
                                    >
                                        Reload
                                    </PillButton>
                                </>
                            ) : failed ? (
                                <>
                                    <p className="text-sm font-medium text-red-600">
                                        {status.error ??
                                            "The update did not finish."}
                                    </p>
                                    {status.logTail && (
                                        <pre className="max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs whitespace-pre-wrap text-gray-700">
                                            {status.logTail}
                                        </pre>
                                    )}
                                </>
                            ) : (
                                <UpdateStepList status={status} />
                            )}
                        </div>
                    </SettingsSection>
                </section>
            )}

            <ConfirmPopup
                open={confirming}
                title={`Update Mike to ${info?.latest ?? ""}?`}
                message="Mike will be unavailable for about two minutes. A database backup is taken first."
                confirmLabel="Update"
                onConfirm={() => void handleConfirm()}
                onCancel={() => setConfirming(false)}
            />
        </div>
    );
}

function UpdateRow({
    label,
    children,
}: {
    label: string;
    children: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3 py-3">
            <dt className="text-sm text-gray-500">{label}</dt>
            <dd className="text-sm font-medium text-gray-900">{children}</dd>
        </div>
    );
}
