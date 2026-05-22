# GIF Release Gate — Draft Spec

**Status:** Draft, not implemented. Authored 2026-04-21 during Claude Code workflow-improvement session (see `/home/scott/projects/open-questions.md`).

**Purpose:** Single command that returns a pass/fail verdict for "is this commit safe to tag as a public release?" Runs before every release tag. Intended to become `/gif-release-gate` skill once open questions below are resolved.

**Motivating context:** GIF is going open-source. Existing `-review` skills are static analysis only; the release gate adds the dynamic verification layer (eval runs, migrations against fresh DB, executable docs, benchmarks). The "prime efficiency" goal from 2026-04-21 session identified this as pillar 3 (tests as acceptance criteria) applied to a code-only project.

**Saves report to:** `ops/release-gate-reports/<iso-timestamp>/`

---

## Phases

Each phase is runnable standalone. If Phase 3 fails, iterate on the eval without rerunning Phases 1–2.

### Pre-flight (hard-fail any)
- Working tree clean; no uncommitted changes
- On a release candidate branch or tagged commit
- `CHANGELOG.md` has an entry for this version
- `package.json` version matches intended release tag
- `dist/` is fresh: run `npm run build` and verify `git diff mcp-server/dist/` is empty; stale compiled output would ship to adopters via git dep

### Phase 1 — Static correctness
Invokes `/verification-loop`.
- `npm run lint` clean
- `npm run typecheck` clean
- No TODO/FIXME markers introduced in public surface (`mcp-server/src/**/*.ts` excluding tests)

### Phase 2 — Dynamic correctness
- All `mcp-server/test_*.mjs` pass on a fresh Docker stack (no leftover state)
- Migrations apply clean on empty DB: `000_bootstrap.sql` → latest, no errors
- Migration rollback spot-check: latest down-migration runs without orphaning data

### Phase 3 — Identity framework eval
Invokes `/gif-eval`.
- Adversarial identity input set runs with pass@1 = 100%
- Delegation/combination policy eval passes
- Hash chain integrity eval passes
- Regression check: no eval that passed on previous tag is now failing

### Phase 4 — Public API contract
- Semver check: diff public exports vs. last tag. Any removed/renamed symbol without a major-version bump = fail
- JSON schema for MCP tool inputs/outputs unchanged OR version bumped accordingly
- Every exported symbol has a doc comment

### Phase 5 — Executable docs
- Every fenced code block in `README.md`, `docs/gif-101.md`, `docs/gif-plain-language-guide.md` either runs successfully or carries an explicit `<!-- no-exec -->` marker with a reason
- `CONTRIBUTING.md` setup steps produce a working dev environment from a clean clone (dry-run plan initially; full run in CI later)

### Phase 6 — Security
- `/security-audit` clean at high severity (medium allowed with documented acceptance)
- `npm audit --production` no high/critical
- No `.env` or secrets in tracked files (gitleaks or ripgrep scan for common patterns)

### Phase 7 — Dependency & license hygiene
- Every direct dep's license compatible with GIF's chosen OSS license
- No abandoned packages (last publish > 2 years with no successor)
- SBOM generated to `ops/release-gate-reports/<ts>/sbom.json`

### Phase 8 — Performance baseline
Soft-fail on first release (establishes baseline); hard-fail thereafter.
- Benchmark suite: identity resolution throughput, audit write latency, hash chain verification time
- Compare to `ops/benchmarks/baseline.json`; fail if any metric regressed > 10% without explanatory note in CHANGELOG

---

## Output Format

```
GIF Release Gate — v0.1.1 candidate
=====================================
Phase 1 Static            PASS
Phase 2 Dynamic           PASS
Phase 3 Eval              PASS (pass@1: 100%)
Phase 4 API Contract      WARN  1 renamed symbol — requires minor bump, currently patch
Phase 5 Executable Docs   FAIL  README line 142 code block fails
Phase 6 Security          PASS
Phase 7 Licenses          PASS
Phase 8 Performance       PASS (all within 2% of baseline)

Verdict: NO-GO
Blockers:
  - Phase 4: bump version to 0.2.0 or revert the rename
  - Phase 5: fix README example at line 142

Report: ops/release-gate-reports/2026-04-21T14-30/
```

---

## Design Principles

1. **Phases are independently runnable.** Iterate fast on whichever phase fails.
2. **First run establishes baselines** (benchmark numbers, eval thresholds). Subsequent runs regression-check.
3. **Executable docs are the single biggest credibility multiplier for OSS.** Prioritize Phase 5 wiring even if it starts warn-only.
4. **Does not replace `/code-review` or `/arch-review`.** Those run during development. Release gate is the final checkpoint before external exposure.
5. **Failure messages name specific file/line/metric and the minimum action to clear it.**

---

## Open Questions (resolve before implementing)

1. **Phase 3 eval threshold.** 100% across all eval classes. GIF's enforcement claims are binary (a persona is blocked or it isn't; a combination policy triggers or it doesn't; a hash chain is intact or it isn't) — probabilistic pass rates don't apply. Any failing eval case is a governance regression, not an acceptable miss rate. RESOLVED.
2. **Phase 4 semver enforcement for pre-1.0.** Hard-fail on any breaking change, or warn-and-require-override while < 1.0?
3. **Phase 6 npm audit in dev-dependencies.** Production deps only (`npm audit --production`). Dev dep vulns are tracked but do not block release — adopters receive compiled `dist/` output, not dev tooling. Exception: any dep that participates in the build pipeline producing `dist/` is treated as production for audit purposes. RESOLVED.
4. **Auto-fix scope.** Strictly read-only. The gate reports findings with enough specificity to fix quickly; it never modifies files. A gate that changes the working tree on a release candidate is harder to trust. RESOLVED.

---

## Implementation Order (once questions resolved)

1. Pre-flight + Phase 1 + Phase 2 (mostly wiring existing skills)
2. Phase 6 (security is non-negotiable for OSS)
3. Phase 4 (API contract check — custom tooling needed)
4. Phase 5 (executable docs — highest credibility payoff, custom tooling)
5. Phase 3 (relies on gif-eval maturity)
6. Phase 7 (license audit tooling)
7. Phase 8 (benchmarks — requires baseline to exist)
