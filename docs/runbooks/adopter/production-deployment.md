# Production Deployment

Checklist and guidance for deploying GIF in a production environment. GIF's
inner security model (enforcement, audit trail, database permissions) is
structural. This runbook addresses the outer boundary — the network surface
between AI clients and the MCP server.

---

## 1. TLS Termination

**GIF does not terminate TLS.** The MCP server listens on plain HTTP (port
3100 by default). TLS must be provided by a reverse proxy upstream.

This is by design (GIF-015): TLS configuration is adopter infrastructure
and varies by environment. What GIF requires is that the proxy provides it.

**Why this matters:** Every tool call carries a `persona_id` (bearer token)
and, during persona creation, an HMAC identity token. Without TLS, both are
visible on the wire.

### Recommended reverse proxy setup

**nginx**
```nginx
server {
    listen 443 ssl;
    server_name gif.your-domain.internal;

    ssl_certificate     /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    location /mcp {
        proxy_pass         http://localhost:3100;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location /health {
        # Restrict health endpoint to internal network only
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny  all;
        proxy_pass http://localhost:3100;
    }
}
```

**Caddy**
```
gif.your-domain.internal {
    reverse_proxy /mcp localhost:3100
    reverse_proxy /health localhost:3100 {
        @not_internal {
            not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
        }
        respond @not_internal 403
    }
}
```

**Traefik** — configure as a router rule pointing to the GIF container on
port 3100 with a TLS entrypoint. Restrict `/health` using a middleware IP
allowlist.

---

## 2. CORS Policy

GIF's MCP endpoint is called by AI clients — not browsers. CORS headers are
not required for MCP-over-HTTP in most deployments.

If your adopter application calls GIF from a browser context (uncommon),
restrict `Access-Control-Allow-Origin` to your application's specific origin.
Do not set `*`.

---

## 3. Rate Limiting

GIF does not implement rate limiting. Add it at the reverse proxy layer.

**Recommended minimums:**

- Per-IP: limit to prevent request flooding from a single source
- Per-persona: if your proxy can inspect request bodies, rate limiting by
  `persona_id` prevents a compromised persona from generating unbounded
  audit volume
- Request-body size: neither GIF nor the MCP SDK caps request-body size —
  set `client_max_body_size` (nginx) or your proxy's equivalent
- Concurrent connections: pair the request-rate limit with a per-IP
  concurrent-connection cap (`limit_conn`) so long-lived streaming
  connections cannot pin sockets; request-rate limits alone do not bound
  held-open connections

**nginx example (per-IP):**
```nginx
limit_req_zone  $binary_remote_addr zone=gif_limit:10m rate=30r/m;
limit_conn_zone $binary_remote_addr zone=gif_conn:10m;

location /mcp {
    limit_req  zone=gif_limit burst=10 nodelay;
    limit_conn gif_conn 10;
    client_max_body_size 1m;
    proxy_pass http://localhost:3100;
}
```

Tune the rate to your expected legitimate call volume. The right number
depends on your AI workload.

---

## 4. Health Check Exposure

The `/health` endpoint returns server status. Restrict it to internal
networks only — it should never be reachable from the public internet.

See the nginx and Caddy examples in Section 1.

---

## 5. Audit Partition Management

**This is a required monthly operator task.** If it is skipped, the audit
trail will silently fail to record events when a new month begins.

### Background

GIF's `audit_events` table uses PostgreSQL declarative partitioning — one
partition per month. An INSERT for a timestamp that has no matching partition
fails silently, breaking the audit trail.

On every container start, GIF automatically creates partitions for the
current month and the next 3 months. **This only runs on startup.** If your
container runs continuously for months without a restart — which is normal
for production infrastructure — the automatic creation will not run.

### The operator task

**On the first of each month** (or any time before the month begins),
connect to the GIF database as `gif_admin` and run:

```sql
-- Partition bounds must be exactly UTC month-aligned (migration 016
-- invariant — the hash-chain trigger derives chain scope, lock keys, and
-- stamp bounds under TimeZone 'UTC'). Pin the session before creating
-- partitions so the date literals resolve as UTC instants:
SET TIME ZONE 'UTC';

DO $$
DECLARE
    m      date;
    tname  text;
    lo     date;
    hi     date;
BEGIN
    FOR i IN 0..3 LOOP
        m     := date_trunc('month', now()) + (i || ' months')::interval;
        tname := 'audit_events_' || to_char(m, 'YYYY_MM');
        lo    := m;
        hi    := m + '1 month'::interval;
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'gif' AND c.relname = tname
        ) THEN
            EXECUTE format(
                'CREATE TABLE gif.%I PARTITION OF gif.audit_events '
                'FOR VALUES FROM (%L) TO (%L)',
                tname, lo, hi
            );
            EXECUTE format('GRANT SELECT, INSERT ON gif.%I TO gif_app', tname);
            EXECUTE format('REVOKE UPDATE ON gif.%I FROM gif_app', tname);
            RAISE NOTICE 'Created partition: %', tname;
        ELSE
            RAISE NOTICE 'Partition already exists, skipping: %', tname;
        END IF;
    END LOOP;
END$$;
```

This is idempotent — safe to run any number of times. Running it creates the
next 3 months of partitions if they do not already exist, and skips any that
do.

### Recommended schedule

Schedule this as a cron job on the host or a scheduled task in your
orchestration platform. Running on the first of each month is sufficient;
running weekly is safe and provides earlier warning of any failure.

**Example crontab entry:**
```
0 6 1 * * psql -U gif_admin -d gif -f /path/to/create-partitions.sql
```

Save the SQL block above to `create-partitions.sql` and reference it from
the cron entry.

### How to verify current partitions

