# ADR-001: Commit `.claude/` Configuration to Open Source Repository

**Status:** Accepted
**Date:** 2026-03-31

## Context

gif is being prepared for open source release. The repository includes a `.claude/` directory containing Claude Code configuration: project-specific skills (workflow instructions), agent definitions, and eval harness definitions.

The question is whether this configuration should be committed to the public repository or excluded via `.gitignore`.

## Decision

Commit `.claude/skills/`, `.claude/agents/`, and `.claude/evals/*.md` to the repository. Exclude runtime and personal data via `.gitignore`.

**Committed (public):**
- `.claude/skills/` — project workflow instructions for contributors
- `.claude/agents/` — agent definitions (database-reviewer, etc.)
- `.claude/evals/*.md` — eval definitions (not run history)

**Gitignored (local only):**
- `.claude/settings.local.json` — personal settings, local paths
- `.claude/evals/*.log` — eval run history (session-specific)
- `.claude/evals/baseline.json` — local regression baseline
- `.claude/memory/` — personal memory files
- `.claude/homunculus/` — learned instincts (personal)

## Rationale

The skills and agents in `.claude/` are pure Markdown workflow instructions with no sensitive content. They describe how the project expects to be developed — the same category as `.editorconfig`, `eslint.config.js`, or a `CONTRIBUTING.md`. Committing them:

1. Helps contributors who use Claude Code work consistently with project conventions
2. Documents development patterns (TDD workflow, MCP testing approach, DB migration discipline) in an executable form
3. Signals that the project has thought-through development practices

The `.claude/` directory is analogous to IDE configuration (`.vscode/`, `.idea/`) that many projects commit when the content is team-relevant rather than personal.

## Consequences

- Contributors with Claude Code get project-appropriate workflow skills automatically
- The `gif-eval` skill (MCP tool validation harness) is visible to contributors as documentation of quality standards
- Skills must be maintained alongside code — a `mcp-server-patterns` skill that diverges from actual code patterns becomes misleading
- Personal Claude Code data (memory, instincts, local settings) remains excluded

## Related

- `.gitignore` updated to exclude local-only `.claude/` data
- Groundwork ADR record remains authoritative for cross-cutting GIF architecture decisions
- This decisions/ directory is for gif-repo-specific decisions (open source conventions, contributor experience, repo governance)
