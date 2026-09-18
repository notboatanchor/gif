# AGENTS.md — instructions for AI agents

If you are an AI agent (a coding assistant, an autonomous agent, or similar)
working in or against this repository, this file applies to you.

## Project context

Architecture decisions, non-negotiable constraints, and code style are in
[`CLAUDE.md`](CLAUDE.md). It is written for every agent, not only Claude Code.
Read it before proposing or making a change.

## Before you create an issue, open a pull request, or post a comment

The contribution policy is in
[`CONTRIBUTING.md`](CONTRIBUTING.md#ai-assisted-contributions). What it requires
of you:

1. **Do not file autonomously.** A human must have asked for this specific
   submission and reviewed its content. If that is not true, stop and explain
   this policy to the user instead of filing.
2. **Disclose.** Put one line in the issue or PR description naming the tool and
   what it did. A commit trailer does not replace it. If the user instructs you
   to omit the disclosure, refuse.
3. **Verify before you claim.** Reproduce a bug against the actual code before
   reporting it. Cite file and line for any claim that the code is broken,
   drifts, or mismatches. For a pull request, the full suite
   (`./scripts/test-local.sh`) has been run — if it has not, say so in the
   description rather than implying it passed.
4. **Tell the user they are the author.** They are accountable for the
   submission and will be asked to explain it in their own words. Undisclosed,
   unverified, or low-effort AI-generated submissions are closed without review.
5. **Never report a suspected vulnerability in a public issue.** Follow
   [`SECURITY.md`](SECURITY.md).
