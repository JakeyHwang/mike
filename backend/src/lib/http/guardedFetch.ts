import dns from "dns/promises";
import net from "net";
import { Agent } from "undici";
import { isBlockedIp } from "../privateIp";

// Cloud instance-metadata endpoints answer on names that look routable but
// hand out credentials. They are rejected before any DNS lookup happens.
export const BLOCKED_METADATA_HOSTS: Record<string, true> = {
    "metadata.google.internal": true,
    "instance-data": true,
};

// Private/reserved IP classification lives in lib/privateIp.ts so every
// guarded egress check reuses the exact same ranges.

/**
 * Validate one outbound URL against the SSRF guard and return the normalized
 * URL that callers must actually request. HTTPS only; userinfo is rejected
 * rather than stripped, so a credentialed URL can never reach the network even
 * if a caller bypasses the normalized result; localhost and metadata hosts are
 * refused without a lookup; IP literals are classified directly and hostnames
 * are resolved so a name pointing at a private address is refused up front.
 */
export async function validateGuardedUrl(input: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error("Request URL must be a valid URL.");
    }
    if (url.protocol !== "https:") {
        throw new Error("Request URL must use HTTPS.");
    }
    if (url.username || url.password) {
        throw new Error("Request URL must not carry credentials.");
    }
    url.hash = "";

    const hostname = url.hostname.toLowerCase();
    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        BLOCKED_METADATA_HOSTS[hostname] === true
    ) {
        throw new Error("Request URL points to a blocked host.");
    }

    // URL.hostname wraps IPv6 literals in brackets ("[::1]"), which net.isIP
    // does not recognize. Strip them so an IPv6 literal is classified by the
    // private-IP guard rather than falling through to a DNS lookup that would
    // treat the bracketed form as an (unresolvable) hostname.
    const literalHost =
        hostname.startsWith("[") && hostname.endsWith("]")
            ? hostname.slice(1, -1)
            : hostname;
    const literalFamily = net.isIP(literalHost);
    const addresses = literalFamily
        ? [{ address: literalHost }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
        throw new Error("Request URL resolves to a blocked network address.");
    }

    return url;
}

// A shared undici dispatcher whose DNS lookup runs the private-IP guard at the
// moment a socket is opened and returns ONLY validated addresses. Because
// undici connects to exactly what this lookup yields, the address we validate is
// the address we connect to — there is no second, unguarded resolution for an
// attacker to race (DNS-rebinding / TOCTOU). Reusing the dispatcher also lets
// undici pool validated HTTPS connections instead of leaving a new Agent and
// keep-alive socket behind for every guarded request.
export const guardedAgent = new Agent({
    connect: {
        lookup: (hostname, _options, callback) => {
            dns.lookup(hostname, { all: true, verbatim: true })
                .then((addresses) => {
                    if (
                        !addresses.length ||
                        addresses.some(({ address }) => isBlockedIp(address))
                    ) {
                        callback(
                            new Error(
                                "Request URL resolves to a blocked network address.",
                            ),
                            [],
                        );
                        return;
                    }
                    callback(null, addresses);
                })
                .catch((err: unknown) =>
                    callback(
                        err instanceof Error ? err : new Error(String(err)),
                        [],
                    ),
                );
        },
    },
});

// The single guarded egress helper for every outbound request the server makes
// on a user's behalf (MCP connector transport and OAuth discovery/registration/
// refresh, web-search redirect resolution, page reads). It rejects non-HTTPS,
// credentialed, metadata-host and private-IP-literal URLs up front, requests
// the validated URL rather than the caller's raw input, pins the connection to
// a connect-time-validated address, and refuses to auto-follow redirects
// (`redirect: "manual"`) so a 3xx to an internal host cannot smuggle egress
// past the guard. A caller that must follow redirects walks each hop back
// through this helper.
export async function guardedFetch(
    input: string | URL,
    init?: RequestInit,
): Promise<Response> {
    const url = await validateGuardedUrl(
        typeof input === "string" ? input : input.toString(),
    );
    return fetch(url, {
        ...init,
        redirect: "manual",
        dispatcher: guardedAgent,
    } as RequestInit);
}
