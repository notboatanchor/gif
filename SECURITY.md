# Security Policy

## Supported Versions

GIF is pre-1.0. Security fixes land on the current minor version line.
Older tagged releases are not back-patched.

| Version | Supported            |
| ------- | -------------------- |
| 0.1.x   | :white_check_mark:   |
| < 0.1   | :x:                  |

## Reporting a Vulnerability

**Do not file a public GitHub issue for security vulnerabilities.** Use the
private channel below so the issue can be triaged and patched before public
disclosure.

Email: **security@notboatanchor.com**

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept code, configuration, or commands)
- The affected version (tag, branch, or commit SHA)
- Your name and any disclosure preferences (credit / anonymous)

GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
is also enabled on this repository if you prefer that channel.

## What's In Scope

GIF's security boundary is the enforcement point and audit trail. The
following classes of issue are in scope:

- **Authorization bypass** — anything that lets a tool call execute despite a
  persona scope, combination policy, or governance review status that should
  have blocked it.
- **Audit trail integrity** — anything that lets an actor suppress, modify,
  delete, or forge `audit_events`, `audit_read_log`, or `scope_violations`
  entries, including via the `UPDATE`/`DELETE` paths the schema is meant to
  structurally prevent.
- **Identity binding circumvention** — anything that lets `persona_create`
  succeed without a valid, unconsumed `identity_token`, or that lets a token
  be replayed.
- **SQL injection / privilege escalation** in any GIF-owned code path.
- **Secrets exposure** — anything that causes `IDENTITY_HMAC_SECRET`,
  database credentials, or other secrets to land in logs, audit records,
  error responses, or repository contents.

## Out of Scope

- **Adopter application code.** GIF enforces authorization; what happens in
  the adopter's tool handlers after `validatePersona` returns valid is the
  adopter's responsibility (see [GIF-012: Framework Boundary](decisions/GIF-012-framework-boundary.md)).
- **`persona_id` as a bearer token.** This is a documented design property,
  not a vulnerability — see [GIF-013](decisions/GIF-013-runtime-identity-accountability.md)
  and [GIF-014](decisions/GIF-014-persona-id-bearer-token-model.md). Reports
  on structural session binding belong in the contributor project described
  in `CONTRIBUTING.md`, not this disclosure channel.
- **Denial of service via legitimate load.** GIF is single-server reference
  infrastructure. Operational hardening is the adopter's responsibility.

## Response Timeline

GIF is currently maintained by a solo maintainer. Best-effort response
targets:

- **Acknowledgement:** within 5 business days
- **Triage and severity assessment:** within 10 business days
- **Patch landed (or detailed mitigation):** depends on severity and
  complexity; communicated during triage

Coordinated disclosure is preferred. We aim to publish a fix and advisory
together, with credit to the reporter if they want it.

## Past Advisories

None at this time. Future advisories will be published as GitHub Security
Advisories on this repository.
