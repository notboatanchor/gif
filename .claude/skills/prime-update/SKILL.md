---
name: prime-update
description: "End-of-session update for gif: record session state, run docs-sync (orientation docs and the feature map), close finished work, commit. Run before ending work."
---

End-of-session update. Run before ending work.

## Step 1: Gather changes

```
date -u
git log --oneline --since="8 hours ago"
```

No commits -> widen to `--since="24 hours ago"`. Still none -> `git status --short`. Nothing changed -> report "No changes to record" and stop.

## Step 2: Categorize commits

Group commits by the CLAUDE.md prefixes: `feat`, `fix`, `schema`, `chore`, `docs`.

## Step 3: Update session state

Session state lives in `project-state.md` (gitignored, CLAUDE.md "Maintaining This File"). If it exists:

1. Move finished items into a Done section with what shipped.
2. Refresh "Next": add tasks the session revealed, remove completed ones.
3. Record decisions the owner made this session.

Never move session state into CLAUDE.md; it is public contributor context.

## Step 3b: Run docs-sync (orientation docs and the feature map)

Run the `docs-sync` skill. It makes every orientation doc (`README.md`, `docs/`, the runbooks) match reality, and it brings `docs/feature-map.md` up to date with every commit since its synced-at marker. Why it is a step: session state can be current while a runbook still names a retired version or port.

This step is not done until this command exits 0:

```
python3 scripts/check_feature_map.py
```

Skip it on a no-op session.

## Step 4: Close completed Big-Brain work

- Find open work: `python3 ~/proj/Big-Brain/scripts/ledger.py search --project gif`
- Close only what this session verifiably completed: `python3 ~/proj/Big-Brain/scripts/ledger.py close <id> --reason "Done in <sha>: <one line>."`
- Leave in-progress tickets open; "looks done" is not done.
- Before you close a ticket for code work, bring the feature map up to date (Step 3b). `python3 scripts/check_feature_map.py` must exit 0.
- Code or behavior work closes with proof a human can glance at (command or test output). Docs or config closes need a one-line "what I verified".

## Step 5: Commit

Gate, then commit:

```
python3 scripts/check_feature_map.py     # gate: exits 1 when the feature map misses a file or is behind
```

```
git add docs/feature-map.md [docs fixed by docs-sync]
git commit -m "docs: prime-update - [1-line summary of session work]"
```

Add files by name, no `git add .`. Changes reach `main` through a pull request (AGENTS.md); enforcement, audit and schema changes also need the review gate in CLAUDE.md. Do not push to `main`.

## Output format

```
## Prime Update - YYYY-MM-DD

### Session Summary
[2-3 sentence summary of what was accomplished]

### Changes Recorded
- project-state.md: [items moved to Done, Next refreshed] or [not present]
- docs-sync: [clean] or [drift fixed / flagged]

### Commit
[commit hash and message]

### Open Items for Next Session
[Top 3 from project-state.md "Next"]
```

$ARGUMENTS
