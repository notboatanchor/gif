# Governed Intelligence Framework (GIF)
## Product Overview

---

## What GIF Is

The Governed Intelligence Framework (GIF) is **AI governance and structural explainability infrastructure**. It enforces authorization before AI tool execution and records every action in an append-only audit trail that is immutable at the persistence layer.

GIF sits between an AI model and the tools it can invoke. It enforces permission boundaries before execution, logs every action in a structurally immutable audit trail, and produces what can accurately be called **structural explainability infrastructure**: when a regulator asks why your AI system accessed a patient record, a financial transaction, or a sensitive document, the answer is not "the model thought it was relevant." The answer is: persona X, created by administrator Y, under delegation chain Z, invoked tool A with parameters B at timestamp C.

GIF is not an AI application. It is the governance substrate that enterprise AI applications are built on top of. The enforcement architecture is correct, the audit trail is immutable by structural guarantee, and the authorization primitives were designed from the beginning for how AI agents actually behave — not adapted from access control patterns built for human users.

---

## The Problem

Enterprise AI is moving into production. The governance infrastructure to support it is not keeping pace.

The core issue is not access control — most organizations already have access control. The issue is that existing access control was designed for human principals navigating explicit interfaces. Human authorization models assume:

- Decisions are intentional and bounded
- Scope is navigated rather than enumerated
- Session boundaries are defined by user behavior
- Exceptions are logged as anomalies, not as first-class governance events

AI agents violate every one of these assumptions. An AI agent's decision-making is non-linear and autonomous. It decides which tools to call, with what parameters, in what order, based on instructions and context that change between invocations. Its scope cannot be implicitly trusted — it must be explicitly bounded. A session is not a user's work period — it is a discrete governance event that must be traceable from start to finish regardless of how many tool calls it contains.

The result is that virtually every enterprise AI deployment today operates with a governance gap. When something goes wrong — when the AI accesses data it shouldn't have, correlates sources in ways that create liability, or takes an action that needs to be explained to a regulator — there is no answer. Not because the organization doesn't care. Because the infrastructure to produce that answer was never built.

The three unanswerable questions in most AI deployments today:

- **Why was this action authorized?** What identity, with what declared purpose and what delegation authority, permitted this specific tool call against this specific resource?
- **What happened, completely?** Is there an immutable record of every tool call — its parameters, its outcome, its session context, the chain of authority behind it?
- **What was the boundary?** When the AI exceeded its sanctioned scope, was that detected as a first-class governance event and logged with full context?

GIF was designed to make these questions answerable.

---

## Governance Primitives

GIF is **AI governance and structural explainability infrastructure**. It enforces authorization before execution and records every action in an append-only audit trail that is immutable at the persistence layer. Three primitives form the foundation.

### 1. Personas — Governance Identities for AI Principals

Personas are not service accounts. They are not user roles adapted for AI use. They are authorization primitives designed specifically for AI agents and the properties that distinguish them from human principals.

A persona carries:
- A **declared purpose** — a statement of what this governance identity exists to do. Purpose is non-nullable. A persona without a declared purpose has no governance value in the audit trail.
- A **bounded tool scope** — an explicit enumeration of what tools and resources this persona may invoke. AI agents do not navigate scope — they are bounded by it. Implicit trust is not an option.
- **Temporal validity** — valid from and valid until bounds. An AI agent running under an expired persona cannot execute tools regardless of what else is true about its configuration.
- A **delegation chain** — a traceable record of how this persona was authorized, from the root administrator through every delegation step.

Personas are administrative constructs. Human administrators create and revoke them. AI agents operate under them. This distinction is deliberate: AI governance cannot rely on the AI agent to define its own authorization. The AI identifies which persona is appropriate for a task. GIF validates that the persona is active and that the requested action falls within its declared scope.

### 2. Enforcement at the Tool Interface

GIF enforces at the Model Context Protocol (MCP) layer — the only architecturally correct enforcement point for AI governance. This matters because:

- Enforcement at the **application layer** is too early and too shallow — the AI can route around it, and the enforcement has no visibility into the actual tool parameters
- Enforcement at the **database layer** is too late — the intent has already been acted on; you can log what happened but you cannot intercept what was attempted
- Enforcement at the **MCP layer** intercepts every tool call at the point where the AI's intent is fully legible and still preventable

Every inbound tool call is checked against the invoking persona's permitted tools and permitted actions before execution. Calls that exceed scope are not silently dropped and not allowed with a warning. They are rejected and logged as **scope violation records** — first-class governance events, not error log entries. The distinction matters: a scope violation is evidence of the boundary working, and it is as important to preserve as any successful tool call.

