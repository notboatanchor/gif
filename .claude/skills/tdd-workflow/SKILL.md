---
name: tdd-workflow
description: Test-driven development cycle — RED/GREEN/REFACTOR with checkpoints. Use when writing new MCP tools, service functions, or any logic with clear expected behavior.
origin: ECC
---

# TDD Workflow

## Cycle: RED → GREEN → REFACTOR

```
1. RED    — Write a failing test. Run it. Confirm it fails for the right reason.
2. GREEN  — Write the minimum code to make the test pass. Don't over-engineer.
3. REFACTOR — Clean up. The test suite is your safety net.
```

**Rule:** Never write production code without a failing test first.

## Checkpoint Pattern

Use git checkpoints at each GREEN phase:
```bash
git add -A && git commit -m "test: [what is tested]"   # RED checkpoint
# implement...
git add -A && git commit -m "feat: [what passes]"      # GREEN checkpoint
# refactor...
git add -A && git commit -m "refactor: [what changed]" # REFACTOR checkpoint
```

This keeps a clean history and easy rollback if refactoring breaks things.

## TypeScript/Vitest Pattern

```typescript
// RED — write the test first
describe("getEntity", () => {
  it("returns entity by id", async () => {
    const entity = await getEntity("test-id");
    expect(entity).toMatchObject({ id: "test-id", name: "Test Entity" });
  });

  it("returns null for unknown id", async () => {
    const entity = await getEntity("nonexistent");
    expect(entity).toBeNull();
  });

  it("throws on invalid id format", async () => {
    await expect(getEntity("not-a-uuid")).rejects.toThrow("Invalid entity ID");
  });
});

// GREEN — minimum implementation
export async function getEntity(id: string): Promise<Entity | null> {
  if (!isValidUUID(id)) throw new Error("Invalid entity ID");
  return db.query("SELECT * FROM entities WHERE id = $1", [id]);
}
```

## MCP Tool Testing Pattern

Test the handler logic directly — not the MCP protocol:

```typescript
describe("search-entities tool", () => {
  it("returns matching entities", async () => {
    const result = await searchEntitiesHandler({ query: "test", limit: 10 });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("results");
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it("returns isError on DB failure", async () => {
    // Mock DB to throw
    jest.spyOn(db, "query").mockRejectedValueOnce(new Error("DB down"));
    const result = await searchEntitiesHandler({ query: "test" });
    expect(result.isError).toBe(true);
  });
});
```

## Coverage Targets

| Code type | Target |
|-----------|--------|
| Service/business logic | 90%+ |
| MCP tool handlers | 80%+ |
| Repository/DB layer | 70%+ (integration tests supplement) |
| Error paths | 100% — every error case must have a test |
| Auth/security logic | 100% — no exceptions |

## Test Structure

```
unit/           — pure logic, no I/O, fast
integration/    — real DB, test containers
e2e/            — full MCP server, external clients
```

Unit tests run on every save. Integration tests run pre-commit. E2E runs pre-PR.

## What Not to Test

- Implementation details (private functions, internal state)
- Third-party library behavior (test your usage of it, not the library itself)
- Trivial getters/setters with no logic
- Configuration files
