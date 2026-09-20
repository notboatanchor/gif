/*
 * Copyright 2026 Notboatanchor Labs LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// src/origin-allowlist.ts
// =============================================================================
// GIF_ALLOWED_ORIGINS parsing — Origin header allowlist for DNS-rebinding
// protection (MCP 2026-07-28 Streamable HTTP, Security Warning: "Servers
// MUST validate the `Origin` header on all incoming connections to prevent
// DNS rebinding attacks").
//
// Internal helper — NOT re-exported from enforcement.ts. package.json's
// `exports` map publishes only dist/enforcement.js as the adopter-facing
// package entry point; this module has no adopter-facing purpose and must
// not become part of that surface.
//
// Why blank means default: the repository's docker-compose.yml forwards the
// variable as `${GIF_ALLOWED_ORIGINS:-}`, which reaches the container as an
// empty string, not as `undefined`, when the operator has not set it.
// "Default to localhost" must therefore treat `''` (and, defensively,
// whitespace-only) the same as unset, or every compose deployment that
// doesn't explicitly set GIF_ALLOWED_ORIGINS would run with an empty
// allowlist — rejecting every browser-originated Origin, including the SDK's
// own localhost defaults. When the variable IS set, its value REPLACES the
// default localhost allowlist rather than extending it: an operator who
// configures a production origin and still wants localhost reachable lists
// both.
// =============================================================================
import { localhostAllowedOrigins } from '@modelcontextprotocol/server';
// Environment variable name — the single literal src/index.ts and this
// module both key off, so the two can never drift apart.
export const ALLOWED_ORIGINS_ENV = 'GIF_ALLOWED_ORIGINS';
// Parses GIF_ALLOWED_ORIGINS into the hostname allowlist validateOriginHeader
// (from @modelcontextprotocol/server) expects: hostnames only, no scheme, no
// port, no path — the same convention validateHostHeader uses for Host
// allowlists. IPv6 literals are bracketed (`[::1]`), matching how the SDK's
// own hostname parser reports them.
//
// undefined / '' / whitespace-only → the SDK's own localhost defaults
// (`localhostAllowedOrigins()`: 'localhost', '127.0.0.1', '[::1]') — treated
// as "not configured", not as "configured to reject everything".
//
// Otherwise: a comma-separated list. Each item is trimmed and lowercased
// (validateOriginHeader reads the hostname through the URL parser, which
// lowercases it for http/https origins, and then compares with a
// case-sensitive Array.includes — so the allowlist must be lowercase to
// match). The parsed list REPLACES the localhost default entirely. An
// internationalized hostname must be given in its punycode (`xn--`) form,
// which is how browsers send it in the Origin header; the Unicode form fails
// the round-trip check below.
//
// Rejected outright, before any URL parsing, with a problem string naming the
// offending item:
//   - empty (a stray or trailing comma, e.g. "a,,b" or "a,")
//   - contains "://" (a scheme)
//   - contains "/" (a path)
//   - contains whitespace after trimming (an internal space)
//   - contains "*" (a wildcard — a bare URL-hostname parse would accept
//     "*.example.com" as a literal, syntactically valid hostname, so this
//     must be checked explicitly rather than left to the parser below)
// Anything that survives those checks is validated by parsing it as the
// hostname component of a synthetic `http://` URL and requiring that nothing
// else rode along: the parsed hostname must equal the item verbatim (this
// alone rejects a port, since the parser strips a port out of `.hostname`),
// and `.port`, `.pathname` (bar the implicit "/"), `.username`, `.password`,
// `.search`, and `.hash` must all be empty. A bare, unbracketed IPv6 literal
// (e.g. "::1") fails to parse as a URL at all and is rejected the same way as
// any other malformed item. Finally, a name (not a bracketed IPv6 literal)
// must consist of well-formed labels — see the comment at that check.
export function parseAllowedOrigins(raw) {
    if (raw === undefined || raw.trim() === '') {
        return { ok: true, hostnames: localhostAllowedOrigins() };
    }
    const hostnames = [];
    for (const rawItem of raw.split(',')) {
        const item = rawItem.trim().toLowerCase();
        if (item === '') {
            return {
                ok: false,
                problem: 'contains an empty entry (check for a stray or trailing comma) — hostnames only, no scheme, port, or path',
            };
        }
        if (item.includes('://')) {
            return {
                ok: false,
                problem: `entry ${JSON.stringify(item)} includes a scheme — hostnames only, no scheme, port, or path`,
            };
        }
        if (item.includes('/')) {
            return {
                ok: false,
                problem: `entry ${JSON.stringify(item)} includes a path — hostnames only, no scheme, port, or path`,
            };
        }
        if (/\s/.test(item)) {
            return {
                ok: false,
                problem: `entry ${JSON.stringify(item)} contains internal whitespace — hostnames only, no scheme, port, or path`,
            };
        }
        if (item.includes('*')) {
            return {
                ok: false,
                problem: `entry ${JSON.stringify(item)} contains a wildcard — hostnames only, no scheme, port, or path`,
            };
        }
        let url;
        try {
            url = new URL('http://' + item);
        }
        catch {
            return {
                ok: false,
                problem: `entry ${JSON.stringify(item)} is not a valid hostname — hostnames only, no scheme, port, or path`,
            };
        }
        if (url.hostname !== item ||
            url.port !== '' ||
            url.pathname !== '/' ||
            url.username !== '' ||
            url.password !== '' ||
            url.search !== '' ||
            url.hash !== '') {
            return {
                ok: false,
                problem: `entry ${JSON.stringify(item)} is not a bare hostname — hostnames only, no scheme, port, or path`,
            };
        }
        // A name (anything that is not a bracketed IPv6 literal) must be made of
        // well-formed labels: no empty label (a leading, trailing, or doubled
        // dot) and no label that starts or ends with a hyphen. The URL parser
        // above accepts all of those verbatim — "localhost." round-trips as
        // "localhost." — and the SDK compares hostnames as exact strings, so such
        // an entry matches only a page that was itself loaded through that exact
        // non-canonical name. In practice it is a copy-paste slip (a trailing dot
        // from a zone file) that leaves a dead allowlist item, so it is refused
        // at startup rather than accepted silently. Underscores are tolerated:
        // they are not valid DNS hostname characters, but the URL parser accepts
        // them and internal names use them.
        if (!item.startsWith('[')) {
            const badLabel = item.split('.').find((label) => !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(label));
            if (badLabel !== undefined) {
                return {
                    ok: false,
                    problem: `entry ${JSON.stringify(item)} is not a well-formed hostname (empty label, or a label starting or ending with "-") — hostnames only, no scheme, port, or path`,
                };
            }
        }
        hostnames.push(item);
    }
    return { ok: true, hostnames };
}
//# sourceMappingURL=origin-allowlist.js.map