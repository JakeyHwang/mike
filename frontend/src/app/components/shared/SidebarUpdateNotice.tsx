"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowDownToLine } from "lucide-react";
import { useUpdateStatus } from "@/app/hooks/useUpdateStatus";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";

const UPDATES_HREF = "/settings/updates";

/**
 * Sits above the account button: the only place a lawyer who never opens
 * Settings will notice that a new release exists. It disappears on the
 * Updates page itself, where the same information is the whole screen.
 */
export function SidebarUpdateNotice({ isOpen }: { isOpen: boolean }) {
    const pathname = usePathname();
    const { info } = useUpdateStatus();

    if (!info?.available || !info.latest) return null;
    if (pathname === UPDATES_HREF) return null;

    const summary = `Mike ${info.latest} is available`;

    if (!isOpen) {
        return (
            <Link
                href={UPDATES_HREF}
                aria-label={summary}
                title={summary}
                className={cn(
                    "hidden items-center justify-center rounded-xl px-2.5 py-2 text-gray-700 md:flex",
                    LIQUID_GLASS_HOVER_CLASS,
                )}
            >
                <ArrowDownToLine className="h-4 w-4" aria-hidden />
            </Link>
        );
    }

    return (
        <div
            className={cn(
                "mb-1 rounded-xl px-2.5 py-2",
                LIQUID_GLASS_SUBTLE_CLASS,
            )}
        >
            <div className="flex items-center gap-2">
                <ArrowDownToLine
                    className="h-4 w-4 shrink-0 text-gray-500"
                    aria-hidden
                />
                <p className="min-w-0 flex-1 truncate text-xs text-gray-700">
                    {summary}
                </p>
                <Link
                    href={UPDATES_HREF}
                    className={cn(
                        "shrink-0 rounded-md px-2 py-1 text-xs font-medium text-gray-900",
                        LIQUID_GLASS_HOVER_CLASS,
                    )}
                >
                    Update
                </Link>
            </div>
        </div>
    );
}
