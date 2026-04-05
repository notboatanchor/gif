# The Invocation Context Contract

Every tool call GIF processes is recorded in the audit trail. GIF captures what was done, under which persona, and when — from the database server clock, not the application layer. This is the structural guarantee GIF provides.

What GIF cannot know is the human and system context surrounding that call: who authorized the AI to run, which product session triggered it, which environment it ran in. This context is the adopter's responsibility to pass in. GIF provides attachment points; adopters must populate them.

This document defines what those attachment points are, what belongs in each, and what breaks if they are not populated.

---

## The Attachment Points

### `invocation_context` — on session creation

Passed when GIF creates a session record (before the first tool call in a logical invocation). This is a free-form JSONB field. GIF stores it verbatim and makes it available in audit queries.

### `human_actor_id` — on audit events

A UUID or string identifier for a human reviewer or approver acting on an event. Use this when a human is directly involved in an AI action — approving a synthesis output, reviewing a flagged event, or authorizing an override. This field has a specific semantic: it is for human action on an event, not for the human whose account the AI is running under. Use `invocation_context` for the latter.

---

## Required Fields

These fields must be present in `invocation_context` on every invocation. Without them, GIF's audit trail has a named accountability gap (GIF-013, GIF-014).

**`responsible_human_id`**  
The identifier of the human account responsible for this AI invocation. This is not the provisioning human (who is already recorded in `user_persona_assignments`) — it is the human whose account the AI is operating under right now.

For a developer running their own AI: this is their user ID.  
For an end user triggering AI capability in a product: this is their user ID in the adopter's system.  
For a scheduled or automated job with no active user: see the service account pattern below.

```json
{ "responsible_human_id": "github:scottrhodes" }
```

**Why it matters:** GIF records provisioner accountability structurally. Runtime operator accountability is not recorded unless the adopter passes it. If an AI operates under the wrong persona due to misconfiguration, the audit trail can only name the responsible party if this field is present.

---

## Strongly Recommended Fields

These fields are not required for basic GIF function, but their absence degrades the audit trail's usefulness in practice.

**`product_session_id` or `request_correlation_id`**  
The adopter's own session or request identifier. Enables joining GIF audit records with application logs, API gateway logs, and other observability systems. Without this, a GIF audit query produces a list of events with no thread back to the adopter's own systems.

```json
{ "product_session_id": "sess_01HX..." }
```

**`triggered_by`**  
What caused this invocation. Structured vocabulary helps; free text is better than nothing.

```json
{ "triggered_by": "user_action" }
// or: "scheduled_job", "webhook", "parent_agent", "api_call"
```

**Why it matters:** The audit trail shows what the AI did. Without `triggered_by`, it does not show why. Reconstructing the reason for an AI action from timestamps and tool names alone is difficult and error-prone.

**`environment`**  
The deployment environment this invocation ran in.

```json
{ "environment": "production" }
// or: "staging", "development"
```

**Why it matters:** Without environment tagging, test runs and development invocations pollute the production audit trail with no way to distinguish them after the fact. A compliance audit that includes development traffic is both misleading and difficult to explain.

---

## Patterns for Specific Scenarios

### Service account or system account

When an AI runs under a system or service account — not a specific user's account — two identities are relevant: the service account the AI is running as, and the human account responsible for the system that instantiated it.

```json
{
  "responsible_human_id": "ops-team:jane.smith",
  "service_account": "gif-pipeline-worker",
  "triggered_by": "scheduled_job",
  "job_id": "pipeline-run-20260405-0300"
}
```

The `responsible_human_id` here is the human accountable for the system — the engineer or team that owns the service account and configured the AI to run under it. This may be a team identifier rather than an individual if ownership is shared.

### AI agent spawning sub-agents

When a parent AI spawns child agents, GIF records the delegation chain via `invoked_by_persona_id` on audit events and the `delegation_chain` table. However, the human authorization context — who authorized the parent AI to spawn children — is not automatically propagated.

Each sub-agent invocation should carry the same `responsible_human_id` as the parent, plus a reference to the parent invocation:

```json
{
  "responsible_human_id": "github:scottrhodes",
  "parent_persona_id": "uuid-of-parent-persona",
  "parent_session_id": "uuid-of-parent-gif-session",
  "triggered_by": "parent_agent"
}
```

**Note:** Cross-account and cross-organization sub-agent delegation — where the child agent operates under a different human authorization context than the parent — is a known open pattern not yet addressed by GIF (GIF-013). If your architecture requires this, open an issue to discuss.

### Product feature with no active user session

Some AI capabilities run in the background with no user actively present — nightly summarization, scheduled analysis, proactive notifications. There is no active user session to reference.

```json
{
  "responsible_human_id": "system:content-pipeline",
  "service_account": "content-pipeline-worker",
  "triggered_by": "scheduled_job",
  "schedule": "nightly-0200-utc"
}
```

Use a namespaced system identifier for `responsible_human_id` rather than leaving it absent. A namespaced string is traceable; an absent field is not.

---

## Fields for Regulated-Industry Deployments

These fields are not required for general deployments but are expected in regulated-industry contexts.

**`consent_ref`**  
If the AI is processing data for which explicit user consent exists, include a reference to the consent record. This enables "show me all AI processing for users who later withdrew consent" queries without storing consent records in GIF.

```json
{ "consent_ref": "consent-record-id-from-your-system" }
```

**`data_subject_ref`**  
If the AI is processing data about a specific identifiable person, include a reference to that person (not PII — a pseudonymous ID from your system). Enables GDPR Article 15 right-of-access responses: "show me all AI access to data about this person."

```json
{ "data_subject_ref": "user-pseudonymous-id" }
```

**`ai_model_version`**  
The model and version executing this invocation. If model behavior changes across versions, the audit trail must identify which version made which calls for accountability reconstruction.

```json
{ "ai_model_version": "claude-sonnet-4-6" }
```

---

## What Breaks Without These Fields

| Missing field | What breaks |
|---|---|
| `responsible_human_id` | No runtime operator accountability. If a misconfiguration occurs, the audit trail cannot name who was responsible for the invocation. |
| `product_session_id` | GIF audit records cannot be joined with adopter application logs. Incident investigation requires manual correlation by timestamp. |
| `triggered_by` | The audit trail records what happened but not why. Behavioral analysis is degraded. |
| `environment` | Test and development traffic pollutes the production audit trail permanently — audit records are append-only and cannot be removed. |

---

## A Note on Enforcement

GIF does not validate `invocation_context` content. It stores what is passed and makes it queryable. An adopter who omits required fields gets no error — they get an audit trail with accountability gaps.

The fields marked Required above are required by contract, not by enforcement. Adopters deploying GIF in any context where audit records may be reviewed for compliance or incident response should treat these fields as mandatory and enforce their population in their own application layer before the MCP call is made.
