# GIF — What It Actually Does

*A plain-language guide for technical decision-makers: what the framework is, how it works, and why it's built the way it is.*

---

## What Problem It Solves

Here is the scenario that GIF exists to prevent.

A human provisions an AI with an API token — access credentials scoped to a permission set. The AI runs. At some point during execution, it infers something from its instructions, conflates two directives, or acts on context that wasn't fully anticipated when the token was issued. It does something it shouldn't have. Not because the human intended it. Not because the AI was malicious. Because AI systems make autonomous decisions, call tools in non-obvious sequences, and the gap between "what we meant" and "what it did" can be significant.

Nobody finds out for a week. Maybe two. By the time the outcome surfaces — a record in a wrong state, data accessed that shouldn't have been, an action taken that can't be undone — the trail is cold. You know *that* something happened. You don't know *what* the AI thought it was doing, *when* it happened, *which* specific action caused it, or *what* it touched along the way. You're doing forensics on an event that may have had downstream consequences you can no longer fully reconstruct.

This is the real problem. Not an abstract governance gap — a concrete operational reality that becomes a crisis when it intersects with regulated data, a customer record, a financial transaction, or a security boundary.

Existing tools don't solve this because they were built for humans. When a person logs in and does something, that gets recorded — because the person authenticated, navigated a defined interface, and their identity was tied to the session. AI agents don't work that way. They act under provisioned access, make decisions autonomously, and leave no contemporaneous record of what they did or why they were authorized to do it.

GIF was built to solve this specifically for AI. The question it answers: **when your AI system does something, can you prove — to a regulator, an auditor, or yourself — exactly what it did, why it was authorized to do it, and what it was blocked from doing — and can you answer that question a week later, not just in real time?**

---

## What GIF Is, In Plain Terms

GIF stands for **Governed Intelligence Framework**. It is infrastructure that sits between an AI model and the tools that AI is allowed to use. Before the AI can take any action, GIF checks whether that action is permitted. Regardless of outcome — permitted or blocked — it records what happened in a log that cannot be altered after the fact.

Think of it as a combination of a **security checkpoint** and a **tamper-proof ledger** specifically designed for AI agents.

It does four things:

1. **Defines who the AI is acting as** — through a construct called a Persona, which declares what the AI's purpose is and what it's allowed to do
2. **Enforces those boundaries in real time** — at the exact moment the AI tries to use a tool, before anything happens
3. **Catches risky combinations** — provides a check that lets adopters block calls which would complete a sensitive accumulation of data accesses across a session, not just calls that are individually out of bounds
4. **Records everything permanently** — every permitted action, every blocked attempt, every session, in a log that cannot be changed

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

**To reproduce the full environment from scratch:** the repository plus the `.env` file is everything needed. The installer scripts handle database setup, role creation, and schema migrations in the right order.

---

## How Adopters Use GIF

GIF is a foundation layer. Applications that need AI governance — research tools, data intelligence products, document workflows, operational systems — build on top of it rather than building their own governance infrastructure from scratch.

An adopter integrates GIF by:

1. **Importing the enforcement package** as a dependency — no modification to GIF source required
2. **Building tool handlers** — one handler per discrete action the AI is allowed to take against their application. `app_search`, `app_create_entry`, `app_delete` are three handlers, not one. Granularity is what makes Persona scope meaningful: if search and delete are the same tool, you cannot scope a Persona to search-only.
3. **Registering those handlers** against the enforcement layer — in code (`registry.ts`) and in the database (`tool_registry`). If a tool is not registered and active in both places, it does not exist from the AI's perspective.
4. **Managing application secrets** in environment variables accessible to the MCP server process. API keys and tokens for the adopter's application live in `.env` for development, or in the adopter's secret management infrastructure for production. GIF does not store or manage application credentials — that is the adopter's operational concern.
5. **Designing Personas** for the AI workloads that will run in their system — declaring purpose and scope for each governance identity. A general-purpose AI assistant might be scoped to read-only tools. A purpose-built automation agent running a specific workflow gets exactly the tools that workflow requires, declared explicitly.
6. **Connecting their administrative interface** — however the adopter manages user identities and administrative actions, Persona creation and revocation are exposed as standard MCP operations.
7. **Passing runtime identity on every invocation.** GIF structurally records the human who provisioned each Persona. It does not automatically capture the human whose account the AI is running under at runtime — that is the adopter's obligation. The identifier of the responsible human must be present in `invocation_context` on every MCP call. For AI running under a service or system account, the human responsible for that system must also be identified. Without this, the audit trail has a runtime accountability gap. See [`docs/adopter-invocation-context.md`](adopter-invocation-context.md) for the full contract.

A reference implementation is included in the repository that demonstrates this pattern end-to-end: tool handlers, Personas with different scope levels, permitted calls, scope violations, and delegation. Any new product or tool integration follows the same pattern without touching GIF's core.

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

This is the adopter's primary mechanism for controlling the AI's capability surface. The adopter deliberately defines what tools exist — the AI cannot reach anything that hasn't been registered. Adding a capability requires an explicit decision: write the handler, register it, and seed the registry entry. There is no implicit or default access.

**Enforcement Engine (gif-enforcement)**
The core GIF logic, packaged as an importable module. When an adopter application needs GIF enforcement, it imports this package rather than duplicating the enforcement code. The package is declared as a versioned git dependency, pinned to a specific release tag. Updates to GIF enforcement propagate to all adopters by updating the dependency version.

**Adopter**
Any product or application that builds on top of GIF. Each adopter registers its own domain tools against the GIF enforcement layer, with its own Personas and scope definitions. Adopter schemas are separated from GIF's core schema at the database level.

**Combination Policy**
A rule declaring that a specific set of data sources, accessed together within an AI session, crosses a governance boundary regardless of whether each individual access is permitted. A query for financial records may be permissible alone; a query for HR records may be permissible alone; a query for communications metadata may be permissible alone. The join of all three — across separate calls in seconds — may not be. GIF provides the policy schema and the evaluator that checks the session's accumulated source set against active policies; adopter tool handlers invoke the evaluator before executing a call that might complete a restricted combination. GIF does not invoke this check automatically — wiring it into the dispatch flow is the adopter's responsibility.

**Partition / Audit Archival**
Audit records are stored in monthly database partitions. After a defined retention period, old partitions can be retired (dropped) — but only through a governed procedure that checks for active legal holds, logs the retirement event, and requires explicit administrative action. You cannot accidentally lose audit history.

**Provisioner Accountability**
Every Persona has a provisioning human on structural record — the administrator who created it, captured at creation time via the identity token mechanism. This is a guaranteed invariant: a Persona cannot be created without a named human on record.

**Runtime Operator Accountability**
The human whose account an AI is running under at the moment it makes tool calls. This is distinct from the provisioning human and is not automatically captured by GIF — it is the adopter's obligation to pass it in on every invocation. For simple deployments, the provisioner and runtime operator are the same person. For product deployments with multiple users or service accounts, they may differ. GIF provides the attachment point (`invocation_context`); the adopter is responsible for populating it.

**Human Actor ID**
The identifier of a human who directly participated in a specific audit event — for example, a human reviewer who approved a flagged AI action or an administrator who revoked a Persona. Distinct from runtime operator identity. An absent `human_actor_id` on an event is meaningful: it indicates the event was AI-only, with no human in the loop at that moment.
