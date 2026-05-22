# GIF-007 — gif-enforcement as Versioned Git Dependency

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

Adopters declare gif-enforcement as a tag-pinned SSH git dependency: `git+ssh://git@github.com/notboatanchor/gif.git#vX.Y.Z`. No floating branch dependencies. No `file:` references.

## Context

Adopter tool servers must build reproducibly and must be able to demonstrate which version of enforcement logic they are running. The enforcement module is security-critical infrastructure — the version in use must be auditable, and changes to enforcement behavior must require deliberate action by the adopter.

## Rationale

**Floating branches produce non-reproducible builds.** A dependency on `main` or `HEAD` means that two clean installs at different times may produce different enforcement behavior without any change to the adopter's repository. This is incompatible with the auditability requirements of a governance framework.

**Tag-pinned dependencies make the enforcement version explicit.** The version of enforcement logic in use is visible in the adopter's `package.json` and lockfile. Security audits, compliance reviews, and internal governance reviews can verify which enforcement version is deployed without inspecting the running process.

**Enforcement logic cannot change under an adopter without their action.** A version bump requires a new tag in this repository and a deliberate dependency update in the adopter repository. Enforcement behavior is stable between adopter-initiated upgrades.

## Consequences

Every gif release that changes enforcement behavior requires a new tag in this repository. Adopters choose when to upgrade by updating their dependency pin. Breaking changes in the enforcement API require a major version bump. Adopters on older pins are not automatically affected by enforcement changes — this is correct behavior for security-critical infrastructure.