### 3. Structural Explainability Infrastructure

The append-only audit trail is not a log file. It is a structural explainability substrate — an immutable, queryable record that answers the question every regulated AI deployment will eventually face.

Every audit record captures:

| Field | What It Answers |
|---|---|
| Persona identity | Who was this AI authorized as, and for what declared purpose? |
| Session ID | What discrete governance event did this belong to? |
| Tool name + parameters | What was requested, exactly? |
| Outcome | Was it permitted or rejected? |
| Timestamp | When did this happen? |
| Delegation chain | How was the authorizing persona created, and by whom? |

The audit tables are INSERT-only at the database permission level. No application credential — including the enforcement layer itself — can UPDATE or DELETE an audit record. This is not a policy. It is a structural constraint enforced at the persistence layer. The trail cannot be altered after the fact by any means available to an application.

This is a stronger guarantee than policy-based immutability ("we promise not to change the logs") but it is honest about its scope: INSERT-only database permissions stop application-level tampering. They do not stop a database administrator with direct infrastructure access, a backup-restore cycle that rewinds time, or a compromised superuser credential. These are real attack surfaces. The roadmap addresses them through **cryptographic log signing** — hash chains linking audit records, with periodic external timestamping, such that any gap, reordering, or modification in the audit sequence is detectable by any party holding the verification key. Until that is implemented, GIF's audit trail should be described accurately as structurally protected at the application layer, with infrastructure-level tamper evidence on the roadmap.

A complete reconstruction of any AI session's actions — every tool call, every rejection, every scope violation — is possible from the audit log alone.

---

## Multi-Agent Architecture Support

As AI deployments mature, single-agent systems give way to multi-agent architectures: a primary orchestrating agent that spawns specialized sub-agents to handle discrete tasks. This is where most governance frameworks break down entirely — they have no model for hierarchical AI authority.

GIF handles this through **delegation chain enforcement**. When a child persona is created under a parent persona:

- The child's scope must be a strict subset of the parent's scope — no child persona can hold permissions its parent does not have
- Depth limits are enforced at creation time — delegation chains cannot extend indefinitely
- The full delegation chain is written atomically when the child persona is created and is captured in every audit record the child persona generates

This means that in a multi-agent system, every sub-agent's actions are traceable back through the delegation chain to the root administrative authority that established the original scope. The authorization model does not collapse when agents spawn other agents.

Sessions are treated as **discrete governance events**, not persistent connections. Each AI invocation — whether from a primary agent or a sub-agent — is a bounded, traceable event. This is architecturally different from session models built for human users, where a session represents a continuous presence. An AI session opens, executes, and closes. The record is complete.

---

## Regulatory Framework Alignment

GIF maps directly to the two emerging AI governance standards without being explicitly structured around either. This is because GIF was built from first principles to solve the same problems these frameworks address.

### NIST AI Risk Management Framework (AI RMF)

| RMF Function | GIF Implementation |
|---|---|
| **GOVERN** — Establish accountability structures, policies, and roles for AI risk management | Persona lifecycle management, delegation chain enforcement, and administrative controls directly implement governance structure. Personas are the accountability unit — every AI action traces to a declared-purpose identity and the administrator who created it. |
| **MAP** — Identify and classify AI risks and capabilities | The tool registry is a capability inventory: every tool the AI can invoke is registered, classified by layer, and assigned an activation status. Permitted actions per persona are an explicit risk boundary, not an inferred one. |
| **MEASURE** — Analyze and assess AI risks | The append-only audit trail is the measurement substrate. Scope violations are quantified as first-class records. Point-in-time reconstruction supports post-incident analysis. |
| **MANAGE** — Prioritize and address AI risks | Scope violation detection, persona revocation with active session termination, and delegation chain constraints are operational risk management controls, not post-hoc reporting. |

### ISO/IEC 42001 — AI Management Systems

ISO 42001 requires documented AI system accountability, traceability of AI decisions, and demonstrable controls over AI system behavior. GIF's persona model, audit trail, and enforcement architecture provide the technical substrate for each of these requirements. The delegation chain maps to ISO 42001's accountability chain requirements. The append-only audit trail maps to traceability requirements. The scope enforcement model maps to documented behavioral constraints.

