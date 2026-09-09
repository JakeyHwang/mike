"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import type { UpdateStatus, UpdateStep } from "@/app/lib/mikeApi";

const STEPS: { step: UpdateStep; label: string }[] = [
    { step: "backup", label: "Back up the database" },
    { step: "download", label: "Download the release" },
    { step: "configure", label: "Configure" },
    { step: "pull", label: "Pull images" },
    { step: "start", label: "Start services" },
    { step: "verify", label: "Verify" },
    { step: "launcher", label: "Update the launcher" },
];

type StepState = "pending" | "running" | "done";

const STATE_LABEL: Record<StepState, string> = {
    pending: "Pending",
    running: "Running",
    done: "Done",
};

/**
 * `unknown` means the backend is being restarted by the update it is running,
 * so the step it last reported is still the one in progress.
 */
function updateStepState(
    status: UpdateStatus,
    step: UpdateStep,
): StepState {
    if (status.state === "done") return "done";
    if (status.completedSteps?.includes(step)) return "done";
    if (
        status.step === step &&
        (status.state === "running" || status.state === "unknown")
    ) {
        return "running";
    }
    return "pending";
}

export function UpdateStepList({ status }: { status: UpdateStatus }) {
    return (
        <ol className="space-y-2">
            {STEPS.map(({ step, label }) => {
                const state = updateStepState(status, step);
                return (
                    <li
                        key={step}
                        className="flex items-center justify-between gap-3"
                    >
                        <span className="flex items-center gap-2 text-sm text-gray-900">
                            {state === "done" ? (
                                <Check
                                    className="h-4 w-4 shrink-0 text-gray-700"
                                    aria-hidden
                                />
                            ) : state === "running" ? (
                                <Loader2
                                    className="h-4 w-4 shrink-0 animate-spin text-gray-700"
                                    aria-hidden
                                />
                            ) : (
                                <Circle
                                    className="h-4 w-4 shrink-0 text-gray-300"
                                    aria-hidden
                                />
                            )}
                            {label}
                        </span>
                        <span className="text-xs text-gray-500">
                            {STATE_LABEL[state]}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}
