"use client";

import { createPortal } from "react-dom";
import { CircleAlert, Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import type { UpdateStatus } from "@/app/lib/mikeApi";
import { UpdateStepList } from "./UpdateStepList";

/**
 * Full-window takeover for the duration of an update. The update recreates
 * the frontend and backend containers under this page, so nothing else in the
 * app is usable meanwhile; the overlay says so instead of leaving a half-dead
 * settings page behind. It only goes away by reloading into the new version
 * (`done`) or being dismissed after a failure.
 */
export function UpdateOverlay({
    status,
    tag,
    onDismiss,
}: {
    status: UpdateStatus;
    tag: string;
    onDismiss: () => void;
}) {
    const finished = status.state === "done";
    const failed = status.state === "failed";
    const restarting = status.state === "unknown";

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-overlay-title"
            aria-live="polite"
            className="fixed inset-0 z-[240] flex items-center justify-center bg-white px-6"
        >
            <div className="w-full max-w-md space-y-6">
                {failed ? (
                    <>
                        <div className="flex items-center gap-3">
                            <CircleAlert
                                className="h-6 w-6 shrink-0 text-red-600"
                                aria-hidden
                            />
                            <h2
                                id="update-overlay-title"
                                className="font-serif text-2xl font-medium text-gray-900"
                            >
                                The update did not finish
                            </h2>
                        </div>
                        <p className="text-sm font-medium text-red-600">
                            {status.error ?? "The update did not finish."}
                        </p>
                        {status.logTail && (
                            <pre className="max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs whitespace-pre-wrap text-gray-700">
                                {status.logTail}
                            </pre>
                        )}
                        <p className="text-sm text-gray-500">
                            Mike may still be running on the previous version.
                            If it is not, run <code>MikeOSS rollback</code>{" "}
                            from the MikeOSS folder to restore the backup taken
                            before the update.
                        </p>
                        <PillButton tone="black" size="sm" onClick={onDismiss}>
                            Close
                        </PillButton>
                    </>
                ) : finished ? (
                    <>
                        <h2
                            id="update-overlay-title"
                            className="font-serif text-2xl font-medium text-gray-900"
                        >
                            Updated to {tag}
                        </h2>
                        <p className="flex items-center gap-2 text-sm text-gray-500">
                            <Loader2
                                className="h-4 w-4 shrink-0 animate-spin"
                                aria-hidden
                            />
                            Reloading Mike…
                        </p>
                    </>
                ) : (
                    <>
                        <h2
                            id="update-overlay-title"
                            className="font-serif text-2xl font-medium text-gray-900"
                        >
                            Updating Mike to {tag}
                        </h2>
                        <p className="text-sm text-gray-500">
                            Don&apos;t close this window. This takes about two
                            minutes; Mike reloads by itself when it is done.
                        </p>
                        <UpdateStepList status={status} />
                        <p className="flex min-h-5 items-center gap-2 text-sm text-gray-500">
                            {restarting && (
                                <>
                                    <Loader2
                                        className="h-4 w-4 shrink-0 animate-spin"
                                        aria-hidden
                                    />
                                    Mike is restarting…
                                </>
                            )}
                        </p>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}
