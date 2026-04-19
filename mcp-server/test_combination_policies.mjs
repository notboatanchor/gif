// test_combination_policies.mjs
// =============================================================================
// Combination-policy enforcement tests (ADR-023, GIF-011, migration 010).
//
// Exercises createEnforcement(pool).checkCombinationPolicies() directly —
// the function is exposed via the gif-enforcement package and is invoked by
// adopter tool servers (no gif tool declares source refs). The capability is
// normatively specified in MCP-GOV Section 6 / SEP-Y; this file is the
// reference-implementation coverage the spec leans on.
//
// Cases covered:
//   1. Empty incomingSourceRefs short-circuits to triggered: false
//   2. Missing sessionId short-circuits to triggered: false
//   3. Non-triggering candidate set (policy source_set not fully present)
//   4. Triggering via incoming refs only (subset satisfied pre-execution)
//   5. Triggering via session accumulation + incoming (the load-bearing case —
//      the sentence the arXiv paper and README will make citable)
//   6. Exempt persona — policy fires, result flags exempt: true
//   7. Inactive policy is ignored
//   8. Fail-closed on DB error — synthetic block result, not silent pass
//
// Run from gif/mcp-server/:
//   npm run build && node test_combination_policies.mjs
// =============================================================================

import pg from 'pg';
import { createEnforcement } from './dist/enforcement.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pools — gif_admin for setup (policy + audit inserts), gif_app for enforcement
// ---------------------------------------------------------------------------

