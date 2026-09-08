# drizzle-middleware

Query middleware for [Drizzle ORM](https://orm.drizzle.team). Intercepts every query and transaction so you can run code before and after execution — useful for RLS, audit trails, logging, or access control.

Supports Postgres, MySQL, and SQLite (sync and async). Available in two flavors:

- **Callback middleware** — wraps each query in a transaction and hands you a `next` function and the `tx` object.
- **Batch middleware** *(beta)* — prepends/appends SQL statements to each query in a single round trip, with no explicit transaction overhead.

## Install

```bash
npm install drizzle-middleware
# or
pnpm install drizzle-middleware
# or
bun add drizzle-middleware
```

## Stable vs Beta

The stable subpaths (`drizzle-middleware/pg`, `/mysql`, `/sqlite`) target `drizzle-orm >=0.45`. The beta subpaths (`drizzle-middleware/beta/pg`, `/beta/mysql`, `/beta/sqlite`) target `drizzle-orm >=1.0.0-beta` and include both the callback middleware and the batch middleware.

| Feature | Stable | Beta |
|---|---|---|
| Callback middleware (`withMiddleware`) | All dialects | All dialects |
| Batch middleware (`withBatchMiddleware`) | — | PG, SQLite |
| Relational query interception | — | All dialects |

## Callback Middleware

Import from the subpath that matches your dialect:

```ts
import { withMiddleware } from "drizzle-middleware/pg";
// or
import { withMiddleware } from "drizzle-middleware/mysql";
// or
import { withMiddleware } from "drizzle-middleware/sqlite";
```

`withMiddleware` takes a Drizzle database instance and a middleware function, and returns a new database instance of the same type. Every query execution is wrapped in a transaction, and the middleware receives `next` (runs the query) and `tx` (the transaction object).

### Logging

```ts
import { withMiddleware } from "drizzle-middleware/pg";

const db = drizzle(client);

const logged = withMiddleware(db, async (next, tx) => {
  const start = performance.now();
  const result = await next();
  console.log(`query took ${(performance.now() - start).toFixed(1)}ms`);
  return result;
});

await logged.select().from(users);
```

### Row-Level Security

The `tx` object lets you run statements in the same transaction as the query:

```ts
const secured = withMiddleware(db, async (next, tx) => {
  await tx.execute(
    sql`SELECT set_config('app.role', ${currentUser.role}, true)`
  );
  return next();
});
```

### Short-circuit

Skip the query entirely by not calling `next()`:

```ts
const readonly = withMiddleware(db, async (next, tx) => {
  if (isWriteBlocked) {
    throw new Error("writes are disabled");
  }
  return next();
});
```

### Chaining

Stack multiple middlewares. The first-applied middleware wraps outermost:

```ts
const db1 = withMiddleware(db, loggingMiddleware);
const db2 = withMiddleware(db1, authMiddleware);

// Execution order: logging -> auth -> query -> auth -> logging
```

### SQLite (sync)

For sync SQLite drivers like `bun:sqlite`, the middleware function is synchronous:

```ts
import { withMiddleware } from "drizzle-middleware/sqlite";

const db = drizzle(new Database(":memory:"));

const wrapped = withMiddleware(db, (next, tx) => {
  console.log("before");
  const result = next();
  console.log("after");
  return result;
});
```

## Batch Middleware (Beta)

The batch middleware takes a different approach: instead of a callback, you provide a factory function that returns arrays of SQL statements to prepend and/or append to each query.

```ts
import { withBatchMiddleware } from "drizzle-middleware/beta/pg";
// or
import { withBatchMiddleware } from "drizzle-middleware/beta/sqlite";
```

### RLS via set_config

```ts
import { withBatchMiddleware } from "drizzle-middleware/beta/pg";
import { sql } from "drizzle-orm";

const db = withBatchMiddleware(baseDb, () => ({
  before: [
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    sql`SELECT set_config('app.user_role', ${role}, true)`,
  ],
  after: [
    sql`SELECT set_config('app.tenant_id', '', true)`,
  ],
}));

await db.select().from(users).where(eq(users.id, 42));
```

For standalone queries on async drivers (Postgres, LibSQL, D1, Turso, etc.), all statements are concatenated and sent in a single round trip:

```sql
SELECT set_config('app.tenant_id', 'abc', true);
SELECT set_config('app.user_role', 'admin', true);
SELECT "id", "name" FROM "users" WHERE "id" = 42;
SELECT set_config('app.tenant_id', '', true)
-- one message, one round trip
```

For user-managed transactions, before/after queries execute individually at the transaction boundaries:

```ts
await db.transaction(async (tx) => {
  await tx.select().from(users);
  await tx.insert(logs).values({ action: "read" });
});

// BEGIN
// SELECT set_config('app.tenant_id', 'abc', true)    -- before
// SELECT set_config('app.user_role', 'admin', true)   -- before
// SELECT "id", "name" FROM "users"                    -- user query
// INSERT INTO "logs" ("action") VALUES ($1)            -- user query
// SELECT set_config('app.tenant_id', '', true)         -- after
// COMMIT
```

For sync SQLite drivers, queries are wrapped in a transaction and executed individually (sync drivers only process the first statement in a multi-statement string).

### Dynamic middleware

The middleware factory is called on every query execution. Return different statements based on request context:

```ts
const db = withBatchMiddleware(baseDb, () => {
  const tenant = getCurrentTenant();
  if (!tenant) return {};
  return {
    before: [sql`SELECT set_config('app.tenant', ${tenant}, true)`],
  };
});
```

When the factory returns empty `before` and `after` (or `{}`), the query executes directly with no wrapping — a fast path with zero overhead.

## API Reference

### Stable subpaths

| Subpath | Exports |
|---|---|
| `drizzle-middleware/pg` | `withMiddleware`, `Middleware` |
| `drizzle-middleware/mysql` | `withMiddleware`, `Middleware` |
| `drizzle-middleware/sqlite` | `withMiddleware`, `Middleware`, `SyncMiddleware` |
| `drizzle-middleware` | `withPgMiddleware`, `withMysqlMiddleware`, `withSqliteMiddleware` + type aliases |

### Beta subpaths

| Subpath | Exports |
|---|---|
| `drizzle-middleware/beta/pg` | `withMiddleware`, `Middleware`, `withBatchMiddleware`, `BatchMiddleware` |
| `drizzle-middleware/beta/mysql` | `withMiddleware`, `Middleware` |
| `drizzle-middleware/beta/sqlite` | `withMiddleware`, `Middleware`, `SyncMiddleware`, `withBatchMiddleware`, `BatchMiddleware` |
| `drizzle-middleware/beta` | All of the above with prefixed names (`withPgBatchMiddleware`, `withSqliteBatchMiddleware`, etc.) |

### Callback middleware signature

```ts
// Async (PG, MySQL, async SQLite)
type Middleware = (next: () => Promise<unknown>, tx: Transaction) => Promise<unknown>;

// Sync (sync SQLite)
type SyncMiddleware = (next: () => unknown, tx: Transaction) => unknown;
```

### Batch middleware signature

```ts
type BatchMiddleware = () => {
  before?: SQL[];
  after?: SQL[];
};
```

## How it works

### Callback middleware

`withMiddleware` creates a new database instance with a [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) around the session. The proxy intercepts `prepareQuery` and `transaction`. Each query execution is wrapped in a transaction so the middleware has access to a `tx` object for running additional statements in the same transaction as the original query.

### Batch middleware

`withBatchMiddleware` proxies both the dialect and the session. The dialect proxy captures the SQL AST before compilation so it can be re-inlined with all parameters baked into the SQL string. The session proxy intercepts query preparation and wraps each execution method.

On async drivers, all before + inner + after statements are concatenated into a single string and executed in one round trip (relying on PostgreSQL's implicit transaction for the Simple Query protocol, or the driver's native multi-statement support). On sync drivers, an explicit transaction wraps individual execution of each statement.

## License

MIT
