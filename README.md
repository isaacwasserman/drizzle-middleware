# drizzle-middleware

Query middleware for [Drizzle ORM](https://orm.drizzle.team) on [node-postgres](https://node-postgres.com). It runs SQL statements before and after each query, in the same transaction and in one round trip. Use it for RLS, tenant isolation, audit trails or session settings.

Requirements: `drizzle-orm` 1.0 beta or later, `pg` 8.23 or later, and a `pg.Pool`.

## Install

```bash
bun add drizzle-middleware
# or
npm install drizzle-middleware
```

## Usage

```ts
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { withMiddleware } from "drizzle-middleware/node-postgres";
import pg from "pg";

const db = drizzle({ client: new pg.Pool({ connectionString }) });

const tenantDb = withMiddleware(db, () => ({
  before: [sql`select set_config('app.tenant_id', ${tenantId}, true)`],
  after: [sql`insert into audit (action) values ('query')`],
}));

await tenantDb.select().from(users);
```

`withMiddleware(db, middleware)` returns a new db of the same type. The app's `db` does not change.

The middleware function is called once for each query outside a transaction, and once for each `db.transaction()`. It returns `before` and `after`, which are arrays of Drizzle `sql` statements. Values in the statements are bound parameters.

### A query outside a transaction

The package sends all of these statements in one round trip, through pg's pipeline mode:

```sql
BEGIN;
select set_config('app.tenant_id', $1, true);   -- before
select "id", "name" from "users";               -- the query
insert into audit (action) values ('query');    -- after
COMMIT;
```

The result is the result of the query. The unit is all or nothing. If a statement fails, Postgres rolls back all the statements and the error goes to the caller:

- If the query fails, Drizzle throws the same error as without middleware.
- If a middleware statement fails (or COMMIT fails), the cause is a `MiddlewareError`. It has `stage` (`"begin"`, `"before"`, `"after"` or `"commit"`), `index` and `query`.

### db.transaction()

```ts
await tenantDb.transaction(async (tx) => {
  await tx.select().from(users);
  await tx.insert(logs).values({ action: "read" });
});
```

```sql
BEGIN; before; select ...      -- round trip 1
insert ...                     -- round trip 2
after; COMMIT                  -- round trip 3
```

`before` goes in the same round trip as the first query. `after` goes in the same round trip as COMMIT. Thus the middleware adds no round trips. Plain Drizzle uses four round trips for this transaction, because it sends BEGIN and COMMIT alone.

Nested transactions (savepoints), `tx.rollback()` and the transaction config (`isolationLevel`, `accessMode`, `deferrable`) work as in Drizzle. `tx.setTransaction()` does not always work (see [Rules](#rules)).

If the transaction cannot commit, `db.transaction()` throws a `MiddlewareError`, also when the callback caught the error that aborted the transaction. (Plain Drizzle returns as if the transaction committed, because Postgres changes that COMMIT into ROLLBACK.)

### A transaction as input

`withMiddleware` also takes a transaction of a node-postgres db on a `pg.Pool`, at any nesting level. For example, a test harness can run each test in a transaction that it rolls back, and give the app the transaction as its db:

```ts
await db.transaction(async (testTx) => {
  const tenantDb = withMiddleware(testTx, middleware);
  await runAppCode(tenantDb);
  testTx.rollback();
});
```

The result behaves like a db with middleware, with savepoints in place of BEGIN and COMMIT:

- Each query runs as `SAVEPOINT; before; query; after; RELEASE` in one round trip on the transaction's connection. If a statement fails, a second round trip rolls back to the savepoint. The unit is then all or nothing, and the app's transaction goes on.
- `tx.transaction(fn)` puts `before` with the first query and `after` with the RELEASE of its savepoint. The transaction config is ignored, as in Drizzle's nested transactions: a savepoint cannot change the isolation level.
- `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` as a query are rejected: they could end the unit's savepoint or undo `before`.
- After the app's transaction ends, each query throws. The pool can give the connection to another request, and the package must not run the middleware in that request's transaction.
- Settings that `before` sets with `set_config(..., true)` or `SET LOCAL` stay until the app's transaction ends: RELEASE of a savepoint does not undo them. Each query with middleware sets them again, but a later query without middleware in the same transaction also sees them.
- Reads do not use the query cache. Writes still invalidate it.
- A transaction that already has middleware, a transaction of a db with middleware, and a transaction on a `pg.Client` are rejected.

### No middleware

If the middleware returns no statements (`{}` or empty arrays), the query or transaction runs exactly as in plain Drizzle.

## Query cache

If the db has a Drizzle query cache, the db with middleware uses it for reads. To turn this off, pass `{ cache: false }`. Then reads do not use the cache, and writes still invalidate it, so each query runs its middleware:

```ts
const db = drizzle({ client: pool, cache });
const tenantDb = withMiddleware(db, middleware); // reads use the cache
const auditedDb = withMiddleware(db, audit, { cache: false }); // reads do not
```

The cache key of a read is the hash of the whole unit: BEGIN, the `before` statements and their values, the query, the `after` statements, and COMMIT. A cached result is used again only for the same middleware statements and values, so a result for one tenant cannot go to a different tenant. The middleware function is called once for each read; on a miss, the unit runs with those same statements.

Know these limits of the cache:

- A cache hit sends nothing to the database: `before` and `after` do not run. If `after` must run for each query (for example an audit insert), use `{ cache: false }`.
- Writes in `before` and `after` do not invalidate the cache. Writes by the app's queries invalidate their tables as usual.
- `$withCache({ tag })` throws: a tag replaces the key, so the middleware would not be part of it.
- Inside `db.transaction()`, reads do not use the cache. Writes still invalidate.
- With empty middleware, the key is the same as in plain Drizzle.

## Rules

The package fails closed: if it cannot run the middleware with a query, the query fails. The one exception is a cache hit, which runs no SQL (see [Query cache](#query-cache)).

- `withMiddleware` throws for each db that is not from `drizzle-orm/node-postgres` with a `pg.Pool`. This includes `pg.Client`, `PoolClient`, pg-native, other drivers, and a db that already has middleware. A transaction is accepted (see [A transaction as input](#a-transaction-as-input)).
- One pooled connection runs each unit. A `pg.Client` is not accepted: the package's BEGIN could run inside the transaction of a different request. For one connection, use `new pg.Pool({ max: 1 })`.
- The package rejects a query that starts or ends a transaction (`BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `PREPARE TRANSACTION`). Use `db.transaction()`. `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` are allowed.
- The package rejects `COPY`. In the copy mode, Postgres ignores the statements after it in the pipeline. Plain Drizzle cannot send COPY data either.
- When there is middleware, each statement uses the extended protocol. Thus a text with two statements (`select 1; select 2`) fails. Plain Drizzle sends such a text without parameters as a simple query.
- When there is middleware, each query runs in a transaction. Statements that Postgres does not allow in a transaction (for example `VACUUM` or `CREATE INDEX CONCURRENTLY`) fail. Run them on the app's `db`.
- When there are `before` statements, `tx.setTransaction()` fails in `db.transaction()`. The same is true for `SET TRANSACTION ISOLATION LEVEL` and `SET TRANSACTION SNAPSHOT`. The `before` statements run first, and Postgres does not allow these statements after a query. Use the transaction config: `db.transaction(callback, { isolationLevel })`.
- Before the package sends a unit, it checks for a value that pg cannot serialize and for a prepared statement name that has a different text. Then it sends nothing, because pg would fail only that statement and the others would commit.
- `db.$client` is the app's pool. Queries on it do not run the middleware.
- pg's `query_timeout` acts only on the client. When it fires, the package destroys the connection, but the server has all the statements of the unit and can still commit them together, as it would for a plain query.

## API

```ts
import {
  withMiddleware,
  MiddlewareError,
  type Middleware,
  type MiddlewareOptions,
  type MiddlewareStatements,
  type MiddlewareStage,
} from "drizzle-middleware/node-postgres";

type Middleware = () => { before?: SQL[]; after?: SQL[] };

interface MiddlewareOptions {
  cache?: boolean; // use the db's query cache for reads (default: true)
}

function withMiddleware<
  TDb extends
    | (NodePgDatabase<any, any> & { $client: pg.Pool })
    | NodePgTransaction<any, any, any>,
>(
  db: TDb,
  middleware: Middleware,
  options?: MiddlewareOptions,
): TDb;
```

## Development

The tests need Postgres. They use `DATABASE_URL`, or `postgres://postgres:postgres@localhost:55441/postgres`:

```bash
podman run -d --name drizzle-mw-pg -e POSTGRES_PASSWORD=postgres -p 55441:5432 postgres:17
bun test
```

## License

MIT
