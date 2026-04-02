---
name: gif-eval
description: Eval-Driven Development for gif MCP tools — define pass/fail criteria before implementing MCP handlers, validate tool output quality, track regressions across schema changes.
---

# gif Eval Harness

Applies Eval-Driven Development (EDD) to gif's MCP tool layer. Define what "correct" looks like before implementing, then verify it holds across changes.

## When to Use

- Before implementing a new MCP tool
- Before a schema migration that affects tool output
- When validating open-source readiness (does each tool do what its description says?)
- After refactoring tool handlers (regression check)

## Grader Types for gif

### Code-Based Grader (prefer — deterministic)
```bash
# Type check passes
tsc --noEmit && echo "PASS" || echo "FAIL"

# Tool handler returns expected shape
npm test -- --testPathPattern="tool-name" && echo "PASS" || echo "FAIL"

# Schema constraint holds after migration
psql -U scott -d gif -c "SELECT COUNT(*) FROM entities WHERE id IS NULL" | grep -q "^  0$" && echo "PASS" || echo "FAIL"

# Tool registered and callable
node -e "require('./dist/index.js')" && echo "PASS" || echo "FAIL"
```

### Model-Based Grader (open-ended tool output)
```markdown
[MODEL GRADER PROMPT]
Evaluate this MCP tool output:
- Tool: [tool-name]
- Input: [input provided]
- Output: [output received]

Criteria:
1. Does the output match the tool's stated description? (1-5)
2. Is the response structure consistent and parseable? (1-5)
3. Are edge cases (empty results, not found) handled gracefully? (1-5)
4. Is there any data that looks wrong or inconsistent? (flag any)

Score: [total/15]
Verdict: PASS (≥12) / FAIL (<12)
```

### Human Grader (open-source readiness gate)
```markdown
[HUMAN REVIEW REQUIRED]
Tool: [tool-name]
Risk: HIGH — pre-open-source validation
Review:
- [ ] Tool description accurately reflects behavior
- [ ] No internal implementation details leaked in output
- [ ] Error messages are helpful without being verbose
- [ ] Behavior is consistent with ADR documentation
```

## Eval Definition Format

Write this BEFORE implementing:

```markdown
## Eval: [tool-name]

**Type:** Capability | Regression
**Grader:** Code | Model | Human
**Baseline:** [SHA or "new"]

### Success Criteria
- [ ] Returns correct shape for valid input
- [ ] Returns `isError: true` for invalid input (not a thrown exception)
- [ ] Handles empty result set gracefully (not null/undefined)
- [ ] Type check passes with no `any` suppressions
- [ ] Test coverage ≥80% for handler logic

### Test Cases
| Input | Expected Output | Grader |
|-------|----------------|--------|
| Valid UUID | Entity object | Code |
| Nonexistent ID | `{ results: [] }` or null+isError | Code |
| Malformed UUID | isError: true, helpful message | Code |
| DB down | isError: true (not thrown) | Code |
| Complex query | Relevant results ranked by relevance | Model |
```

## Eval Storage

```
gif/.claude/evals/
  [tool-name].md        # Eval definition
  [tool-name].log       # Run history with timestamps
  baseline.json         # Regression baselines per tool
```

## pass@k Targets for gif

| Tool type | Target |
|-----------|--------|
| Deterministic lookup (get-entity) | pass^3 = 100% |
| Search/ranking tools | pass@3 ≥ 90% |
| Intelligence/synthesis tools | pass@3 ≥ 80% (model-graded) |
| Error handling paths | pass^3 = 100% |

## Open-Source Readiness Checklist

Before publishing gif, run evals for every registered tool:
- [ ] All code-based evals pass@1 = 100%
- [ ] All model-based evals pass@3 ≥ 80%
- [ ] Human review complete for tools touching external data
- [ ] No tool description/behavior mismatch found
- [ ] Regression baseline captured as `baseline.json`