Neither certification is claimed. What GIF provides is the evidence base and the technical controls that compliance programs require.

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Persona lifecycle management** | Create, activate, expire, and revoke AI governance identities with full audit coverage of each state transition |
| **Delegation chain enforcement** | Child personas hold strict subsets of parent scope; depth limits enforced at creation; full chain captured in every audit record |
| **Session management** | AI invocations are discrete governance events — sessions are created, tracked, and closed as first-class records; revocation terminates all active sessions atomically |
| **Tool registry** | A structured registry of available tools and their activation status; dispatch is registry-driven, not hardwired |
| **Scope violation detection** | Calls to unpermitted tools or resources produce first-class scope violation records, not error log entries |
| **Structural audit trail** | INSERT-only database permissions; append-only by structural constraint; monthly partitioning; point-in-time reconstruction supported |
| **Enforcement packaging** | GIF enforcement is distributed as an importable package; adopter tool servers import it as a dependency without modifying GIF source |
| **Schema isolation** | GIF and adopter schemas are separated at the database level; per-adopter credentials carry only required grants |

---

## What GIF Handles

GIF is responsible for:

- Validating that a persona exists, is active, and has not expired or been revoked before any tool executes
- Enforcing that every tool call matches the invoking persona's explicitly bounded scope
- Logging every tool call outcome — permitted or rejected — in the append-only audit trail
- Logging every scope violation as a first-class governance record
- Enforcing delegation chain integrity: scope subset rules, depth limits, atomic chain writes on persona creation
- Terminating all active sessions when a persona is revoked
- Providing the tool registry that drives dispatch
- Providing the enforcement package that adopter tool servers import

GIF authorizes the call and records the authorization. What happens inside a permitted tool call — the queries it runs, the APIs it invokes — is the adopter's execution domain.

---

## The Explainability Boundary

GIF is the authorization record layer. It guarantees that the record of what was authorized is immutable and complete. It is the hard part — the part that cannot be retrofitted into a system that wasn't built for it.

There are adjacent explainability capabilities that GIF does not provide by design, and that adopters can build as extensions:

**Model reasoning trace.** GIF records that a tool was called, not why the model decided to call it. For full liability tracing, an adopter can wrap tool calls with reasoning capture before they reach GIF enforcement — the prompt context, the model's stated rationale, the chain of thought that led to the specific parameters. GIF's enforcement boundary is the correct injection point for this instrumentation.

**Semantic audit classification.** The audit trail is structured but not semantically tagged. An adopter can build a classification layer on top of the tool registry to enable queries like "show all tool calls that accessed financial data" — GIF provides the substrate; the semantic layer is an adopter extension.

**Counterfactual logging.** If the model considered calling a tool but did not, GIF has no visibility into that decision. This requires model-layer instrumentation that GIF explicitly scopes out.

The positioning is precise: GIF provides the authorization substrate and the structural audit guarantee. Model-layer explainability is an adopter extension built on top of that substrate — not a missing feature, but a correctly scoped boundary.

---

## Adopter Responsibilities

**Tool definition.** Adopters build and register the domain tools — database reads, API calls, write operations. GIF provides the enforcement wrapper and the registry; the tools are adopter domain logic.

**Persona design.** Adopters define what personas exist, what their declared purposes are, and what scope each is granted. GIF enforces the structure; adopters design it for their governance requirements.

**Runtime identity.** GIF structurally records the provisioning human for every Persona (the administrator who created it). It does not automatically capture the human whose account the AI is running under at runtime — that is the adopter's obligation. The responsible human ID must be passed in `invocation_context` on every MCP invocation. For AI operating under a service or system account, both the service account and the accountable human must be identified. For AI spawning sub-agents, the responsible human context must be propagated through the delegation chain. GIF provides attachment points; adopters must populate them. The full contract is in `docs/adopter-invocation-context.md`.

**Identity integration.** GIF defines the invariants of the user-to-persona binding model but does not integrate with identity providers. Adopters connect their user management system — SSO, LDAP, internal admin tooling — to persona administration.

**Application logic.** The AI application that determines which persona to invoke, which tools to call, and what to do with results is the adopter's concern. GIF is infrastructure, not application.

**Data security beyond governance.** Encryption at rest, network isolation, and data classification policies are adopter responsibilities. GIF records what happened; it does not protect the underlying data assets from access by authorized personas.

**Compliance interpretation.** GIF produces the evidence base. What that evidence means in the context of HIPAA, FedRAMP, SOC 2, or any other framework is the adopter's responsibility to interpret and apply.

---

## What GIF Does Not Do

- **GIF is not an AI model.** It does not generate, synthesize, or reason. It governs.
- **GIF is not an application framework.** It does not provide UI, workflow orchestration, or end-user product surface.
- **GIF is not an identity provider.** It does not manage user accounts, passwords, or SSO.
- **GIF is not a compliance product.** It produces the technical evidence base; it does not certify, validate, or interpret compliance posture.
- **GIF does not capture model reasoning.** It records what the AI invoked, not why. Reasoning trace capture is an adopter extension, not a framework responsibility.
- **GIF does not audit tool internals.** Once a tool call is authorized and dispatched, what the tool does is outside GIF's scope.
- **GIF does not provide data governance.** It governs the act of AI tool invocation, not the data those tools access or produce.

