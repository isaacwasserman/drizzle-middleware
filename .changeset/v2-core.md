---
"drizzle-middleware": minor
---

New execution core. The middleware now fails closed: if it cannot run your statements with its guarantees, the query throws instead of running without them.

**Guarantees.** For every unit (`before`, the queries, `after`): the statements run in order, in one transaction, on one connection, and a failure rolls back the whole unit. Values stay parameters, and Drizzle maps every result itself.

**Supported drivers:** node-postgres, postgres-js, Bun SQL (Postgres and SQLite), PGlite, bun:sqlite and better-sqlite3. node-postgres, postgres-js and Bun SQL 1.4+ (with `prepare: true`) send a unit in one round trip. Every other driver throws.

**New:**

- `executeBatchTransaction([...queries])` runs several queries and the middleware as one unit.
- `withMiddleware` returns `WithMiddleware<typeof db>`. Use it as a parameter type to require a wrapped db at compile time.
- `db.transaction(fn)` runs the middleware once: `before` with the first query, `after` before the commit. Nested transactions keep the middleware.
- Wrapped dbs can be stacked.

**Breaking:**

- `drizzle-orm` must be `1.0.0-beta.22`.
- A db with a Drizzle query cache is rejected.
- `db.$client` on a wrapped db throws.
- `db.batch()` and other Drizzle APIs that would skip the middleware throw.
- On bun:sqlite and better-sqlite3, an async transaction callback throws. The driver commits when the callback returns, so the queries after an `await` ran outside the transaction, without the middleware.
- A query on a `tx` after its transaction ends throws.
- `withMiddleware` accepts a db, not a transaction. Use `withMiddleware(db, middleware).transaction(fn)`. A db whose client is a Bun SQL transaction handle is rejected too.
- Drivers other than the ones above are rejected.
- `withMiddleware` returns `WithMiddleware<typeof db>`, which is still assignable to `typeof db`.

**Fixed** (compared with 0.1.0): values are no longer written into the SQL text, which allowed SQL injection with `standard_conforming_strings = off` and broke `bytea`, `NaN` and raw `Date` values; a query could run the previous query's SQL; cached results could reach the wrong tenant; results could be taken from the wrong statement.
