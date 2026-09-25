# drizzle-middleware

Query middleware for [Drizzle ORM](https://orm.drizzle.team). Prepends and appends SQL statements to every query in a single round trip — useful for RLS, audit trails, tenant isolation, or session configuration.

Supports Postgres and SQLite (sync and async). Requires `drizzle-orm` v1.0.0-beta or later.

## Install

```bash
npm install drizzle-middleware
# or
pnpm install drizzle-middleware
# or
bun add drizzle-middleware
```

## Usage

```ts
import { withMiddleware } from "drizzle-middleware/pg";
// or
import { withMiddleware } from "drizzle-middleware/sqlite";
```

`withMiddleware` takes a Drizzle database instance and a middleware factory function, and returns a new database instance of the same type. The factory is called on every query execution and returns arrays of SQL statements to run before and/or after the query.

### RLS via set_config

```ts
import { withMiddleware } from "drizzle-middleware/pg";
import { sql } from "drizzle-orm";

const db = withMiddleware(baseDb, () => ({
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

All statements are sent in a single round trip:

```sql
SELECT set_config('app.tenant_id', 'abc', true);
SELECT set_config('app.user_role', 'admin', true);
SELECT "id", "name" FROM "users" WHERE "id" = 42;
SELECT set_config('app.tenant_id', '', true)
-- one round trip
```

### Transactions

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

You can also wrap a transaction that is already open. Then before/after run around each query in it, and a nested transaction (savepoint) is wrapped with the same middleware:

```ts
await baseDb.transaction(async (tx) => {
  const wrapped = withMiddleware(tx, middleware);
  await wrapped.select().from(users); // before, query, after
  await wrapped.transaction(async (savepoint) => {
    await savepoint.insert(logs).values({ action: "read" }); // before, query, after
  });
});
```

### Dynamic middleware

The middleware factory is called on every query execution. Return different statements based on request context:

```ts
const db = withMiddleware(baseDb, () => {
  const tenant = getCurrentTenant();
  if (!tenant) return {};
  return {
    before: [sql`SELECT set_config('app.tenant', ${tenant}, true)`],
  };
});
```

When the factory returns empty `before` and `after` (or `{}`), the query executes directly with no wrapping — a fast path with zero overhead.

### SQLite (sync)

For sync SQLite drivers like `bun:sqlite`, queries are wrapped in a transaction and executed individually:

```ts
import { withMiddleware } from "drizzle-middleware/sqlite";

const db = withMiddleware(baseDb, () => ({
  before: [sql`INSERT INTO kv (key, value) VALUES ('tenant', ${tenantId})`],
}));

db.select().from(users).all();
```

### Drivers that cannot batch

Prisma (PG and SQLite) and the SQLite proxy driver run one statement per call, so they cannot batch. For these drivers, the middleware opens a transaction (a Prisma interactive transaction, or the proxy's own `begin` … `commit`) and runs before, the query, and after one at a time in it. They are still atomic, but each statement is a separate round trip.

pg-proxy and Xata are not supported. They have no batch and no transactions, so separate calls would not be atomic, and transaction-local state such as `set_config(..., true)` would not reach the query. `withMiddleware` throws for them.

## Batched transactions

The same machinery that lets middleware run in one round trip is also exported
directly as `executeBatchTransaction`. It takes an array of Drizzle queries and runs
them in a single batch, sequentially, then returns each query's result as a
tuple in the same order:

```ts
import { executeBatchTransaction } from "drizzle-middleware";
// or: import { executeBatchTransaction } from "drizzle-middleware/pg";

const [inserted, users] = await executeBatchTransaction([
  db.insert(users).values({ name: "Alice" }).returning(),
  db.select().from(users),
]);
```

Pass the queries built from your normal database instance — do not `await` them
first. Each query keeps its own type, so the returned tuple is fully typed. The
queries must come from the same database instance.

Like the middleware, the queries are compiled with parameters inlined and sent
through the driver's native batch mechanism (one Simple Query message for
TCP drivers, the batch API for HTTP drivers). For sync SQLite (`bun:sqlite`)
there is no round trip to collapse, so the queries run atomically inside one
native transaction instead.

If the queries come from a `withMiddleware`-wrapped db, the middleware is
honored: every layer's `before`/`after` runs once around the whole batch (never
bypassed). This is the same envelope the middleware itself runs through.

### Composing middleware

`withMiddleware` can wrap an already-wrapped db. The layers compose as an onion:
each `before` runs outermost-first, each `after` innermost-first, and the whole
stack still executes in a single round trip.

```ts
const rls = withMiddleware(baseDb, () => ({
  before: [sql`SELECT set_config('app.tenant', ${tenantId}, true)`],
}));
const audited = withMiddleware(rls, () => ({
  after: [sql`INSERT INTO audit (action) VALUES ('read')`],
}));

// One round trip: set_config → user query → audit insert.
await audited.select().from(users);
```

### Fail-closed guard

A wrapped db only exposes the session and prepared-query members that are known to run the middleware. If Drizzle code tries to read any other member, for example the driver client or a method that calls the driver directly, the read throws. It does not skip the middleware:

```ts
const db = withMiddleware(libsqlDb, middleware);
await db.batch([...]); // throws: `batch` sends queries without the middleware
```

This applies to Postgres and SQLite. A member that a new Drizzle version adds is blocked until it is reviewed. `$client` on a wrapped db also throws, because a query sent on the driver does not run the middleware. The guard applies only to access through the wrapped db: the unwrapped db and its `$client` still reach the driver directly.

## API Reference

### Subpaths

| Subpath | Exports |
|---|---|
| `drizzle-middleware/pg` | `withMiddleware`, `Middleware`, `executeBatchTransaction` |
| `drizzle-middleware/sqlite` | `withMiddleware`, `Middleware`, `executeBatchTransaction` |
| `drizzle-middleware` | `withPgMiddleware`, `PgMiddleware`, `withSqliteMiddleware`, `SqliteMiddleware`, `executeBatchTransaction` |

### Signature

```ts
type Middleware = () => {
  before?: SQL[];
  after?: SQL[];
};

function withMiddleware<TDb>(db: TDb, middleware: Middleware): TDb;

function executeBatchTransaction<T extends readonly PromiseLike<unknown>[]>(
  queries: readonly [...T],
): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
```

## How It Works

`withMiddleware` proxies both the dialect and the session. The dialect proxy captures the SQL AST before compilation so parameters can be inlined into the SQL string. The session proxy intercepts query preparation and wraps each execution method.

The middleware selects the native batching mechanism exposed by the driver. TCP-based drivers concatenate all statements into one Simple Query message, HTTP drivers use their batch API, and sync SQLite uses an explicit transaction.

## License

MIT