const adminPool = new Pool({
  host:     process.env.PGHOST          || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGADMINUSER     || 'gif_admin',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

const appPool = new Pool({
  host:     process.env.PGHOST          || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER          || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

// ---------------------------------------------------------------------------
// Pass/fail bookkeeping
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  [PASS] ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

console.log('\n[comb-policy] Combination Policy Enforcement Tests\n');

const TEST_TAG = `test_combination_policies_${Date.now()}`;
let testPersonaId;
let exemptPersonaId;
let sessionId;
let policyIds = [];

try {
  // Find two approved personas — one non-exempt, one exempt. test_setup.mjs
  // seeds two personas; we use both.
  const personasResult = await adminPool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active' AND governance_review_status = 'approved'
      ORDER BY created_at
      LIMIT 2`
  );
  if (personasResult.rows.length < 2) {
    throw new Error('Need at least 2 approved personas — run test_setup.mjs first');
  }
  testPersonaId   = personasResult.rows[0].persona_id;
  exemptPersonaId = personasResult.rows[1].persona_id;

  // Fresh session for this test run
  const sessionResult = await adminPool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, $2::jsonb)
     RETURNING session_id`,
    [testPersonaId, JSON.stringify({ test: TEST_TAG })]
  );
  sessionId = sessionResult.rows[0].session_id;

  // Seed three active policies and one inactive policy.
  //   P1: [alpha, bravo, charlie]                → active, block, no exemption
  //   P2: [delta, echo]                          → active, block, exempt = exemptPersonaId
  //   P3: [alpha, foxtrot]                       → INACTIVE (must be ignored)
  const policySpecs = [
    { name: `${TEST_TAG}_p1`, sources: ['alpha','bravo','charlie'], action: 'block', exempt: [],                 active: true  },
    { name: `${TEST_TAG}_p2`, sources: ['delta','echo'],            action: 'block', exempt: [exemptPersonaId],  active: true  },
    { name: `${TEST_TAG}_p3`, sources: ['alpha','foxtrot'],         action: 'block', exempt: [],                 active: false },
  ];
  for (const p of policySpecs) {
    const r = await adminPool.query(
      `INSERT INTO gif.combination_policies
         (policy_name, source_set, sensitivity_result, enforcement_action,
          exempt_persona_ids, active, created_by)
       VALUES ($1, $2::jsonb, 'restricted', $3::gif.enforcement_action, $4::uuid[], $5, $6)
       RETURNING policy_id`,
      [p.name, JSON.stringify(p.sources), p.action, p.exempt, p.active, TEST_TAG]
    );
    policyIds.push(r.rows[0].policy_id);
  }
  console.log(`[comb-policy] Setup: persona=${testPersonaId}, session=${sessionId}, policies=${policyIds.length}\n`);
} catch (err) {
  console.error('[comb-policy] Setup failed:', err.message);
  await adminPool.end();
  await appPool.end();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Enforcement engine under test
// ---------------------------------------------------------------------------

const enforcement = createEnforcement(appPool);

// ---------------------------------------------------------------------------
// Test 1: Empty incoming refs → short-circuit triggered: false
// ---------------------------------------------------------------------------

{
  const r = await enforcement.checkCombinationPolicies({
    sessionId, personaId: testPersonaId, incomingSourceRefs: []
  });
  if (r.triggered === false) pass('empty incoming refs → triggered: false');
  else fail('empty incoming refs should short-circuit', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// Test 2: Missing sessionId → short-circuit triggered: false
// ---------------------------------------------------------------------------

{
  const r = await enforcement.checkCombinationPolicies({
    sessionId: '', personaId: testPersonaId, incomingSourceRefs: ['alpha']
  });
  if (r.triggered === false) pass('missing sessionId → triggered: false');
  else fail('missing sessionId should short-circuit', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// Test 3: Non-triggering candidate set
// Policy P1 requires [alpha, bravo, charlie]; incoming has only alpha; session empty.
// ---------------------------------------------------------------------------

{
  const r = await enforcement.checkCombinationPolicies({
    sessionId, personaId: testPersonaId, incomingSourceRefs: ['alpha']
  });
  if (r.triggered === false) pass('partial source set does not trigger');
  else fail('partial source set should not trigger', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// Test 4: Trigger via incoming refs alone
// Incoming = [delta, echo] satisfies P2 before any audit event exists.
// ---------------------------------------------------------------------------

{
  const r = await enforcement.checkCombinationPolicies({
    sessionId, personaId: testPersonaId, incomingSourceRefs: ['delta','echo']
  });
  if (r.triggered && !r.exempt && r.enforcementAction === 'block') {
    pass(`pre-execution trigger via incoming refs alone (policy=${r.policyName})`);
  } else {
    fail('incoming [delta,echo] should trigger P2 with action=block, exempt=false',
         JSON.stringify(r));
  }
}

// ---------------------------------------------------------------------------
// Test 5: Trigger via session accumulation + incoming
// This is the load-bearing case — the claim behind "before the call that
// would complete a restricted combination executes."
// Seed audit_events with [alpha], [bravo]; incoming [charlie] completes P1.
// ---------------------------------------------------------------------------

await adminPool.query(
  `INSERT INTO gif.audit_events
     (persona_id, session_id, event_type, outcome, sources_touched)
   VALUES
     ($1, $2, 'tool_call', 'success', '["alpha"]'::jsonb),
     ($1, $2, 'tool_call', 'success', '["bravo"]'::jsonb)`,
  [testPersonaId, sessionId]
);

{
  const r = await enforcement.checkCombinationPolicies({
    sessionId, personaId: testPersonaId, incomingSourceRefs: ['charlie']
  });
  if (r.triggered && !r.exempt && r.enforcementAction === 'block' &&
      r.sensitivityResult === 'restricted') {
    pass(`session accumulation + incoming completes combination pre-execution (policy=${r.policyName})`);
  } else {
    fail('session [alpha,bravo] + incoming [charlie] should trigger P1 block',
         JSON.stringify(r));
  }
}

// ---------------------------------------------------------------------------
// Test 6: Exempt persona — policy fires but exempt: true
// Use the fresh session with no prior audit history for this persona.
// ---------------------------------------------------------------------------

{
  const exemptSessionResult = await adminPool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, $2::jsonb)
     RETURNING session_id`,
    [exemptPersonaId, JSON.stringify({ test: TEST_TAG + '_exempt' })]
  );
  const exemptSessionId = exemptSessionResult.rows[0].session_id;

  const r = await enforcement.checkCombinationPolicies({
    sessionId: exemptSessionId,
    personaId: exemptPersonaId,
    incomingSourceRefs: ['delta','echo']
  });
  if (r.triggered && r.exempt === true) {
    pass(`exempt persona: policy fires but exempt flag set (policy=${r.policyName})`);
  } else {
    fail('exempt persona should receive triggered=true, exempt=true',
         JSON.stringify(r));
  }
}

// ---------------------------------------------------------------------------
// Test 7: Inactive policy is ignored
// P3 requires [alpha, foxtrot] but active=false. We use a fresh session so
// session-accumulated sources do not cross-contaminate the subset check.
// ---------------------------------------------------------------------------

{
  const isolatedSessionResult = await adminPool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, $2::jsonb)
     RETURNING session_id`,
    [testPersonaId, JSON.stringify({ test: TEST_TAG + '_inactive_check' })]
  );
  const isolatedSessionId = isolatedSessionResult.rows[0].session_id;

  const r = await enforcement.checkCombinationPolicies({
    sessionId: isolatedSessionId,
    personaId: testPersonaId,
    incomingSourceRefs: ['alpha','foxtrot']
  });
  if (r.triggered === false) {
    pass('inactive policy ignored even when source_set subset present');
  } else {
    fail('inactive P3 should not fire', JSON.stringify(r));
  }
}

// ---------------------------------------------------------------------------
// Test 8: Fail-closed on DB error
// Inject a mock pool whose query() always throws. Must return a synthetic
// block, not triggered: false.
// ---------------------------------------------------------------------------

{
  const throwingPool = {
    query: async () => { throw new Error('simulated DB outage'); }
  };
  const faultyEnforcement = createEnforcement(throwingPool);
  const r = await faultyEnforcement.checkCombinationPolicies({
    sessionId, personaId: testPersonaId, incomingSourceRefs: ['alpha']
  });
  if (r.triggered === true && r.enforcementAction === 'block' &&
      r.exempt === false && r.policyId === 'error') {
    pass('DB error produces synthetic block result (fail-closed)');
  } else {
    fail('DB error must fail-closed with enforcementAction=block, policyId=error',
         JSON.stringify(r));
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

try {
  // Policies: direct DELETE (gif_admin has full privileges on combination_policies)
  await adminPool.query(
    `DELETE FROM gif.combination_policies WHERE created_by = $1`,
    [TEST_TAG]
  );
  // sessions and audit_events left in place — audit_events is append-only and
  // sessions referenced by audit_events would FK-fail on delete. Test isolation
  // comes from unique session UUIDs + TEST_TAG marker in invocation_context.
} catch (err) {
  console.error('[comb-policy] Cleanup warning:', err.message);
}

await adminPool.end();
await appPool.end();

console.log(`\n[comb-policy] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[comb-policy] COMBINATION POLICY VALIDATION INCOMPLETE');
  process.exit(1);
} else {
  console.log('[comb-policy] All combination-policy checks passed');
}
