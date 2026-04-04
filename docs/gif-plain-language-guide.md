# GIF — What It Actually Does

*A plain-language guide for technical decision-makers: what the framework is, how it works, and why it's built the way it is.*

---

## What Problem It Solves

When an AI takes action — reading a file, querying a database, calling an API — there is typically no reliable record of *why* that action was authorized, *who* authorized it, or *whether it stayed within the intended boundaries*. If something goes wrong, you cannot reconstruct what happened. If an auditor asks, you have nothing to show them.

Most existing tools solve this problem for humans: when a person logs in and does something, that gets recorded. But AI agents don't behave like people. They make autonomous decisions, call tools in non-obvious sequences, and their "identity" isn't tied to a username and password.

GIF was built to solve this specifically for AI. The question it answers: **when your AI system does something, can you prove — to a regulator, an auditor, or yourself — exactly what it did, why it was allowed to do it, and what it was blocked from doing?**

---

## What GIF Is, In Plain Terms

GIF stands for **Governed Intelligence Framework**. It is infrastructure that sits between an AI model and the tools that AI is allowed to use. Before the AI can take any action, GIF checks whether that action is permitted. Regardless of outcome — permitted or blocked — it records what happened in a log that cannot be altered after the fact.

Think of it as a combination of a **security checkpoint** and a **tamper-proof ledger** specifically designed for AI agents.

It does three things:

1. **Defines who the AI is acting as** — through a construct called a Persona, which declares what the AI's purpose is and what it's allowed to do
2. **Enforces those boundaries in real time** — at the exact moment the AI tries to use a tool, before anything happens
3. **Records everything permanently** — every permitted action, every blocked attempt, every session, in a log that cannot be changed

---

## How It Works — Step by Step

When an AI agent wants to do something (read data, write a record, run a search), here is what actually happens:

1. **The AI identifies which Persona it's acting under.** A Persona is not a user account. It's a governance identity — a declared purpose plus an explicit list of what tools and data it's allowed to touch.

2. **GIF checks the Persona.** Is it active? Has it expired? Is the specific action being requested within the declared scope? This check happens before anything executes.

3. **If permitted, the action runs.** GIF records it: what was called, what parameters were passed, which Persona authorized it, which session it belonged to.

4. **If not permitted, the action is blocked.** GIF records this too — as a "scope violation," which is treated as a first-class event, not just an error. A blocked attempt is governance evidence.

5. **At the end of a session, the record is complete.** Every action in that session is traceable back through the authorization chain: which Persona, created by whom, under what delegation of authority.

---

## The Setup — How It Runs

GIF runs on your own server. There is no cloud service, no data leaving your network, no third-party dependency for the governance layer itself.

**Infrastructure:**
- Runs as a Docker container on a self-hosted server
- PostgreSQL stores all personas, sessions, audit records, and tool registry entries
- The GIF MCP server listens on a configurable port

**Two database roles handle all access:**
- `gif_admin` — the administrative account that owns the schema and runs migrations. Used only for setup and maintenance.
- `gif_app` — the application account that the running server uses. It has exactly the permissions it needs and nothing more. Critically, it *cannot* modify or delete audit records — only insert new ones.

**Backups:**
- `pg_dump` runs daily and weekly via a systemd scheduled job
- Backups sync offsite automatically

**To reproduce the full environment from scratch:** the repository plus the `.env` file is everything needed. The installer scripts handle database setup, role creation, and schema migrations in the right order.

---

## How Adopters Use GIF

GIF is a foundation layer. Applications that need AI governance — research tools, data intelligence products, document workflows, operational systems — build on top of it rather than building their own governance infrastructure from scratch.

An adopter integrates GIF by:

1. **Importing the enforcement package** as a dependency — no modification to GIF source required
2. **Registering domain tools** against the enforcement layer — the tools themselves are the adopter's logic; GIF wraps them with enforcement
3. **Designing Personas** for the AI workloads that will run in their system — declaring purpose and scope for each governance identity
4. **Connecting their administrative interface** — however the adopter manages user identities and administrative actions, Persona creation and revocation are exposed as standard operations

A reference implementation is included in the repository that demonstrates this pattern end-to-end: three tools, three Personas, permitted calls, scope violations, and delegation. Any new product or tool integration follows the same pattern without touching GIF's core.

In practice, this means: when an AI agent touches data in an adopter's system, there is a record of it. Not a debug log — a governance record. Queryable, permanent, attributable.

---

## What GIF Does Not Do

It helps to be clear about boundaries:

