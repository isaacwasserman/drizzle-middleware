# drizzle-middleware

Query middleware for [Drizzle ORM](https://orm.drizzle.team). Wraps every query and transaction in a callback so you can run code before and after execution. This is useful for logging, RLS, audit trails, or access control.

Supports Postgres, MySQL, and SQLite (sync and async).

## Install

```bash
npm install drizzle-middleware
# or
pnpm install drizzle-middleware
# or
bun add drizzle-middleware
```

## Usage

Import from the subpath that matches your dialect:

```ts
import { withMiddleware } from "drizzle-middleware/pg";
// or
import { withMiddleware } from "drizzle-middleware/mysql";
// or
import { withMiddleware } from "drizzle-middleware/sqlite";
```

`withMiddleware` takes a Drizzle database instance and a middleware function, and returns a new database instance. Every query and transaction on the wrapped instance calls your middleware.

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

// All queries go through the middleware
await logged.select().from(users);
```

### Row-Level Security

The middleware receives a transaction object as its second argument. You can run statements inside it before the query executes:

```ts
const secured = withMiddleware(db, async (next, tx) => {
  await tx
    .select()
    .from(sql`set_config('role', ${currentUser.role}, true)`);
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

// Execution order: logging → auth → query → auth → logging
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

## API

Each subpath exports `withMiddleware` and `Middleware`:

| Subpath | `withMiddleware(db, middleware)` | `Middleware` type |
|---|---|---|
| `drizzle-middleware/pg` | `PgDatabase` | `(next, tx: PgTransaction) => Promise` |
| `drizzle-middleware/mysql` | `MySqlDatabase` | `(next, tx: MySqlTransaction) => Promise` |
| `drizzle-middleware/sqlite` | `BaseSQLiteDatabase` | async or sync depending on the db |

The SQLite subpath also exports `SyncMiddleware` for sync drivers.

A barrel import is available at `drizzle-middleware` with prefixed names (`withPgMiddleware`, `withMysqlMiddleware`, `withSqliteMiddleware`).

## How it works

`withMiddleware` creates a new database instance with a [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) around the session. The proxy intercepts `prepareQuery` and `transaction`. Each query execution is wrapped in a transaction so the middleware has access to a `tx` object for running additional statements in the same transaction as the original query.

## License

MIT
