# ADR-003: Relicense from AGPL v3 to Apache License 2.0

**Status:** Accepted
**Date:** 2026-05-22

## Context

gif was initially licensed under the GNU Affero General Public License v3
(AGPL v3) with copyright held personally by Scott Rhodes. The LICENSE file
carried an explicit note that the copyright holder was subject to change if
a legal entity was formed before public release.

Three things have now changed:

1. **Entity formed.** Notboatanchor Labs LLC (Alabama) was formed
   2026-04-17. The LLC is the intended commercial vehicle for gif.

2. **IP assigned to the LLC.** The Proprietary Information and Inventions
   Agreement (PIIA v3), signed and sent 2026-05-22, carries a "for avoidance
   of doubt" carve-out in Exhibit A that explicitly assigns existing source
   code, ADRs, and design documents related to Company business to
   Notboatanchor Labs LLC. Chain of title from Scott Rhodes (personal) to
   the LLC is now clean.

3. **Standards-track contribution path requires a permissive license.**
   The project's go-to-market path includes submitting Standards Enhancement
   Proposals (SEPs) to the Model Context Protocol (a Series of LF Projects,
   LLC) with gif as a reference implementation. AGPL v3's strong copyleft
   poses adoption friction for that audience: enterprise infrastructure
   adopters routinely refuse AGPL-licensed dependencies, and a standards
   body should not need to pitch an AGPL reference implementation. Apache
   License 2.0 is the standard for the MCP ecosystem (the spec itself is
   Apache 2.0), and is the license attorneys recommended for this project's
   trajectory.

The relicense was gated on the IP assignment closing. With PIIA v3 signed
and sent, that gate is cleared.

## Decision

Relicense gif from AGPL v3 to Apache License, Version 2.0, with copyright
held by Notboatanchor Labs LLC.

**File-level changes:**

- Replace `LICENSE` with the canonical Apache 2.0 text plus the appendix
  copyright notice naming Notboatanchor Labs LLC.
- Add `NOTICE` per Apache 2.0 convention, identifying gif as a product of
  Notboatanchor Labs LLC.
- Update `README.md` license section to name Apache 2.0 and the LLC.
- Add `"license": "Apache-2.0"` to `package.json` and
  `mcp-server/package.json`.
- Add the standard Apache 2.0 short-form boilerplate to every source file
  in the repository (TypeScript, JavaScript / mjs, SQL). This is the
  attorney-recommended posture: it provides stricter-than-minimum
  protection if individual files are pulled out of context (a real concern
  for adopters who consume gif-enforcement at the file level rather than
  package level).

**Copyright statement:**

```
Copyright 2026 Notboatanchor Labs LLC
```

Single year, not a range. gif's copyright under the LLC begins in 2026 as
of the PIIA Exhibit A assignment. Pre-LLC contributions made by Scott
Rhodes are assigned forward by the PIIA carve-out; the LLC's copyright
notice covers the assigned work from the date of assignment.

## Consequences

**Positive:**

- Removes a structural adoption blocker for enterprise infrastructure
  adopters and for use as a Standards Track reference implementation.
- Aligns gif's licensing posture with the MCP ecosystem (Apache 2.0
  spec, Apache 2.0 SDK).
- Per-file boilerplate ensures correct attribution survives extraction of
  individual files from the repository.
- Attribution chain is clean: LLC is the sole copyright holder of record
  going forward; pre-LLC contributions are assigned forward by the PIIA.

**Negative:**

- Permissive licensing eliminates the strong copyleft signal that AGPL v3
  provided. Downstream adopters can build proprietary derivatives without
  contributing changes back. Acceptable trade-off — gif's commercial moat
  was never license-based; it lives in operational expertise, multi-tenant
  hardening, and the broader product suite.

- Increases the surface area for "trademark vs. license" confusion: Apache
  2.0 grants no trademark rights, but downstream adopters may still need
  reminding. Mitigated by Notboatanchor Labs LLC's Class 042 trademark
  filing (in progress) and by the trademark clause in Apache 2.0 itself
  (§6).

**Neutral:**

- The package version remains at `0.1.0`. The relicense is not a feature
  release; it is a licensing posture change. The version bump to `0.2.0`
  (or `1.0.0` for first stable release) is a separate decision tied to
  feature scope and the public-release coordination.

## Alternatives Considered

**MIT.** Rejected — Apache 2.0 provides explicit patent grant and patent
termination language that MIT lacks. For governance infrastructure that
will be referenced in standards documents, the explicit patent grant is
load-bearing.

**BSD 2-Clause / BSD 3-Clause.** Rejected for the same reason as MIT — no
patent grant.

**Dual-license AGPL + commercial.** Rejected. Commercial licensing of gif
core is not the business model. The LLC monetizes operational expertise,
hardening, and the broader product portfolio (which extends well beyond
the open-source core); none of that requires dual-licensing the core.
Dual-license also imposes contributor-side overhead (Contributor License
Agreement) for no offsetting benefit.

**Keep AGPL.** Rejected per the standards-track adoption argument above.
AGPL closes the door to the audience gif is being positioned for. No
remaining benefit justifies that cost.

## Implementation

Single commit `chore: relicense from AGPL v3 to Apache 2.0 (Notboatanchor
Labs LLC)` carries all file-level changes plus this ADR. The dist/ tree is
rebuilt as part of the same commit so compiled output also carries the
header.

No tag is cut at this commit. Tagging is a separate decision tied to the
public-release coordination event.
