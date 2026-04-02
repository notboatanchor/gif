---
name: verification-loop
description: Comprehensive build/type/lint/test verification for gif. Run after any non-trivial change before committing. Catches regressions early.
origin: ECC
---

# Verification Loop

Run after any non-trivial change. Fast feedback before committing.

## gif-stack Verification Sequence

```bash
# 1. Type check (fastest signal — run first)
tsc --noEmit

# 2. Lint
npx eslint src/ --ext .ts

# 3. Unit tests
npm test

# 4. Build
npm run build

# 5. Audit (pre-commit only)
grep -r "console\.log" src/ && echo "WARNING: console.log found"
grep -r "TODO\|FIXME\|HACK" src/ | grep -v ".test." || true
```

## Continuous Mode

Run type check in watch mode during active development:
```bash
tsc --noEmit --watch
```

Run tests in watch mode:
```bash
npm test -- --watch
```

## Verification Report Format

```
Type check:  ✓ PASS / ✗ FAIL (N errors)
Lint:        ✓ PASS / N warnings
Tests:       ✓ N/N passing / ✗ N failing
Build:       ✓ PASS / ✗ FAIL
Audit:       ✓ PASS / ⚠ [issues found]

Status: READY / BLOCKED
```

## On Failure — Resolution Order

1. Type errors first — they reveal the most structural problems
2. Test failures second — distinguish broken tests from broken code
3. Lint last — style issues don't block correctness

## Pre-commit Gate

Always run the full sequence before committing to main or opening a PR:
```bash
tsc --noEmit && npx eslint src/ --ext .ts && npm test && npm run build
```

If any step fails, do not commit. Fix the issue, then re-run.
