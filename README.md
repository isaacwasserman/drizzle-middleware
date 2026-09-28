# drizzle-middleware

Run SQL statements before and after every [Drizzle ORM](https://orm.drizzle.team) query, in the same transaction and, where the driver allows it, in one round trip. Use it for row-level security, tenant isolation, audit trails, or session settings.

The package fails closed: if it cannot run the middleware with its guarantees, the query does not run. It throws.

## Install

```bash
bun add drizzle-middleware
# or
npm install drizzle-middleware
```

Requires `drizzle-orm` **1.0.0-beta.22**, the version the tests run against.

## Supported drivers

| Driver | How a unit runs | Round trips |
|---|---|---|
| node-postgres (`pg`) | One pipeline: every statement, then one Sync | 1 |
| postgres-js, `prepare: true` | `BEGIN`, the statements and `COMMIT`, pipelined on one connection | 1 (after the first run of each query text on a connection) |
| postgres-js, `prepare: false` | The same, with values written into the SQL by a strict encoder | 1 |
| Bun SQL (Postgres), Bun 1.4+, `prepare: true` | `BEGIN`, the statements and `COMMIT`, pipelined on one connection | 1 |
| Bun SQL, `prepare: false`, or Bun before 1.4 | One statement at a time, in a transaction | 1 per statement |
| PGlite | A local transaction | In-process |
| bun:sqlite, better-sqlite3 | A native sync transaction | In-process |
| Bun SQL (SQLite) | A transaction, one statement at a time; one unit at a time for each client | In-process |

Any other driver throws when you wrap it.

## Usage

```ts
import { withMiddleware } from "drizzle-middleware/pg";
// or: import { withMiddleware } from "drizzle-middleware/sqlite";
import { sql } from "drizzle-orm";

const db = withMiddleware(baseDb, () => ({
  before: [sql`select set_config('app.tenant_id', ${tenantId}, true)`],
  after: [sql`select set_config('app.tenant_id', '', true)`],
}));

await db.select().from(users);
```

The middleware factory is called for each unit. It returns the `before` and `after` statements, as arrays of Drizzle `SQL` objects. When both are empty or missing, the query runs without middleware.

## Guarantees

For every unit (the `before` statements, one or more queries, the `after` statements):

1. **Order.** `before`, the queries, then `after`.
2. **Atomicity.** All statements run in one transaction. If one fails, the unit rolls back, and you get the error of the statement that failed.
3. **Same connection.** Transaction-local state set in `before` (`set_config(..., true)`, `SET LOCAL`) is visible to the queries, and it is gone after the unit.
4. **Exact values.** Values stay parameters. The one exception is postgres-js with `prepare: false`: there, the strict encoder writes each value as a literal that behaves like the parameter, and it throws for any value outside a closed set (strings, numbers, bigints, booleans, bytes, null).
5. **Exact results.** Drizzle prepares each query, calls the driver, and maps the result. You get the same result as without middleware.

The package cannot check what your statements do. Use transaction-local state only: session-level state (`set_config(..., false)`, `SET` without `LOCAL`) stays on a pooled connection and reaches later queries.

## Transactions

```ts
await db.transaction(async (tx) => {
  await tx.select().from(users); // before is sent with this first query
  await tx.insert(logs).values({ action: "read" });
}); // after is sent before the commit
```

In `db.transaction(fn)`, the factory is called once for the transaction. `before` goes out with the first query, and `after` goes out before the commit. `tx` is wrapped too, and nested transactions (savepoints) keep the middleware.

You can also wrap a transaction that is already open. Then `before` and `after` run around each query in it:

```ts
await baseDb.transaction(async (tx) => {
  const wrapped = withMiddleware(tx, middleware);
  await wrapped.select().from(users); // before, query, after
});
```

`setTransaction()` on a wrapped transaction runs without middleware, because Postgres requires `SET TRANSACTION` to be the first statement of a transaction.

A `tx` that you keep after its transaction ends throws on each query. On bun:sqlite and better-sqlite3, the transaction callback must be sync: the driver commits when the callback returns, so an async callback throws a `TypeError`, and its transaction rolls back.

## Stacking

A wrapped db can be wrapped again. `before` runs outermost layer first, and `after` runs innermost layer first. The whole stack is still one unit.

```ts
const tenantDb = withMiddleware(baseDb, tenantMiddleware);
const auditedDb = withMiddleware(tenantDb, auditMiddleware);
```

## executeBatchTransaction

Runs several queries, plus the middleware of the db they come from, as one unit:

```ts
import { executeBatchTransaction } from "drizzle-middleware";

const [inserted, rows] = await executeBatchTransaction([
  db.insert(users).values({ name: "Ada" }).returning(),
  db.select().from(users),
]);
```

Pass query builders, not awaited results. All queries must come from the same db.

## Types

`withMiddleware(db, factory)` returns `WithMiddleware<typeof db>`: the db's own type plus a brand. A wrapped db is accepted everywhere the base db is. To require a wrapped db, use the brand in a parameter type:

```ts
import type { WithMiddleware } from "drizzle-middleware/pg";

function listUsers(db: WithMiddleware<typeof baseDb>) {
  return db.select().from(users);
}

listUsers(baseDb); // compile error
listUsers(db); // ok
```

The `tx` inside `db.transaction(fn)` has the brand too.

## What throws

- A driver that is not in the table above.
- A db with a Drizzle query cache. A cache key has no middleware context, so a cached result could reach a caller whose middleware gives a different result.
- `db.$client` on a wrapped db. A query sent on the driver client does not run the middleware. Use the unwrapped db's `$client` if you need the driver.
- Drizzle APIs that send queries without the middleware, such as `db.batch()`, or any other member that the package has not reviewed.
- A Drizzle version whose internals differ from the tested version.

## Driver notes

- **node-postgres:** `pg` is an optional peer dependency, loaded only when you wrap a node-postgres db.
- **postgres-js:** with `prepare: true`, the first run of each query text on a connection costs about one extra round trip per statement, while postgres-js learns the parameter types. After that, it is one round trip.
- **postgres-js, `prepare: false`, and a wrapped open transaction:** a postgres-js transaction client does not show the `prepare` setting, so `withMiddleware(tx)` keeps the values as parameters. Each statement with parameters then costs one extra round trip. `wrapped.transaction(fn)` does not have this cost: it uses the setting of the wrapped db.
- **Bun SQL:** one round trip needs Bun 1.4 or newer and `prepare: true` (the default).
- **Bun SQL (SQLite):** the client has one connection, and it does not queue transactions itself. The package queues all work that goes through wrapped dbs on the same client, so a query cannot join a transaction that another unit has open. Queries on the unwrapped db do not go through this queue: while a wrapped unit or `transaction(fn)` is open, they can run inside it. Inside `wrapped.transaction(fn)`, use `tx`, not the wrapped db; a query on the wrapped db waits for the transaction to end, so the two wait for each other.

## How it works

`withMiddleware` builds a new db of the same class around a guarded session. When a query runs, the package runs Drizzle's own prepared query for each statement of the unit against a stand-in for the driver client, which records the one driver call that Drizzle makes. It then sends the recorded calls with the driver's batching mechanism, and gives each result back to Drizzle to map. See [docs/design.md](docs/design.md) for the full design.

## License

MIT