```sql
SELECT
    c.relname AS partition_name,
    pg_get_expr(c.relpartbound, c.oid) AS bounds
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
WHERE pn.nspname = 'gif'
  AND p.relname  = 'audit_events'
ORDER BY c.relname;
```

You should see a row for every month from your deployment date through at
least 3 months from today. Any gap is a compliance risk.

---

## 6. Concurrency Envelope and Connection Sizing

### Audit-chain writes serialize per month partition

As of migration 016, the audit hash-chain trigger takes a row lock
(`SELECT ... FOR UPDATE` on a gif-owned per-month lock row in
`gif.audit_chain_locks`) before reading the previous hash, and re-stamps
`occurred_at` under that lock so chain order and sort order agree. Audit
writes therefore serialize per month partition. The lock is held for the
duration of a single INSERT — millisecond scale.

**Why this exists:** in releases prior to migration 016 (all tags through
`v0.2.1`), the trigger's previous-hash lookup ran unlocked. Two concurrent
audit INSERTs could each link the same parent row, forking the chain. Because
`previous_hash` is part of the hashed preimage and the table is INSERT-only,
a fork can never be re-linked: the chain verifier reports it as a permanent
linkage break. The verifier detects the condition loudly — the cost is a
false tamper alarm that can never be cleared, not a silent integrity loss.
Concurrent writes do not require multiple users: two overlapping tool calls,
parallel tool calls from a single agent, or two adopter servers sharing one
GIF database are each sufficient.

No forks have been observed in a single-operator adopter with strictly
serialized calls; that configuration cannot exercise the race. Observed
inter-write gaps in that same adopter reach 3 ms, with ~38% of consecutive
writes under 10 ms apart — so the absence of forks reflects absence of
concurrent transactions, not headroom.

**Operator guidance:**

- In-place upgrades: apply migration 016 **before** introducing any
  concurrent writer (a second adopter server, parallel tool calls, or
  multiple simultaneous users). It is a standard migration — both install
  paths apply it automatically on fresh installs.
- Any pre-016 linkage breaks stand: audit rows are never rewritten. Document
  the verifier finding and its cause; do not attempt repair.
- The serialized ceiling is not a practical constraint at human scale. As a
  reference point, 50 users each making 100 governed calls per hour is about
  1.4 audit events per second — orders of magnitude below a
  millisecond-scale serialized write path.
- The lock deliberately has **no timeout** (a timeout would abort the INSERT
  inside audit emission's never-throw path and silently drop the record — an
  action without an audit row, the exact failure the trail exists to
  prevent). The trade: a transaction left open mid-INSERT stalls all audit
  writes on that database until it releases. This state is pathological and
  operationally visible — stalled writers appear in `pg_stat_activity` with
  `wait_event_type = 'Lock'`.

### Connection pool sizing

Each GIF server process opens a pool of at most 10 Postgres connections
(`mcp-server/src/db.ts`). Two sizing rules:

- **Fleet total:** N adopter server processes sharing one Postgres instance
  can hold up to N × 10 connections. Keep the total comfortably under the
  database's `max_connections` (Postgres default: 100), leaving headroom for
  operator sessions, the verifier CLI, and monitoring.
- **Persona-provisioning concurrency:** `persona_create` and
  `persona_revoke` each hold a dedicated pooled connection for their whole
  transaction. If persona transactions ever occupy the entire pool
  concurrently, other callers' audit writes queue behind them; past the
  connection timeout they fail into audit logging's never-throw error
  handling — a dropped audit row. This load is bounded by the
  `manage_personas` scope (only provisioning callers can generate it). If
  your deployment runs high-concurrency provisioning: raise the pool `max`
  with corresponding `max_connections` headroom, serialize provisioning in
  the caller, or reserve a connection allotment for audit emission.

The pool also sets `idle_in_transaction_session_timeout` (60 s) on its
connections, so a stranded transaction cannot hold row locks — including the
migration-016 chain lock — indefinitely.

### Shutdown drain

On SIGTERM or SIGINT the server stops accepting new work, drains in-flight
governed calls and their audit writes, closes the pool, and then exits. The
drain is bounded by `GIF_SHUTDOWN_TIMEOUT_SECONDS` (default 8). Configure
your orchestrator's stop grace period **above** this value (Docker
`stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`) so the
platform does not SIGKILL the process mid-drain. A second signal during the
drain forces immediate exit with a nonzero code.

### Session mapping for long-lived integrations

Do **not** map one GIF session to one long-lived external connection (for
example, a provider account whose OAuth grant lives for months). GIF
sessions are stateless database handles: minting and closing them is cheap,
idle-open sessions cost nothing, and `GIF_SESSION_TTL_SECONDS` (default
86400) hard-caps their lifetime at 24 hours regardless.

Mint a session per task or work burst, and close it when the burst ends. The
wrong mapping — one giant week-long session per user or account — buys three
costs simultaneously: combination-policy checks (if your tools invoke them)
aggregate over all of a session's audit rows, so per-call cost grows with
session length; audit records group less usefully for review; and the
session handle, itself a bearer token, stays valid for a wider window.

---

## 7. Pre-deployment checklist

- [ ] TLS termination configured at reverse proxy
- [ ] `/health` restricted to internal network
- [ ] Rate limiting configured at proxy layer
- [ ] Audit partitions verified through at least 3 months from today
- [ ] Monthly partition task scheduled (cron or orchestration)
- [ ] Migration 016 applied before any concurrent writers (in-place upgrades)
- [ ] Postgres `max_connections` accommodates pool max × number of GIF
      server processes, with headroom
- [ ] Orchestrator stop grace period exceeds `GIF_SHUTDOWN_TIMEOUT_SECONDS`
- [ ] `persona_id` bearer tokens handled as secrets in your application
- [ ] HMAC identity token issuance integrated with your IdP or user session
