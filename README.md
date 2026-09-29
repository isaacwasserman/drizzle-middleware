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

The package follows three rules:

1. **Transactions keep the database's semantics:** isolation, locking, savepoints and options.
2. **The middleware runs, or the query fails.** A unit with middleware is all or nothing, on every database.
3. **One round trip per unit,** unless the driver cannot do it (see the driver table).

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

`withMiddleware` accepts a db, not a transaction. Most drivers do not show when a transaction has ended, so a wrapped transaction that you keep after its end could run queries outside it, or inside another request's transaction on the same connection. Wrap the db, and open the transaction on the wrapped db:

```ts
await withMiddleware(baseDb, middleware).transaction(async (tx) => {
  await tx.select().from(users);
});
```

`setTransaction()` on a wrapped transaction runs without middleware, because Postgres requires `SET TRANSACTION` to be the first statement of a transaction.

The transaction is one unit with its middleware, so if any query in it fails, the whole transaction fails and rolls back, even if the callback catches the error: later work on `tx` throws, and the transaction rejects with the first error. Inside the callback, use `tx`, not the wrapped db. A query on the wrapped db itself is not part of the transaction's unit: on bun:sqlite and better-sqlite3 it throws, and on a single connection (see the driver notes) it waits for the transaction to end. To undo only part of the work, use a savepoint (`tx.transaction(...)`): a failed query in it rolls back that savepoint, and you can catch its error and go on. When the callback settles, the transaction closes for new work: a query on `tx` that starts after that throws. Work that started before, for example a query that the callback did not await, finishes inside the transaction before the COMMIT or ROLLBACK. A `tx` that you keep after its transaction ends throws on each query. On bun:sqlite and better-sqlite3, the transaction callback must be sync: the driver commits when the callback returns, so an async callback throws a `TypeError`, and its transaction rolls back.

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
- A SQL text with more than one statement, in a query or in a middleware statement. Send each statement as its own query, or as its own middleware statement.
- A transaction passed to `withMiddleware`, or a db whose client is a transaction handle (for example a Bun SQL `begin` handle). Pass the db, on the pool.
- A db with a Drizzle query cache. A cache key has no middleware context, so a cached result could reach a caller whose middleware gives a different result.
- `db.$client` on a wrapped db. A query sent on the driver client does not run the middleware. Use the unwrapped db's `$client` if you need the driver.
- Drizzle APIs that send queries without the middleware, such as `db.batch()`, or any other member that the package has not reviewed.
- A Drizzle version whose internals differ from the tested version.

## Driver notes

- **node-postgres:** `pg` is an optional peer dependency, loaded only when you wrap a node-postgres db.
- **One connection: node-postgres with a `pg.Client` (not a `Pool`), or a Bun SQL reserved connection (`await sql.reserve()`):** the client is one connection, and Drizzle opens transactions on it. The package queues all work that goes through wrapped dbs on the same client, like a pool of one connection: while a `wrapped.transaction(fn)` is open, other units wait for it to end. Queries on the unwrapped db do not go through this queue. Inside `wrapped.transaction(fn)`, use `tx`, not the wrapped db. For concurrent requests, use a `Pool`.
- **postgres-js and a lost connection:** postgres-js 3.4.9 does not recover a pool of one connection (`max: 1`) after a connection is lost inside `reserve()` or a transaction, with or without this package. The package reserves a connection for each unit, so use `max` of 2 or more.
- **postgres-js:** with `prepare: true`, the first run of each query text on a connection costs about one extra round trip per statement, while postgres-js learns the parameter types. After that, it is one round trip.
- **Bun SQL:** one round trip needs Bun 1.4 or newer and `prepare: true` (the default).
- **Bun SQL (SQLite):** the client has one connection, and it does not queue transactions itself. The package queues all work that goes through wrapped dbs on the same client, so a query cannot join a transaction that another unit has open. Queries on the unwrapped db do not go through this queue: while a wrapped unit or `transaction(fn)` is open, they can run inside it. Inside `wrapped.transaction(fn)`, use `tx`, not the wrapped db; a query on the wrapped db waits for the transaction to end, so the two wait for each other.

## How it works

`withMiddleware` builds a new db of the same class around a guarded session. When a query runs, the package runs Drizzle's own prepared query for each statement of the unit against a stand-in for the driver client, which records the one driver call that Drizzle makes. It then sends the recorded calls with the driver's batching mechanism, and gives each result back to Drizzle to map. See [docs/design.md](docs/design.md) for the full design.

## License

MIT