---

## Architecture

GIF deploys as a containerized MCP server. The enforcement engine is published as an importable package that adopter tool servers take as a versioned git dependency:

- The GIF enforcement surface is a versioned module — adopters update GIF by updating a package dependency, pinned to a tag via SSH reference
- Adopters register domain tools against the enforcement layer without modifying GIF source
- Multiple adopter tool servers can each carry their own GIF enforcement import, enabling independent deployment and versioning per domain

The persistence layer is PostgreSQL. Schema isolation is enforced at the database level — GIF and adopter schemas are separated, with per-adopter application credentials carrying only required grants. No adopter credential can touch another adopter's schema.

---

## Deployment Model

GIF runs inside the adopter's infrastructure. It is not a SaaS product and requires no data to leave the adopter's network. The enforcement engine, audit trail, and persona store operate entirely within the adopter's network boundary.

This deployment model matters for regulated industries — healthcare, finance, defense, legal — where data residency requirements and audit chain integrity preclude third-party SaaS governance tooling. The full stack is reproducible from the repository and environment configuration. There is no vendor lock-in at the infrastructure layer.

GIF runs under Docker Compose and is fully reproducible from the repository and an environment file.

---

## Current State

| Component | Status |
|---|---|
| Persona lifecycle (create, activate, expire, revoke) | Complete |
| MCP enforcement layer | Complete |
| Append-only audit trail (INSERT-only at database level) | Complete |
| Scope violation detection as first-class governance events | Complete |
| Delegation chain enforcement (subset rules, depth limits, atomic writes) | Complete |
| Session management as discrete governance events | Complete |
| Tool registry and registry-driven dispatch | Complete |
| Enforcement packaging (importable module) | Complete |
| Schema isolation and per-adopter credentials | Complete |

| Provisioner identity binding (identity token at persona_create) | Complete |
| Governance review gate (`governance_review_status = 'approved'` required for dispatch) | Complete |
| `admin_read` gate on personas table (prevents AI enumeration of persona UUIDs) | Complete |

Validated end-to-end: persona creation through tool execution through audit record through scope violation detection.

---

## Compliance Hardening Roadmap

GIF's architectural foundations are correct for regulated-industry deployment. The following capabilities close the gap between "architecturally sound" and "auditor-ready." The approach for each is defined; the question is sequencing.

| Item | What It Closes | Priority |
|---|---|---|
| **Cryptographic log signing** (hash chains + external timestamping) | DBA/infrastructure-level audit tampering; AU-9(3) cryptographic protection; non-repudiation for evidentiary use | Near-term — before first regulated-industry deployment |
| **Runtime session binding** (structural AI-to-persona authorization) | Closes the bearer token gap: cryptographic proof that the AI making tool calls is the authorized holder of its persona_id, not just a process that knows the UUID. Provisioner accountability is already structural (GIF-014). Session binding is a contributor project for high-assurance deployments. | Contributor project — see CONTRIBUTING.md |
| **Read-access audit logging** | Chain of custody for the audit trail itself; demonstrates that access to audit records is itself tracked | Near-term |
| **Retention policies and automated archival** | SOX 7-year retention, HIPAA 6-year minimum; automated enforcement that audit data is not prematurely destroyed; legal hold capability | Near-term |
| **Segregation of duties enforcement** | SOX ICFR requirement; prevents the same persona from performing incompatible duties | Medium-term |
| **Data-level least privilege reference architecture** | HIPAA minimum necessary; provides adopters with a documented pattern for implementing parameter-level filtering in tools | Medium-term |
| **Agent-to-agent delegation within sessions** | Primary agent spawning limited-scope child personas without administrator involvement; session-scoped creation mechanics | Medium-term |
| **Dynamic scope adjustment** | Temporary privilege elevation mid-session with audit justification; required for advanced multi-agent deployments | Medium-term |
| **Encryption at rest** | Required before productization in external customer deployments | Medium-term |
| **Multi-tenant operational hardening** | Credential rotation, tenant-specific audit export, tenant isolation testing | Medium-term |
| **Combination policy enforcement** | Evaluates sequences and combinations of tool calls, not just individual calls; closes primary gap for sophisticated multi-domain deployments | Planned |

The first four items are prerequisites for a Big 4 auditor to rely on GIF's audit trail in a SOC 2 Type II engagement. The next two are prerequisites for deployment in the highest-sensitivity regulated contexts. None require architectural changes to GIF — they are additive controls built on the existing foundation.
