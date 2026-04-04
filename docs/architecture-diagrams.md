# GIF Architecture Diagrams

Diagrams are Mermaid — render in GitHub, VS Code (Markdown Preview Enhanced), or any Mermaid-compatible viewer.
Edit the source blocks directly; no image tools required.

---

## 1. Request Flow — Tool Call Through Enforcement

How a single tool call travels from an AI client through gif and back.

```mermaid
sequenceDiagram
    participant AI as AI Client
    participant MCP as MCP Server<br/>(index.ts)
    participant ENF as Enforcement Engine<br/>(enforcement.ts)
    participant DB as PostgreSQL<br/>(gif schema)
    participant TOOL as Tool Handler<br/>(registry.ts)

    AI->>MCP: CallTool(tool_name, persona_id, args)

    MCP->>ENF: validatePersona(persona_id)
    ENF->>DB: SELECT from personas WHERE persona_id = $1
    DB-->>ENF: persona row (status, valid_from, valid_until, scope_definition)
    ENF-->>MCP: { valid: true, persona }

    alt persona invalid (not found / expired / suspended)
        MCP-->>AI: { isError: true, reason }
    end

    MCP->>ENF: createSession(personaId, invocationContext)
    ENF->>DB: INSERT INTO sessions → session_id
    DB-->>ENF: session_id (UUID)

    MCP->>TOOL: execute(args, persona, sessionId)

    note over TOOL: Tool checks persona.scope_definition<br/>before touching any external resource

    alt scope violation detected
        TOOL->>ENF: logScopeViolation(...)
        ENF->>DB: INSERT INTO scope_violations
    end

    alt tool declares source refs (combination policy check)
        TOOL->>ENF: checkCombinationPolicies(sessionId, personaId, sourceRefs)
        ENF->>DB: SELECT sources from audit_events for session<br/>SELECT from combination_policies WHERE active
        DB-->>ENF: candidate source set + active policies
        ENF-->>TOOL: { triggered: false } or { triggered: true, enforcementAction }
    end

    TOOL-->>MCP: result

    MCP->>ENF: logAuditEvent(personaId, sessionId, toolName, outcome, ...)
    ENF->>DB: INSERT INTO audit_events

    MCP->>ENF: closeSession(sessionId)
    ENF->>DB: UPDATE sessions SET ended_at = now()

    MCP-->>AI: result
```

---

## 2. Schema — GIF Tables and Relationships

All tables live in the `gif` schema. External objects (adopter schema) are shown separately.

```mermaid
erDiagram
    personas {
        uuid persona_id PK
        varchar issuing_entity
        varchar purpose
        varchar created_by
        jsonb scope_definition
        timestamptz valid_from
        timestamptz valid_until
        uuid parent_persona_id FK
        int max_delegation_depth
        enum status
        enum data_classification_ceiling
        uuid combination_policy_ref FK
        enum governance_review_status
    }

    sessions {
        uuid session_id PK
        uuid persona_id FK
        timestamptz started_at
        timestamptz ended_at
        jsonb invocation_context
    }

    audit_events {
        uuid event_id PK
        uuid persona_id FK
        uuid session_id FK
        uuid invoked_by_persona_id FK
        varchar event_type
        varchar tool_name
        text source_ref
        varchar outcome
        boolean flagged
        jsonb sources_touched
        text purpose_declared
        enum sensitivity_encountered
        enum output_disposition
        uuid human_actor_id
        timestamptz occurred_at
    }

    scope_violations {
        uuid violation_id PK
        uuid persona_id FK
        uuid session_id FK
        varchar attempted_action
        varchar attempted_tool
        varchar blocked_at
        boolean blocked
        jsonb context_snapshot
        timestamptz occurred_at
    }

    delegation_chain {
        uuid delegation_id PK
        uuid parent_persona_id FK
        uuid child_persona_id FK
        jsonb delegated_permissions
        int delegation_depth
        timestamptz delegated_at
        varchar delegated_by
    }

    revocation_log {
        uuid revocation_id PK
        uuid persona_id FK
        enum previous_status
        enum new_status
        text reason
        varchar revoked_by
        int active_sessions_terminated
        timestamptz revoked_at
    }

    combination_policies {
        uuid policy_id PK
        varchar policy_name
        text[] source_set
        varchar sensitivity_result
        enum enforcement_action
        uuid[] exempt_persona_ids
        boolean active
    }

    user_persona_assignments {
        uuid assignment_id PK
        uuid persona_id FK
        varchar external_user_id
        boolean token_consumed
        timestamptz token_consumed_at
        timestamptz revoked_at
    }

    audit_read_log {
        uuid read_id PK
        uuid reader_persona_id FK
        uuid reader_session_id FK
        varchar queried_table
        varchar partition_hint
        jsonb filters_applied
        int rows_returned
        text purpose_declared
        timestamptz read_at
    }

    erasure_log {
        uuid erasure_id PK
        varchar operator
        uuid[] persona_ids
        int rows_deleted
        text erasure_reason
        varchar request_reference
        varchar external_user_id
        text notes
        timestamptz erased_at
    }

    tool_registry {
        uuid tool_id PK
        varchar tool_name
        text description
        enum status
        jsonb default_constraints
        int available_from_sprint
    }

    personas ||--o{ sessions : "has"
    personas ||--o{ audit_events : "authorizes"
    personas ||--o{ scope_violations : "generates"
    personas ||--o{ revocation_log : "recorded in"
    personas ||--o{ user_persona_assignments : "assigned via"
    personas ||--o{ delegation_chain : "parent of"
    personas ||--o{ delegation_chain : "child of"
    sessions ||--o{ audit_events : "groups"
    sessions ||--o{ scope_violations : "groups"
    sessions ||--o{ audit_read_log : "groups"
    personas }o--|| combination_policies : "policy_ref (optional)"
```

