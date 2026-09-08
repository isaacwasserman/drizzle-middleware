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

## API Reference

### Subpaths

| Subpath | Exports |
|---|---|
| `drizzle-middleware/pg` | `withMiddleware`, `Middleware` |
| `drizzle-middleware/sqlite` | `withMiddleware`, `Middleware` |
| `drizzle-middleware` | `withPgMiddleware`, `PgMiddleware`, `withSqliteMiddleware`, `SqliteMiddleware` |

### Signature

```ts
type Middleware = () => {
  before?: SQL[];
  after?: SQL[];
};

function withMiddleware<TDb>(db: TDb, middleware: Middleware): TDb;
```

## How It Works

`withMiddleware` proxies both the dialect and the session. The dialect proxy captures the SQL AST before compilation so parameters can be inlined into the SQL string. The session proxy intercepts query preparation and wraps each execution method.

The middleware selects the native batching mechanism exposed by the driver. TCP-based drivers concatenate all statements into one Simple Query message, HTTP drivers use their batch API, and sync SQLite uses an explicit transaction.

## License

MIT
