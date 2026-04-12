-- =============================================================================
-- Audit Partition Retirement Script
-- Applies to: gif schema (database configured via PGDATABASE)
-- Run as: gif_admin (via install.sh — do not run directly)
--
-- Purpose:
--   Identify and optionally drop monthly audit_events partitions whose
--   retention window has expired across ALL personas with events in them.
--
-- Retention model:
--   - Retention policy is declared per persona in scope_definition->>'retention_policy'
--   - Format: "<n>_days" | "<n>_year" | "<n>_years" (e.g., "30_days", "1_year", "7_years")
--   - Default if missing or unparseable: 1 year
--
-- Conservative-wins rule:
--   A partition is retirable only when the longest retention window across
--   ALL personas with events in that partition has expired relative to the
--   partition's end date.
--
--   Example: partition audit_events_2026_03 covers through 2026-04-01.
--   If persona A has retention_policy "30_days" and persona B (also with events
--   in this partition) has retention_policy "7_years", the partition is not
--   retirable until 2033-04-01.
--
-- This script is read-only (no DROP statements). It outputs a retirement report.
-- To execute a DROP, use the template at the bottom of this file and run manually
-- after reviewing the report.
--
-- See: gif/docs/ops-runbook-audit-retention.md for full procedures.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: Parse retention policies
--
-- Extracts retention_policy strings from all personas and converts to
-- Postgres INTERVAL for arithmetic. Personas with missing or unparseable
-- retention_policy default to INTERVAL '1 year'.
-- ---------------------------------------------------------------------------

WITH persona_retention AS (
    SELECT
        persona_id,
        scope_definition->>'retention_policy' AS retention_policy_raw,
        CASE
            -- "<n>_days" format
            WHEN scope_definition->>'retention_policy' ~ '^\d+_days$'
                THEN (
                    regexp_replace(scope_definition->>'retention_policy', '_days$', '')
                    || ' days'
                )::INTERVAL
            -- "<n>_year" or "<n>_years" format
            WHEN scope_definition->>'retention_policy' ~ '^\d+_years?$'
                THEN (
                    regexp_replace(scope_definition->>'retention_policy', '_years?$', '')
                    || ' years'
                )::INTERVAL
            -- Missing, null, or unrecognized format — default to 1 year
            ELSE INTERVAL '1 year'
        END AS retention_interval
    FROM personas
),

-- ---------------------------------------------------------------------------
-- STEP 2: Identify audit partitions
--
-- Reads from pg_catalog to find all child tables of audit_events.
-- Derives the partition end date from the table name (audit_events_YYYY_MM).
-- The month following the name is the exclusive upper bound of the partition.
-- ---------------------------------------------------------------------------

audit_partitions AS (
    SELECT
        c.relname AS partition_name,
        -- Parse YYYY_MM from table name suffix and calculate partition end date
        -- (first day of the following month — the partition's exclusive upper bound)
        (
            regexp_replace(c.relname, '^audit_events_', '')  -- yields "YYYY_MM"
        ) AS year_month,
        to_date(
            regexp_replace(c.relname, '^audit_events_', '') || '_01',
            'YYYY_MM_DD'
        ) + INTERVAL '1 month' AS partition_end_date
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class     c ON c.oid = i.inhrelid
    JOIN pg_catalog.pg_class     p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_events'
      AND c.relname ~ '^audit_events_\d{4}_\d{2}$'
),

-- ---------------------------------------------------------------------------
-- STEP 3: Find the most conservative retention policy per partition
--
-- For each partition, identifies all personas with events in it and selects
-- the longest retention interval — the gate that must pass before retirement.
-- ---------------------------------------------------------------------------

partition_max_retention AS (
    SELECT
        ap.partition_name,
        ap.partition_end_date,
        MAX(pr.retention_interval) AS max_retention_interval,
        COUNT(DISTINCT ae.persona_id) AS persona_count,
        COUNT(ae.event_id) AS event_count
    FROM audit_partitions ap
    -- Dynamic partition name requires joining through the parent table.
    -- audit_events routes queries to the correct partition automatically.
    JOIN audit_events ae
        ON ae.occurred_at >= ap.partition_end_date - INTERVAL '1 month'
       AND ae.occurred_at <  ap.partition_end_date
    JOIN persona_retention pr ON pr.persona_id = ae.persona_id
    GROUP BY ap.partition_name, ap.partition_end_date
),

-- ---------------------------------------------------------------------------
-- STEP 4: Evaluate retirement eligibility
-- ---------------------------------------------------------------------------

retirement_report AS (
    SELECT
        partition_name,
        partition_end_date,
        max_retention_interval,
        partition_end_date + max_retention_interval AS earliest_retirement_date,
        persona_count,
        event_count,
        CASE
            WHEN now() >= partition_end_date + max_retention_interval
            THEN 'RETIRABLE'
            ELSE 'RETAIN'
        END AS retirement_status,
        -- Days remaining until eligible (negative = already eligible)
        EXTRACT(
            DAY FROM (partition_end_date + max_retention_interval) - now()
        )::INTEGER AS days_until_eligible
    FROM partition_max_retention
)

-- ---------------------------------------------------------------------------
-- OUTPUT: Retirement report
-- ---------------------------------------------------------------------------

SELECT
    partition_name,
    partition_end_date::DATE                    AS partition_covers_through,
    max_retention_interval                      AS governing_retention,
    earliest_retirement_date::DATE              AS earliest_retirement_date,
    retirement_status,
    CASE
        WHEN days_until_eligible <= 0 THEN 'eligible now'
        ELSE days_until_eligible || ' days remaining'
    END                                         AS eligibility,
    persona_count                               AS personas_with_events,
    event_count                                 AS total_events
FROM retirement_report
ORDER BY partition_end_date ASC;

-- =============================================================================
-- MANUAL DROP TEMPLATE
--
-- Review the report above. For each partition with retirement_status = 'RETIRABLE':
--
--   1. Confirm partition_name, event_count, and earliest_retirement_date.
--   2. Ensure a B2 export has been completed if required (see runbook).
--   3. Run the DROP statement below — one partition at a time.
--   4. Log the action in erasure_log if dropping due to a retention expiry
--      (see runbook for GDPR erasure procedure).
--
-- Template (uncomment and substitute partition name):
--
--   DROP TABLE audit_events_YYYY_MM;
--
-- Do NOT use CASCADE. The partition has no dependents. If CASCADE is required,
-- stop and investigate before proceeding.
--
-- After dropping: re-run this script to confirm the partition no longer appears.
-- =============================================================================
