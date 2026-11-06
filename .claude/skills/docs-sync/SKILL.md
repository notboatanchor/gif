---
name: docs-sync
description: "Update the code graph, bring docs/feature-map.md up to date with every commit since its synced-at marker, then make the status and orientation docs match reality. Use at prime-update, before a work item is marked done, after a release tag, or when asked to sync the docs. Changes status claims and the feature map only, never decisions or rationale."
---

# docs-sync

Status docs fall behind what shipped, because people update them by hand. A heartbeat sees commit age. It does not see a recent doc whose claims are false. This skill finds and fixes that drift for this repo, and it keeps the feature map current, so agents can find code without searching.

Repeat the doc steps until a pass finds no drift. Stop after 3 reconcile passes and report what is left.

## Scope

In scope:
- Status claims: version and recommended pin (`v0.2.x`), "done / deferred / not yet implemented" lines (the CLAUDE.md roadmap, README), and `Status:` headers in docs.
- Orientation facts: port, endpoints (`/mcp`, `/health`), tool list, stack (Node, MCP SDK, PostgreSQL versions), migration list and deploy path in `README.md`, `docs/` (including `docs/gif-101.md`) and the runbooks under `docs/runbooks/`.
- `docs/feature-map.md` (see "Feature map").

Out of scope: decisions, intent and rationale (everything under `decisions/`, the ADR and GIF-NNN records); code comments; prose quality; `CHANGELOG`-style dated records; the conformance vectors under `mcp-server/conformance/audit-record-contract/` (synced verbatim from the contract repository, never edited here).

If you cannot tell whether a line is status or a decision, do not edit it. Flag it in the report. CLAUDE.md non-negotiables are decisions: never edit them in this skill.

## Order

Do the steps in this order. Each step uses the output of the step before it:

1. Update the code graph. It is the cheapest step, and the feature map uses it.
2. Update the feature map from the commits since its marker, with the graph as input.
3. Make the status and orientation docs match reality, with the map as input.

## Step 0: Is a pass needed?

A pass is needed when: there are commits since the feature map marker, a ticket closed, a release was tagged, or Mike asked. If none of these is true, report "clean" and stop.

## Step 1: Update the code graph

CodeGraph is the local code index (symbols, callers, callees, affected tests). Update it before you read any code:

```
codegraph sync .
```

It takes seconds. In a git worktree the CodeGraph MCP tools and the CLI report "not initialized": run the CLI from the main checkout (`cd /home/mike/proj/gif && codegraph callers <symbol>`), which holds the index. Explore can miss a symbol; confirm with `codegraph node <name>` or a grep.

If `.codegraph/` does not exist, the repo is not indexed: set it up (README of the agent scaffold, "CodeGraph"), or continue without the graph and say so in the report.

## Step 2: Feature map

`docs/feature-map.md` is how build, QA and security agents find code. The format and rules are in `_planning/feature-map-format.md`. The pass is not clean until the map covers every commit up to HEAD.

1. Run the check. It prints the synced-at marker and each covered file that changed after the marker:

   ```
   python3 scripts/check_feature_map.py
   ```

2. List the commits and the changed files since the marker:

   ```
   git log --oneline <marker>..HEAD
   ```

   ```
   git diff --name-status <marker>..HEAD
   ```

3. Use the graph to find what each change touches. Do not read whole files to find this:
   - `codegraph explore "<feature or tool name>"`: the symbols, their source and the call paths.
   - `codegraph callers <symbol>`: the tools and dispatcher paths that reach a changed function.
   - `codegraph affected <changed files>`: a cross-check only, never the source of a `Tests` line. It over-reports badly. Name the tests that exercise the feature (the `mcp-server/test_*.mjs` and `mcp-server/conformance/c*.mjs` files), then use `affected` to look for one you missed.
4. For each commit that adds or changes a feature, update the map:
   - Put new MCP tools, HTTP routes, enforcement functions, migrations, CLIs, settings and tests in the feature's section. For a new feature, add a section and an index row.
   - A new tool must also be in `mcp-server/src/tools/registry.ts`; list it with its `inputSchema.required` arguments and whether it is `skipSession`.
   - A new migration must be wired into both apply-paths (`scripts/install.sh` and `ops/docker/init-db.sh`, CLAUDE.md "SQL"); name it in the feature's `Data` line.
   - Remove or rename a path in the map when the code removed or renamed it.
   - Add a new HTTP route that needs no persona to `## Public (no login) routes`.
   - Update the feature's `Verify` line when its checks changed.
   - Put the ticket, ADR or GIF-NNN number from the commit message in the `Docs` line. Do not copy the commit message.
5. A commit with no feature change (docs, tests only, tooling, `dist/` rebuild) needs no map edit.
6. Set the marker to the full sha of HEAD, and update the "Last synced" line.
7. Run the check again. It must exit 0. It proves only that each file is named and that no covered file changed after the marker. Step 4 is the real check that a new tool, route or setting got its line.

## Step 3: Status and orientation docs

1. Get ground truth for this repo:
   - `git log --oneline -20` and `git tag --sort=-creatordate | head -5` (the latest tag is the released version; adopters pin to it).
   - `python3 /home/mike/proj/Big-Brain/scripts/ledger.py search --project gif --include-closed`
   - Deploy state: gif ships no live site. It is published as release tags (adopters pin `gif-enforcement` via `git+ssh://git@github.com/notboatanchor/gif.git#v<tag>`) and run as a container from `docker-compose.yml` (services `postgres` and `mcp-server`). What is current is the latest tag plus `mcp-server/package.json` `version`; the local stack is `docker compose ps`.
   - Test gates: CI (`.github/workflows/ci.yml`): `npm run typecheck`, `npm run lint`, `npm run build`, the "dist/ in sync with src/" step, `npm run vectors` (audit record contract vectors), `npm audit --omit=dev --audit-level=high`, and the integration suite. Locally: `./scripts/test-local.sh` (runs `npm test` from `mcp-server/` against the compose stack).
   - The feature map: use it to check claims about what exists (tools, endpoints, migrations, settings).
2. For each in-scope claim, compare it with ground truth. Make a list: file, section, claimed, actual.
3. Edit the smallest span that makes each claim true. Keep the format and the voice. Do not guess. If ground truth is not clear, flag the claim. A claim that the code drifts or mismatches needs a citation (CLAUDE.md "Structural claims about the code cite their source").
4. Dated records (session logs, audits, incident reports) describe the past. Do not rewrite them. Add `<!-- historical-record -->` and one line under the title that says what changed and which doc is current.
5. Read the edited docs again against ground truth. If you find new drift, go to step 3.

## Output

Report: the drift found in each doc (claimed, actual), what you changed, what you flagged for a human, and clean or dirty. Inside prime-update, put the doc fixes in that session's commit.
