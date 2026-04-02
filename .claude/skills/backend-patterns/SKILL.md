---
name: backend-patterns
description: Node.js/TypeScript service layer patterns — repository pattern, service layer, error handling, N+1 prevention. Reference when adding new features to gif's service layer.
origin: ECC
---

# Backend Patterns (Node.js/TypeScript)

## Repository Pattern

Isolate DB access behind a typed interface:

```typescript
// Interface — what callers see
interface EntityRepository {
  findById(id: string): Promise<Entity | null>;
  findByStatus(status: EntityStatus): Promise<Entity[]>;
  create(input: CreateEntityInput): Promise<Entity>;
  update(id: string, patch: Partial<Entity>): Promise<Entity | null>;
}

// Implementation — the actual SQL
class PostgresEntityRepository implements EntityRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Entity | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM entities WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }
}
```

## Service Layer

Business logic lives here, not in tool handlers or repositories:

```typescript
class EntityService {
  constructor(
    private repo: EntityRepository,
    private cache: CacheService,
  ) {}

  async getEntity(id: string): Promise<Entity> {
    // Validate
    if (!isValidUUID(id)) throw new ValidationError(`Invalid entity ID: ${id}`);

    // Cache check
    const cached = await this.cache.get(`entity:${id}`);
    if (cached) return cached;

    // Fetch
    const entity = await this.repo.findById(id);
    if (!entity) throw new NotFoundError(`Entity not found: ${id}`);

    // Cache and return
    await this.cache.set(`entity:${id}`, entity, { ttl: 300 });
    return entity;
  }
}
```

## Error Hierarchy

```typescript
// Base errors — extend these
class AppError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

class ValidationError extends AppError {
  constructor(message: string) { super(message, "VALIDATION_ERROR"); }
}

class NotFoundError extends AppError {
  constructor(message: string) { super(message, "NOT_FOUND"); }
}

class DatabaseError extends AppError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message, "DATABASE_ERROR");
  }
}
```

## N+1 Prevention

```typescript
// BAD — N+1: one query per entity
const entities = await repo.findAll();
for (const entity of entities) {
  entity.tags = await tagRepo.findByEntityId(entity.id); // N queries!
}

// GOOD — batch fetch
const entities = await repo.findAll();
const entityIds = entities.map(e => e.id);
const tagsByEntity = await tagRepo.findByEntityIds(entityIds); // 1 query
for (const entity of entities) {
  entity.tags = tagsByEntity[entity.id] ?? [];
}
```

## Structured Logging

```typescript
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// Always log with structured context, not string interpolation
log.info({ entityId: id, action: "fetch" }, "Fetching entity");
log.error({ entityId: id, err: error }, "Failed to fetch entity");

// Never: console.log(`Fetching entity ${id}`)
```

## Input Validation at Boundaries

Validate at the edge (tool handler, API endpoint) — not inside services:

```typescript
// In the MCP tool handler — validate Zod schema automatically
// In HTTP endpoints — validate before calling service
const parsed = CreateEntitySchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({ errors: parsed.error.flatten() });
}
const entity = await service.createEntity(parsed.data);
```

## gif-Specific Conventions

- Repository constructors take `Pool`, not connection strings
- Services are instantiated once at startup and shared
- No `console.log` — use `pino` logger
- All async functions must handle both success and error paths
- Tool handlers are thin wrappers: validate → call service → format output
