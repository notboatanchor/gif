# GIF-017 — Secrets via Environment Variables (No Bundled Vault)

**Status:** Accepted
**Date:** 2026-05-22

## Decision

GIF expects all secrets via environment variables at process startup. GIF does not bundle, integrate with, or prescribe any specific secret-management system.

The env-var contract — variable names, required vs. optional, sensitivity classification, rotation impact — is GIF's responsibility to document. The mechanism that populates those env vars at process start is the operator's responsibility.

## Context

Modern infrastructure carries many viable secret-management systems: HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Kubernetes Secrets, Doppler, Infisical, sealed-secrets, SOPS, and others. Each has its own API surface, authentication model, audit posture, and operational characteristics. An organization's choice is driven by their cloud provider, compliance regime, existing tooling, and team expertise — not by what GIF prefers.

GIF is an open-source governance framework intended to run inside diverse adopter infrastructure. A direct integration with any specific vault would couple GIF to one ecosystem and force operators in others to either accept the integration's overhead or maintain a fork. Supporting all major vaults would inflate GIF's maintenance surface with vendor-specific clients that have nothing to do with the governance work GIF actually does.

The 12-factor pattern of "secrets injected as environment variables at process startup" is universal. Every secret-management system supports it via some mechanism: Docker Compose `env_file`, Kubernetes Secrets mounted as env vars, Vault agent templates, AWS ECS task definitions with Secrets Manager references, sidecar injectors, init containers. The env-var contract is the lowest-common-denominator interface that works with every operational pattern.

## Boundary

**In scope for GIF:**
- Documenting which env vars GIF reads, their purpose, sensitivity, and rotation impact (`docs/secrets.md`)
- Reading those env vars at process startup
- Failing fast and clearly when a required secret is missing
- Documenting rotation procedures for GIF-internal secrets via operator runbooks

**Out of scope for GIF:**
- Vendor-specific vault clients in GIF source
- Bundled sidecars, init containers, or injection mechanisms
- Encryption of `.env` files at rest
- Adopter tool handler secrets (those are entirely the adopter's concern, per GIF-012 framework boundary)
- Web UI for secret rotation or management

## Rationale

**Vendor neutrality.** GIF stays usable in any infrastructure. An operator on AWS, an operator on GCP, an operator on bare-metal Kubernetes, and an operator on a single Docker host all use the same GIF, just with different injection mechanisms in front of it.

**Maintenance surface.** A capability GIF does not implement is a capability GIF does not have to maintain, patch, or deprecate. The vault integration ecosystem moves faster than GIF should.

**Framework boundary (GIF-012).** Secret management is operational, not governance. GIF governs AI tool invocation; it does not own the operator's secret-injection pipeline.

**Compatibility.** The env-var contract works with every secret-management system that exists today and every one that may exist in the future. The same GIF binary runs identically regardless of where the secrets came from.

**Auditability.** The compliance question "how do secrets get into GIF?" has one answer: env vars at process start. Auditors trace that contract to the operator's secret-management system, which has its own audit posture appropriate to that system. GIF does not need to reproduce or wrap those audit surfaces.

## Consequences

**For operators:** Secret injection is your responsibility. Use whatever vault, secret manager, or orchestration mechanism fits your environment. The env-var contract is documented in `docs/secrets.md`; populate those variables by whatever means is appropriate.

**For adopters:** Your tool handler secrets follow the same model. GIF does not store or manage your application credentials. Inject them via env vars at the MCP server's process start. This is documented in `docs/gif-plain-language-guide.md` and `docs/gif-101.md`.

**For contributors:** GIF source code reads secrets via `process.env.*` and nothing else. Do not add code that calls a vault client, fetches secrets from an API, or persists secrets to disk. If a future feature requires a new secret, it follows the env-var contract — document it in `docs/secrets.md` and add it to `.env.example`.

**For future GIF features:** Cryptographic log signing (compliance hardening roadmap) will introduce an anchor signing key. That key follows the same contract — injected via env var at process startup. Encryption at rest, when implemented, will follow the same contract for its data encryption key (DEK) reference.

## What this does not preclude

This decision rules out *bundled* vault integration in GIF core. It does not preclude:

- **Operator runbooks** describing reference patterns for common vault tools (these live in `docs/secrets.md` and `docs/runbooks/operator/`)
- **Adopter projects** that wrap GIF with their own secret-injection layer for their own deployment
- **Contributor extensions** in the "Suggested Projects" track that document, for example, a Vault-Agent-templated Docker Compose pattern as a community resource
- **Future ADRs** revisiting this decision if the operational landscape changes substantially (e.g., a universal secret-injection standard emerges that GIF would need to support to remain usable)

## Cross-references

- GIF-012 (framework boundary) — establishes the principle this decision applies to operational concerns
- GIF-003 (append-only audit trail) — `IDENTITY_HMAC_SECRET` is one of the secrets governed by this decision
- `docs/secrets.md` — the operator-facing contract this decision authorizes
