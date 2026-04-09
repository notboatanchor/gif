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

**nginx example (per-IP):**
```nginx
limit_req_zone $binary_remote_addr zone=gif_limit:10m rate=30r/m;

location /mcp {
    limit_req zone=gif_limit burst=10 nodelay;
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

## 6. Pre-deployment checklist

- [ ] TLS termination configured at reverse proxy
- [ ] `/health` restricted to internal network
- [ ] Rate limiting configured at proxy layer
- [ ] Audit partitions verified through at least 3 months from today
- [ ] Monthly partition task scheduled (cron or orchestration)
- [ ] `persona_id` bearer tokens handled as secrets in your application
- [ ] HMAC identity token issuance integrated with your IdP or user session