- **It is not an AI model.** It doesn't generate anything. It governs what the AI can do.
- **It is not an application.** It doesn't have a user interface or a product surface. It is infrastructure.
- **It does not record *why* the AI decided to call a tool** — only that it did, with what parameters, under what authorization. The model's reasoning lives inside the model.
- **It does not protect the underlying data from authorized access.** If a Persona is allowed to read a table, GIF permits that read and records it. Whether the data in that table is sensitive is a separate question — GIF records the access, it doesn't prevent authorized access.
- **It does not manage user accounts or passwords.** It manages AI governance identities (Personas). Connecting those to real human identity systems is something you'd add on top.

---

## Glossary

**Persona**
The governance identity an AI agent acts under. Not a user account — a declared-purpose construct. Every Persona has: a stated purpose (required, cannot be blank), an explicit list of permitted tools, a validity window (start and end dates), and a delegation chain showing who created it and under what authority. AI agents don't define their own Personas — human administrators do.

**Scope**
The explicit list of what a Persona is allowed to do. This includes which tools it can call and which data resources it can access. Scope is enumerated, not implied. If something isn't in scope, the AI cannot do it — the attempt will be blocked and recorded.

**Scope Violation**
What happens when an AI attempts an action outside its Persona's declared scope. Not an error — a governance event. Scope violations are recorded as first-class records in the audit trail. They are evidence that the boundary worked.

**Session**
A bounded governance event. When an AI agent starts a task, a session opens. When it's done, the session closes. Everything the AI did during that period is grouped under a single session record. This is different from a human "session" — it's not about login state, it's about a discrete unit of AI activity that can be examined as a whole.

**Audit Trail**
The permanent record of every action taken in the system — every tool call (permitted or blocked), every session, every Persona state change. Stored in PostgreSQL with INSERT-only permissions, meaning nothing in the application layer can modify or delete a record after it's written. The trail is queryable and can reconstruct a complete picture of any session.

**Why INSERT-only matters:** The append-only constraint is enforced at the database permission level — it is not a policy or a configuration flag. The application account (`gif_app`) has no UPDATE or DELETE permission on audit tables. This means the immutability of the audit trail is a structural guarantee, not something that can be accidentally or intentionally bypassed by application code. For compliance purposes, this is a meaningful distinction: you can demonstrate that the record could not have been altered, not merely that it wasn't.

**MCP (Model Context Protocol)**
The protocol that AI models use to invoke external tools. GIF enforces at this layer — it intercepts every tool call request before it executes, checks it against the Persona's scope, and then either permits or blocks it. This is the correct enforcement point: the AI's intent is fully visible here, and it's not too late to stop something.

**Delegation Chain**
The traceable record of how a Persona was created. If an administrator creates a Persona, and that Persona is allowed to create a child Persona for a sub-task, the child carries a record of who created it and under what authority. Child Personas can only hold permissions their parent has — you cannot grant permissions you don't have. This is how multi-agent systems (AI spawning other AI) stay governed.

**Tool Registry**
The database table that records every tool the system knows about — its name, which layer it belongs to, and whether it's currently active. Tool dispatch is driven by this registry. If a tool isn't registered and active, it cannot be called, regardless of what the AI requests.

**Enforcement Engine (gif-enforcement)**
The core GIF logic, packaged as an importable module. When an adopter application needs GIF enforcement, it imports this package rather than duplicating the enforcement code. The package is declared as a versioned git dependency, pinned to a specific release tag. Updates to GIF enforcement propagate to all adopters by updating the dependency version.

**Adopter**
Any product or application that builds on top of GIF. Each adopter registers its own domain tools against the GIF enforcement layer, with its own Personas and scope definitions. Adopter schemas are separated from GIF's core schema at the database level.

**Combination Policy**
A rule that governs whether an AI should be allowed to correlate multiple data sources together. A single data source might be innocuous; two or three in combination might create a privacy risk or a liability exposure. Combination policies fire when all sources in a defined set are present in the same AI session — not just individual tool calls, but the accumulation of access across a session.

**Partition / Audit Archival**
Audit records are stored in monthly database partitions. After a defined retention period, old partitions can be retired (dropped) — but only through a governed procedure that checks for active legal holds, logs the retirement event, and requires explicit administrative action. You cannot accidentally lose audit history.

**Human Actor ID**
The identifier of the human who took an administrative action — for example, the administrator who created or revoked a Persona. Captured on audit events so that every Persona traces to a real human decision, not just an automated process.