> **Note:** `audit_events` is range-partitioned by month (`occurred_at`).
> Each partition is `audit_events_YYYY_MM`. Operator provisions next month's
> partition on the first working day of the preceding month.

---

## 3. Adopter Integration — What GIF Provides vs. What Adopters Supply

```mermaid
flowchart TB
    subgraph ADOPTER["Adopter MCP Server (adopter's repo)"]
        POOL["DB Pool<br/>(adopter credentials)"]
        AREG["Tool Registry<br/>(GIF tools + domain tools)"]
        ATOOLS["Domain Tool Handlers<br/>(e.g. db_read, db_write)"]
        AENV["Environment<br/>.env — DB_URL, IDENTITY_HMAC_SECRET, PORT"]
    end

    subgraph GIF["gif-enforcement (imported package, pinned by tag)"]
        CE["createEnforcement(pool)<br/>→ validatePersona<br/>→ createSession / closeSession<br/>→ logAuditEvent<br/>→ logScopeViolation<br/>→ checkCombinationPolicies<br/>→ verifyIdentityBinding<br/>→ logAuditRead"]
        GTOOLS["GIF Framework Tools<br/>persona_validate<br/>persona_create<br/>persona_revoke"]
    end

    subgraph DB["PostgreSQL — gif schema"]
        CORE["Core tables<br/>personas · sessions<br/>audit_events · scope_violations"]
        GOV["Governance tables<br/>combination_policies<br/>revocation_log · delegation_chain"]
        ID["Identity tables<br/>user_persona_assignments"]
        OPS["Ops tables<br/>audit_read_log · erasure_log<br/>tool_registry"]
    end

    subgraph EXT["External (adopter's systems)"]
        IDPROV["Identity Provider<br/>(issues external_user_id)"]
        AI["AI Client<br/>(Claude, GPT, etc.)"]
    end

    AI -->|"MCP CallTool (tool_name, persona_id, args)"| ADOPTER
    POOL -->|"injected at startup"| CE
    AREG -->|"includes"| GTOOLS
    AREG -->|"includes"| ATOOLS
    CE -->|"reads / writes"| CORE
    CE -->|"reads"| GOV
    CE -->|"reads / writes"| ID
    CE -->|"writes"| OPS
    IDPROV -->|"external_user_id mapped to persona"| ID
```

---

## 4. Persona Lifecycle

```mermaid
stateDiagram-v2
    [*] --> active : persona_create
    active --> suspended : persona_revoke (suspend)
    active --> revoked : persona_revoke (revoke)
    active --> expired : valid_until passes
    suspended --> active : persona_revoke (reactivate)
    suspended --> revoked : persona_revoke (revoke)
    revoked --> [*] : terminal — no reactivation
    expired --> [*] : terminal — no reactivation

    note right of active
        All tool calls require active status.
        validatePersona checks: status = active,
        valid_from ≤ now ≤ valid_until
    end note

    note right of revoked
        revocation_log records every
        state transition with reason
        and active_sessions_terminated
    end note
```

---

## 5. Combination Policy Check (ADR-023)

Fires before any tool execution that declares source references.

```mermaid
flowchart TD
    START([Tool declares source refs]) --> SESS{Session has<br/>prior sources?}
    SESS -->|yes| UNION["Candidate set =<br/>session sources ∪ incoming refs"]
    SESS -->|no| UNION2["Candidate set =<br/>incoming refs only"]
    UNION --> LOAD
    UNION2 --> LOAD["Load active policies<br/>from combination_policies"]
    LOAD --> EVAL{Any policy's<br/>source_set ⊆ candidate set?}
    EVAL -->|no| PASS([Proceed — no policy triggered])
    EVAL -->|yes| EXEMPT{Persona in<br/>exempt_persona_ids?}
    EXEMPT -->|yes| FLAG["Proceed with<br/>flagged audit event"]
    EXEMPT -->|no| ACTION{enforcement_action}
    ACTION -->|block| BLOCK([Block — return error to AI])
    ACTION -->|flag| FLAG2["Proceed with<br/>flagged audit event"]
    ACTION -->|require_human_review| REVIEW([Halt — human review required])

    style BLOCK fill:#c0392b,color:#fff
    style REVIEW fill:#e67e22,color:#fff
    style PASS fill:#27ae60,color:#fff
```
