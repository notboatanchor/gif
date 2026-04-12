# GIF-016 — Bootstrap Install Paths: Dedicated Database vs. Existing Database

**Status:** Accepted  
**Date:** 2026-04-12

## Decision

The bootstrap script (`000_bootstrap.sql`) supports two install paths, controlled
by a psql variable flag:

- **Dedicated database path** (`-v gif_dedicated_db=on`): `gif_admin` is made the
  database owner. Appropriate for a fresh database created solely to host GIF —
  development environments, standalone GIF deployments, or an adopter standing up
  a new database for this purpose. `install.sh` uses this path by default.

- **Existing database path** (flag omitted): the database ownership transfer is
  skipped. `gif_admin` owns only the `gif` schema. The database has an existing
  owner who is not displaced. One manual prerequisite applies (see below).

In both paths, all subsequent migrations run identically as `gif_admin`. The
paths diverge only at the ownership transfer step.

## Context

`000_bootstrap.sql` was written with a single scenario in mind: a fresh database
created for GIF where `gif_admin` is the appropriate owner. The bootstrap
executes:

```sql
ALTER DATABASE <current_database> OWNER TO gif_admin;
```

This is wrong for an enterprise adopter installing GIF into an existing database.
That database has an existing owner — a DBA role, a per-application admin role, or
a managed-service master user. Transferring ownership to `gif_admin` is:

1. Likely to be rejected by the DBA or the database administrator as unexpected
2. Incorrect — `gif_admin` is a GIF schema owner, not a database administrator
3. Unnecessary — `gif_admin` needs schema-creation privilege, not database ownership

What `gif_admin` actually requires in the existing-database path is:

```sql
GRANT CREATE ON DATABASE <database_name> TO gif_admin;
```

This allows `gif_admin` to create the `gif` schema. Once the schema exists and
`gif_admin` owns it, all DDL within the schema proceeds by schema ownership — no
database-level privilege is required for subsequent migrations.

## Options Considered

**Documentation only:** Add a comment to the bootstrap explaining that the
ownership transfer block should be skipped for existing databases. The operator
edits the file or skips the block manually.

Not viable for a distributed open source tool — operators cannot reliably skip a
block in a file being piped to psql.

**Two separate bootstrap files:** `000_bootstrap_dedicated.sql` and
`000_bootstrap_existing.sql`. Full separation.

Adds file complexity, diverges two files that share most of their content, and
requires `install.sh` and all documentation to reference two files. Rejected.

**psql variable flag (chosen):** A single bootstrap file with a `\if` conditional
block around the ownership transfer. The flag defaults to off (existing database
path). `install.sh` passes `-v gif_dedicated_db=on` to activate the dedicated
path. No file edits required by the operator in either case.

## Existing Database Prerequisites

Before running `000_bootstrap.sql` against an existing database, the database
superuser or DBA must run:

```sql
-- Run as superuser or database owner
GRANT CREATE ON DATABASE <your_database> TO gif_admin;
```

This is a one-time setup step. It gives `gif_admin` the ability to create the
`gif` schema. After bootstrap runs and the `gif` schema exists (owned by
`gif_admin`), this database-level privilege is no longer exercised.

If `gif_admin` does not yet exist at this point, create it first:

```sql
CREATE ROLE gif_admin WITH LOGIN PASSWORD '<password>';
GRANT CREATE ON DATABASE <your_database> TO gif_admin;
```

Then run `000_bootstrap.sql` (without `-v gif_dedicated_db=on`).

## Rationale

`gif_admin` is a schema owner, not a database administrator. Its privilege
surface should match its role. In a dedicated-database scenario, database
ownership is a natural consequence of `gif_admin` being the only non-superuser
with DDL rights. In an existing-database scenario, it is an overreach.

The psql variable approach keeps the bootstrap as a single file, makes the
distinction explicit and visible in the code, and requires no action from
operators using `install.sh` (the common case). Enterprise operators see a clear
flag they can omit.

## Consequences

- `install.sh` passes `-v gif_dedicated_db=on` when invoking bootstrap. No
  behavioral change for the common install path.
- An operator installing into an existing database runs bootstrap without the
  flag and follows the runbook prerequisite step.
- The adopter first-time-setup runbook gains an existing-database section.
- `gif_admin` is correctly described in documentation as a schema owner rather
  than a database owner in the general case.

## Related Decisions

- ADR-032: GIF ownership model and deployment topology — established `gif_admin`
  as the schema owner and migration user; this ADR refines the database-level
  ownership claim
- GIF-006: Schema isolation — the `gif` schema is the unit of GIF's isolation
  boundary; database ownership is outside that boundary
