# GIF-013 — Runtime Identity and Accountability Model

**Status:** Accepted  
**Date:** 2026-04-05

## Decision

GIF provides structural provisioner accountability as a guaranteed invariant. Runtime operator accountability — including the human account an AI is running as and any service account intermediary — is an adopter contractual obligation. GIF provides typed attachment points for this information but does not enforce their population.

## Context

Every persona has a provisioning human on structural record via `user_persona_assignments.external_user_id`, captured at `persona_create` time using a verified identity token. This is enforced — a persona cannot be created without it.

At runtime, GIF sees only the `persona_id` claimed on each tool call. It has no visibility into which human account the AI is currently operating under, which service or system account intermediates the call, or whether the AI making calls is the authorized holder of its `persona_id`.

## Accountability Layers

**Provisioner accountability (GIF-enforced):**  
The human who authorized persona creation is always on record. `user_persona_assignments` records `external_user_id`, `verified_identity_ref`, and `identity_provider_hint` at creation time. This is a structural guarantee — the identity token mechanism enforces it before the persona record is written.

**Runtime operator accountability (adopter obligation):**  
If an adopter's architecture includes a concept of "which human account an AI is running as" — distinct from the provisioning human — the adopter is responsible for passing that information in. The correct attachment points are `invocation_context` on session creation (for session-level identity) and `human_actor_id` on audit events (for human reviewer or approver actions). GIF does not validate or enforce population of these fields. Adopters deploying in regulated environments must populate them and enforce their own completeness checks.

**Service account intermediaries:**  
When an AI operates under a system or service account, two identities are relevant: the service account the AI is running as, and the human account responsible for instantiating the AI under that service account. Both are the adopter's responsibility to record. GIF's `invocation_context` JSONB field is the appropriate place for adopters to capture this.

## Sub-Agent Delegation

**Current assumption:** AI agents and any sub-agents they spawn operate within a single human authorization context. This assumption is expected to hold for near-term deployments.

GIF has structural support for delegation chains: `delegation_chain` records parent-child persona relationships, `invoked_by_persona_id` on `audit_events` captures the triggering persona when delegation is in play, and `max_delegation_depth` enforces depth limits. However, the human authorization thread across a delegation chain — particularly for cross-account or cross-organization sub-agent spawning — is not currently captured.

**Known future case:** Cross-account and cross-organization delegation will break the single-authorization-context assumption. When that boundary matters, `delegation_chain` and `invoked_by_persona_id` are the intended extension points for capturing the expanded authorization chain. This is a documented gap, not an oversight.

## What This Means for Adopters

Adopters must understand and accept the following:

1. GIF guarantees that every persona was authorized by a named provisioning human.
2. GIF does not guarantee that the AI making runtime tool calls is the same entity the provisioner intended to authorize — this is a runtime binding gap (see GIF-014 for the design question).
3. If runtime human identity matters to the adopter's compliance posture, the adopter must pass it in. GIF will record what is passed; it will not require it.
4. For sub-agent architectures, the human authorization chain across spawned agents is the adopter's responsibility to reconstruct from their own records and GIF's `delegation_chain` and `audit_events` tables.

## Rationale

GIF cannot know the identity architecture of every adopter deployment. Some adopters have no concept of distinct runtime operator identity — one human provisions and runs everything. Others have complex multi-user, multi-account, or multi-organization architectures. A governance framework that enforces a specific runtime identity model would fail the boundary test (GIF-012) for adopters whose architectures differ.

The correct answer is to enforce what is invariant (provisioner identity), provide typed attachment points for what varies (runtime operator identity), and document the contractual obligation clearly so adopters know what they are responsible for.

## Consequences

- `invocation_context` on sessions and `human_actor_id` on audit events are the documented attachment points for runtime identity. Their semantics must be documented for adopters.
- Any future enforcement of runtime operator identity — such as session-level AI-to-persona binding — must be introduced as an opt-in mechanism or a new structural requirement with a migration, not assumed to be present.
- The sub-agent human authorization gap is a known open item. It does not require immediate resolution, but must not be silently assumed to be handled.
