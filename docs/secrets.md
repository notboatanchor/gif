# Secrets — The Contract

GIF reads all secrets from environment variables at process startup. GIF does not bundle, integrate with, or prescribe a specific secret-management system. Whatever vault, secret manager, or orchestration mechanism you use is fine — populate the environment, then start GIF.

This decision is recorded in [`decisions/GIF-017-secrets-via-env-vars.md`](../decisions/GIF-017-secrets-via-env-vars.md).

---

## What GIF needs

### Secrets (sensitive — protect like passwords)

| Variable | Purpose | Rotation impact |
|---|---|---|
| `POSTGRES_PASSWORD` | Docker-managed PostgreSQL superuser password. Used only by the `postgres` container during initialization. Not used by the MCP server at runtime. | Restart `postgres` container; gif_admin and gif_app passwords must be reset if they were derived from this. |
| `GIF_ADMIN_PASSWORD` | Password for the `gif_admin` PostgreSQL role. Schema owner; runs migrations. Not used by the MCP server at runtime. | Restart any process running as `gif_admin` (typically migration tooling); MCP server is unaffected. |
| `GIF_APP_PASSWORD` (also `PGPASSWORD` for the MCP server's connection) | Password for the `gif_app` PostgreSQL role. The MCP server connects as `gif_app` for all runtime operations. | Restart the MCP server. Active sessions in flight may fail. |
| `IDENTITY_HMAC_SECRET` | HMAC signing key for identity tokens issued by the `bin/issue_identity_token.ts` CLI and verified at `persona_create`. **Load-bearing.** | Rotating invalidates all unconsumed identity tokens. See [Rotation procedures](#rotation-procedures) below. |

### Non-secret configuration (still required, but not sensitive)

| Variable | Purpose | Default |
|---|---|---|
| `PGDATABASE` | Database name | `gif` |
| `PGHOST` | Postgres host (the MCP server connects here) | `postgres` (Docker Compose); `localhost` (tests) |
| `PGPORT` | Postgres port (inside the container/network) | `5432` |
| `PGPORT_HOST` | Host port mapping for Postgres | `5432` |
| `PGUSER` | Postgres role for the MCP server | `gif_app` |
| `PORT` | MCP server HTTP port | `3100` |
| `MCP_BASE_URL` | Base URL for integration tests | derived from `PORT` |

`.env.example` in the repository root enumerates the same set. Copy it to `.env`, populate, never commit.

---

## What GIF does NOT need (and never should)

- **Adopter tool handler secrets** — API keys, OAuth tokens, third-party service credentials. These belong in environment variables read by the adopter's tool handlers, not GIF's. See [`docs/gif-101.md`](gif-101.md) for the tool handler pattern.
- **End-user credentials** — GIF does not authenticate end users. Identity provisioning is the adopter's responsibility (see [`docs/adopter-invocation-context.md`](adopter-invocation-context.md)).
- **Encryption keys for data at rest** — Not yet implemented (compliance hardening roadmap). When implemented, the data encryption key reference will follow the same env-var contract (per [GIF-017](../decisions/GIF-017-secrets-via-env-vars.md)).

---

## Reference patterns

GIF works with any secret-management system that can populate environment variables at process startup. The following patterns are common and known to work.

### Docker Compose `.env` (local development, single-host deployment)

Simplest pattern. `.env` is read automatically by `docker compose`. File should be `chmod 600` and gitignored (the repository's `.gitignore` already lists it).

```bash
cp .env.example .env
# Edit .env with real values
docker compose up -d
```

For single-host production, this pattern is acceptable if filesystem access is restricted appropriately. For multi-host or regulated deployments, use one of the patterns below.

### Kubernetes Secrets mounted as env vars

```yaml
# Secret created via kubectl create secret or sealed-secrets
env:
  - name: GIF_APP_PASSWORD
    valueFrom:
      secretKeyRef:
        name: gif-secrets
        key: gif-app-password
  - name: IDENTITY_HMAC_SECRET
    valueFrom:
      secretKeyRef:
        name: gif-secrets
        key: identity-hmac-secret
```

Compatible with `sealed-secrets`, `external-secrets-operator`, SOPS, or any pattern that produces a Kubernetes `Secret` resource.

### HashiCorp Vault (agent template or sidecar injector)

The Vault Agent Injector (Kubernetes) or Vault Agent Template (standalone) renders secret values from Vault into a file or directly into environment variables. Configure your deployment manifest to inject:

```hcl
# vault-agent.hcl excerpt
template {
  source      = "/vault/templates/gif.env.tpl"
  destination = "/secrets/gif.env"
}
```

```bash
# gif.env.tpl
GIF_APP_PASSWORD={{ with secret "kv/gif/db" }}{{ .Data.data.app_password }}{{ end }}
IDENTITY_HMAC_SECRET={{ with secret "kv/gif/identity" }}{{ .Data.data.hmac }}{{ end }}
```

Source the rendered file before launching the MCP server, or mount it as an `env_file` in Docker Compose.

### AWS Secrets Manager (ECS task definitions, EKS, or EC2)

For ECS:

```json
{
  "secrets": [
    {
      "name": "GIF_APP_PASSWORD",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:111122223333:secret:gif/db-XYZ:app_password::"
    },
    {
      "name": "IDENTITY_HMAC_SECRET",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:111122223333:secret:gif/identity-ABC::"
    }
  ]
}
```

ECS resolves the references at task start and injects them as env vars. The MCP server reads them via `process.env` as it would any other env var.

For EC2 / standalone: use the AWS CLI to fetch secrets in a startup script and `export` them before starting the MCP server.

### GCP Secret Manager (Cloud Run, GKE, or Compute Engine)

```yaml
# Cloud Run
spec:
  template:
    spec:
      containers:
        - image: gif-mcp-server:v0.1.0
          env:
            - name: GIF_APP_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: gif-app-password
                  key: latest
```

### Azure Key Vault (AKS or Container Apps)

Use the Azure Key Vault Provider for Secrets Store CSI Driver to mount secrets, or reference them directly in Container Apps environment configuration.

### Doppler / Infisical (cross-cloud secret platforms)

Both provide a CLI wrapper that injects secrets into the launched process's environment:

```bash
doppler run -- docker compose up -d
# or
infisical run -- docker compose up -d
```

No GIF configuration changes required.

---

## Rotation procedures

### `GIF_APP_PASSWORD`

1. In Postgres, set the new password for the `gif_app` role:
   ```sql
   ALTER ROLE gif_app WITH PASSWORD '<new>';
   ```
2. Update the secret in your secret manager.
3. Restart the MCP server. Active sessions in flight may fail; new sessions will use the new credential.

No data loss. Brief availability impact during restart.

### `GIF_ADMIN_PASSWORD`

1. `ALTER ROLE gif_admin WITH PASSWORD '<new>';`
2. Update the secret in your secret manager.
3. No MCP server restart required (MCP server does not use this role at runtime).

### `IDENTITY_HMAC_SECRET` — load-bearing

Rotating the HMAC secret invalidates all identity tokens that were issued under the previous secret but not yet consumed at `persona_create`. This is by design: a compromised HMAC secret means any outstanding tokens may be forged.

**Standard rotation (no compromise suspected):**

1. Wait for the issuance window to drain — confirm no unconsumed tokens remain:
   ```sql
   SELECT count(*) FROM gif.user_persona_assignments
   WHERE token_consumed_at IS NULL
     AND identity_token IS NOT NULL;
   ```
   Coordinate with whoever issues identity tokens (typically a human admin running `bin/issue_identity_token.ts`) to pause issuance until the rotation completes.
2. Update `IDENTITY_HMAC_SECRET` in the secret manager.
3. Restart the MCP server.
4. Resume token issuance under the new secret.

**Emergency rotation (compromise suspected):**

1. Update `IDENTITY_HMAC_SECRET` in the secret manager immediately.
2. Restart the MCP server.
3. Any outstanding unconsumed tokens are now invalid — any `persona_create` attempt presenting one will be rejected.
4. Audit: query `gif.audit_events` for recent `persona_create` events; any whose tokens were issued during the compromise window should be reviewed and potentially revoked.

After any rotation, `IDENTITY_HMAC_SECRET` value should be retained in the secret manager's version history for forensic purposes — old audit events were validated under prior secrets and verifying them retrospectively requires those values.

### `POSTGRES_PASSWORD`

This password is only used during initial database container creation. Changing it on an existing deployment requires either:
- Resetting the Docker volume (destroys all data — not recommended)
- Connecting as `postgres` via psql and running `ALTER USER postgres WITH PASSWORD '<new>';`, then updating the secret manager

In practice, this password is set once at initial deployment and rarely rotated. The `gif_admin` and `gif_app` passwords are the operationally meaningful ones.

---

## What to do if a secret is exposed

1. **Identify the scope.** Which secret, when was it exposed, who/what may have accessed the exposure surface (logs, git history, screen shares).
2. **Rotate immediately** per the procedures above.
3. **For `IDENTITY_HMAC_SECRET` specifically:** audit all `persona_create` events between secret-issuance and rotation. Treat any persona created with a token issued in the compromise window as suspect.
4. **For `GIF_APP_PASSWORD`:** rotate, then audit `gif.audit_events` and `gif.scope_violations` for anomalous activity during the exposure window.
5. **Record the incident** in your organization's incident-tracking system. GIF does not track secret-rotation incidents itself — that's an operational concern outside GIF's scope.

---

## Future additions

The compliance hardening roadmap (see [`gif-product-overview.md`](gif-product-overview.md)) includes capabilities that may introduce additional secrets:

- **Cryptographic log signing** — an anchor signing key, injected via env var per GIF-017.
- **Encryption at rest** — a data encryption key reference (typically a KMS key ID, not the key itself), injected via env var per GIF-017.

When these are implemented, they will be added to the [Secrets](#secrets-sensitive--protect-like-passwords) table above with their rotation impact documented.
