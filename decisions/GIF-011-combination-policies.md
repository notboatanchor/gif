# GIF-011 — Combination Policies and Aggregation Risk

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

`combination_policies` table with ALL-sources-present trigger logic. Pre-execution candidate set evaluation: `{sources already touched this session} ∪ {sources this call will touch}`. Enforcement engine remains stateless — no in-memory session state. Admin exemptions are governed acts: exempt admin must have `human_actor_id` populated.

## Context

Mosaic theory: individual data sources may be benign in isolation but harmful in combination. A persona with access to Source A and Source B may be authorized to use each separately; the policy engine governs whether combining them in a single session is permitted. This is a distinct threat model from single-call scope enforcement and requires dedicated evaluation logic.

Single-call scope enforcement (GIF-002) answers: is this tool call within this persona's permitted scope? Combination policy enforcement answers: given what has already happened in this session, is this call permitted as the next step?

## Rationale

**Candidate set approach covers both single-call combinations and multi-call accumulation.** Evaluating `{sources already touched this session} ∪ {sources this call will touch}` detects a policy trigger whether the combination happens in one call or builds up across multiple calls in the same session.

**Stateless evaluation.** Combination policy evaluation is a database query per call — session state is read from `audit_events`, not maintained in process memory. This avoids a single-process constraint and makes the enforcement engine horizontally scalable. Session state in memory would create deployment constraints that outweigh the performance benefit of avoiding the per-call query.

**`active = false` as kill switch.** Policies can be deactivated without data deletion, preserving the historical record of what policies existed and when they were active.

**Revocation vs. policy creation are distinct operations.** Revocation is individual trust withdrawal — a specific persona is no longer trusted. A combination policy is for emergent sensitivity patterns across multiple sources — it governs what any persona may combine, regardless of individual trust. These are different governance mechanisms and must not be conflated.

## Consequences

Combination policy evaluation is a per-call overhead. Adopters registering sources must declare source identifiers consistently — policy matching is exact. The additional query per call is acceptable at the scale gif targets; adopters with high-throughput requirements should evaluate this overhead against their deployment characteristics before enabling combination policies.
