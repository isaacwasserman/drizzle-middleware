# drizzle-middleware v2: design and semantics

Status: implemented for the first release (node-postgres, postgres-js, Bun SQL Postgres, PGlite, bun:sqlite, better-sqlite3, Bun SQL SQLite). The other drivers in section 5 are planned; `withMiddleware` throws for them.

## 0. Rules

Every other section follows from these three rules. A behavior that breaks one of them is a bug.

1. **Transactions keep the database's semantics:** isolation, locking, savepoints, transaction options, commit and rollback. The package adds only what rule 2 needs.
2. **The middleware runs, or the query fails.** A unit with middleware is all or nothing, on every database: the inner function cannot know what `before` and `after` need (for example, `after` may be needed for the state that `before` left to be correct), so if any statement of the unit fails, the whole unit fails. That the package runs a unit as a transaction is an implementation detail; the dialect does not change this rule. In `wrapped.transaction(fn)`, the unit is the transaction: any failed query fails the whole transaction, even when `fn` catches the error. A savepoint that fails rolls back only its own part, because `before` and `after` are outside it; its error goes to the parent, which may catch it.
3. **One round trip per unit, unless the driver cannot do it.** The exceptions are listed in section 5: Bun SQL with `prepare: false` or before Bun 1.4 (Bun does not pipeline), postgres-js for a unit longer than `max_pipeline`, and the in-process drivers (no network).

The tests for each rule are listed in section 11.

## 1. Goals

1. **Fail closed.** If the package cannot run the middleware with the guarantees in section 3, the query does not run. It throws.
2. **Batching is the default.** A wrapped query and its middleware go to the database in one round trip wherever the driver allows it.
3. **Values stay parameters.** The package does not build SQL from values, except in one driver configuration (section 6), through one strict encoder.
4. **Drizzle does the work.** Drizzle prepares each query, calls the driver, and maps the result. The package only groups those driver calls into one batch.

## 2. Terms

- **Middleware factory:** the function passed to `withMiddleware`. Each call returns the `before` and `after` statements.
- **Unit:** the statements that must run together: `before`, one or more queries, `after`.
- **Batch:** one unit sent to the database in one round trip.
- **Driver entry:** the registry record that says how one driver runs a unit (section 5).

## 3. Guarantees

For every unit:

1. **Order.** The statements run in this order: `before` (outermost layer first), the queries, `after` (innermost layer first).
2. **Atomicity.** The statements run in one transaction. If one statement fails, the whole unit rolls back, and the caller gets the error of the failing statement.
3. **Same connection.** All statements of a unit run on one connection. Transaction-local state (`set_config(..., true)`, `SET LOCAL`) set in `before` is visible to the queries, and it is gone after the unit.
4. **Exact values.** Each value reaches the database in the form that the driver would send for the same query without middleware.
5. **Exact results.** A query returns the same result that Drizzle returns without middleware, including the auth token, logging, and row mapping.

The package cannot check what the middleware statements do. Session-level state (`set_config(..., false)`, `SET` without `LOCAL`) stays on a pooled connection and reaches later queries. The README must say: use transaction-local state only.

## 4. Scopes

| Call | Unit |
|---|---|
| A query on a wrapped db | `before`, the query, `after` |
| `executeBatchTransaction([...])` | `before`, all queries in order, `after` |
| `wrapped.transaction(fn)` | `before` is sent with the first query in the transaction. `after` is sent as one batch before the commit. The factory is called once for the transaction. If any query fails, the whole transaction fails and rolls back, even when `fn` catches the error (rule 2): later work on `tx` throws, and the transaction rejects with the first error. When `fn` settles, the scope closes: new work on `tx` (a query, a batch, a savepoint, `setTransaction()`) throws. Work that the scope admitted before finishes before `after` and the COMMIT or ROLLBACK, so no statement of the scope reaches the connection after them. |
| `withMiddleware(tx)` (a transaction) | Throws. Most drivers do not show when a transaction has ended: node-postgres, postgres-js and Bun SQL run queries on a kept transaction object after its end, on a connection that another request can use. So only a db can be wrapped, and `wrapped.transaction(fn)` tracks the end of its own transactions. |
| A nested transaction (savepoint) on a wrapped transaction | Same rules as its parent. The savepoint is opened by the driver on the unwrapped transaction. A failed query in it fails the savepoint, even when its callback catches the error: the savepoint rolls back and throws to its parent. In `wrapped.transaction(fn)`, if the scope's `before` has not run yet, it runs on the parent before the savepoint opens, so a rolled-back savepoint cannot undo it. |

`setTransaction()` on a wrapped transaction runs without middleware, as the first statement, because Postgres rejects `SET TRANSACTION` after any other statement. It is a transaction-control statement and reads no data; this is a reviewed exception. Because `before` goes out with the first query of a transaction, the order stays valid.

## 5. Driver registry

Each supported driver has one explicit entry, keyed by Drizzle's session kind. A session kind without an entry throws. The package does not guess driver capabilities.

An entry declares:

- **Strategy:** how a unit runs (see the table).
- **Recording:** how to give Drizzle a stub client that records the one driver call that each Drizzle prepared query makes, so the entry can send the recorded calls as one batch and return each result to Drizzle.
- **Construction:** how to build the wrapped db, so no constructor argument is lost.

Strategies:

- **Pipeline:** Parse/Bind/Execute for every statement, then one Sync. Postgres runs everything before the Sync as one implicit transaction. One round trip, with parameters.
- **Pipelined transaction:** `BEGIN`, the statements, and `COMMIT` sent concurrently on one reserved connection. One round trip once the driver knows each query text (about one extra round trip for each new query text on a connection).
- **Pipelined transaction, inline:** like the pipelined transaction, with each statement's values inlined by the strict encoder (section 6), so no statement waits for its parameter types. Each statement is sent on its own (not as one multi-statement message), so each keeps its own result. One round trip.
- **Batch API:** the driver's own atomic batch call, with parameters. One round trip.
- **Local transaction:** a normal transaction. The database runs in-process, so there are no network round trips.
- **Sequential:** a normal transaction with one call per statement. Only for drivers that have no one-round-trip mechanism.
- **Rejected:** the driver has no transactions, so no strategy can give the guarantees in section 3. `withMiddleware` throws.

Rule for each driver: use a one-round-trip strategy if the driver has one. If not, and the driver has transactions, use Sequential. If it has neither, reject it.

### Postgres

| Driver | Strategy | Verified |
|---|---|---|
| node-postgres | Pipeline; with a client that is not a pool, one unit at a time for each client | Yes (tests, real Postgres) |
| neon-serverless (WebSocket) | Pipeline | Yes (spike, through Neon wsproxy) |
| Vercel Postgres | Pipeline (uses the neon-serverless client) | No |
| Netlify DB, WebSocket session | Pipeline, if its client is node-postgres compatible | No |
| postgres-js, `prepare: true` | Pipelined transaction (`unsafe(sql, params, { prepare: true })`), with a guard transaction after the COMMIT | Yes (tests, real Postgres) |
| postgres-js, `prepare: false` | Pipelined transaction, inline | Yes (tests, real Postgres) |
| Bun SQL 1.4+, `prepare: true` | Pipelined transaction (tagged-template calls; pipelined `unsafe()` calls take extra round trips) | Yes (tests, real Postgres) |
| Bun SQL, `prepare: false`, or Bun before 1.4 | Sequential. With `prepare: false` Bun does not pipeline. Bun 1.3 gave pipelined queries wrong results and hung on a failing pipelined batch. | Yes (tests, real Postgres) |
| neon-http | Batch API (`transaction([...])`, with the auth token) | No |
| Netlify DB, HTTP session | Batch API (`httpClient.transaction`) | No |
| PGlite | Local transaction | Existing e2e tests |
| AWS Data API | Sequential (its transactions) | No |
| Prisma PG | Sequential (`$transaction`) | Fake client only |
| pg-proxy | Rejected: no batching, and Drizzle's pg-proxy session throws on `transaction()` | — |
| Xata HTTP | Rejected: no batching, and Drizzle's Xata session throws on `transaction()` | — |

### SQLite

| Driver | Strategy | Verified |
|---|---|---|
| bun:sqlite, better-sqlite3 | Local transaction (sync) | Yes (the SQLite e2e suite runs for both, under Bun 1.4) |
| node:sqlite, sql.js, Durable Objects, Expo | Local transaction (sync) | No |
| Bun SQL SQLite | Local transaction, one unit at a time for each client | Yes (e2e and concurrency tests) |
| op-sqlite, Turso Database | Local transaction | No |
| libSQL | Batch API (`batch` / `tx.batch`) | Fake client only |
| Cloudflare D1 | Batch API (`batch`) | No |
| sqlite-proxy with a batch callback | Batch API (the batch callback) | No |
| sqlite-proxy without a batch callback | Sequential (`begin` … `commit`) | Yes (e2e, bun:sqlite backend) |
| SQLite Cloud | Sequential | No |
| Prisma SQLite | Sequential (`$transaction`) | Fake client only |

Note: Drizzle uses the session kind `SQLJsSession` for both sql.js and node:sqlite. Both use the same strategy. A test fails if Drizzle adds another shared kind.

Note: postgres-js retries a cached prepared statement that the server rejects as out of date (for example after `ALTER TABLE`). It writes the retry after everything already on the connection. In a pipelined unit that is after the COMMIT, so the retry would run on its own, outside the transaction and without the middleware. So with `prepare: true` the unit's flight ends with a second `BEGIN` (the guard): a retry lands in the guard transaction, and a `ROLLBACK`, written after the results arrive, discards it. The connection is released as soon as the `ROLLBACK` is written. The unit also checks COMMIT's command tag: when a statement failed, Postgres reports `ROLLBACK`, so the unit fails even when the driver hid the error. postgres-js writes at most `max_pipeline` queries at once, so a longer unit sends its COMMIT after the statements have settled. The inline path (`prepare: false`) has no cached statements, so it needs no guard.

Note: node-postgres with a `pg.Client` (or a checked-out `PoolClient`), and Bun SQL on a reserved connection (`reserved_sql`), are one connection, and Drizzle opens its transactions on it. On Bun SQL, each unit then runs on that connection itself, not on a connection that `reserve()` would take from the pool. A Bun SQL transaction handle (`transaction_sql`) as the client is rejected: a unit on it would run on another connection, outside that transaction. Work sent during an open transaction runs inside it, so another request's `before` would change the transaction's state. The package queues the client's work in the same way as for Bun SQL SQLite (below). Drizzle's own pool check covers more clients than the package's, so the queue is on whenever Drizzle shares the connection.

Note: Bun SQL SQLite has one connection, and it does not queue transactions. A `begin` while a transaction is open throws, and a query sent while a transaction is open runs in that transaction. So the package queues all work on a client from its wrapped dbs: a unit, a `transaction(fn)` scope or a query without middleware starts only when the earlier one has ended. Work inside a transaction does not wait. Queries on the unwrapped db do not go through the queue.

A driver counts as supported only when its tests run against the real driver (section 11).

## 6. Values

- **Default:** every value is a parameter. The package never puts a value into SQL text.
- **Exception:** postgres-js with `prepare: false`. The strict encoder writes each value as an `E'…'` literal:
  - The placeholders are found with a small SQL lexer that skips string literals, quoted identifiers, dollar-quoted strings and comments. In a plain string literal, a backslash escapes the next character only when `standard_conforming_strings` is off. So a quote after an odd number of backslashes ends the string in a different place with the setting on and off, and that case throws. Any other backslash ends the string in the same place either way, so it is accepted. The same lexer splits the SQL for Bun SQL's tagged calls. Every parameter must be used, and no placeholder may be out of range.
  - The literal copies postgres-js's parameter typing: booleans, bigints and bytes are cast (`::boolean`, `::int8`, `::bytea`), everything else is untyped.
  - `\` becomes `\\` and `'` becomes `''`. The literal does not depend on `standard_conforming_strings`.
  - Accepted values: string, number, bigint, boolean, null, `Uint8Array` (hex `bytea` form). Drizzle's own column encoders produce only these.
  - Anything else throws: objects, arrays, `Date` (Drizzle's postgres-js client passes dates through unchanged, so their text form is not defined), strings with NUL, symbols, functions.
  - The encoder never passes a string as the replacement argument of `String.replace` (`$$` would become `$`).
  - Known difference: an untyped `NULL` literal succeeds where an untyped `NULL` parameter fails (error 42P18). This is more permissive and does not change data.
- **Fixed cases** (`test/pg-inline.test.ts`): through a postgres-js client configured by Drizzle, an inlined value must give the same result as the parameter, with `standard_conforming_strings` on and off. In an `E'…'` literal only `'` and `\` are special, so the strings are every string of up to three characters from `'`, `\` and `a`, plus fixed strings. Numbers, bigints, booleans, bytes and null have fixed cases too.

## 7. Middleware factory

- Type: `() => { before?: SQL[]; after?: SQL[] }`.
- When both arrays are empty or missing, the query runs without middleware. The package is not only for RLS, so it does not decide whether "no statements" is correct for the caller.
- A value that is not a Drizzle `SQL` object throws.
- If the factory throws, the query does not run.
- Stacked layers call each factory once per unit.

## 8. Fail-closed rules

1. **Member guard.** The wrapped session and prepared queries expose only reviewed members. Reading any other member throws. A CI test fails when Drizzle adds a member that nobody reviewed.
2. **`$client` on a wrapped db throws.**
3. **Unknown drivers throw** (section 5).
4. **Query cache.** `withMiddleware` throws if the db has a Drizzle query cache. The cache key has no middleware context, so a cached result could reach a caller whose middleware would give a different result. There is no opt-in.
5. **Recording check.** If a Drizzle prepared query makes zero or more than one driver call while it is recorded, the unit throws.
6. **Construction check.** The wrapped db must hold the wrapped session and dialect, or `withMiddleware` throws.
7. **Batch API calls that skip the middleware** (`db.batch()` and similar) go through the unit, or they throw.

## 9. Types

- `withMiddleware(db, factory)` returns `WithMiddleware<typeof db>`.
- Exported type: `WithMiddleware<TBaseDB>` is `TBaseDB` plus `{ readonly __drizzleMiddlewareId: string }`, plus a `transaction` signature whose `tx` is also `WithMiddleware<…>` (so nested transactions are branded too).
- `WithMiddleware<TBaseDB>` stays a subtype of `TBaseDB`: a wrapped db is accepted everywhere the base db type is accepted. For this reason the type keeps `$client`, although `$client` throws at runtime (section 8).
- Use: a function that must only receive a wrapped db declares its parameter as `WithMiddleware<MyDb>`. Passing the unwrapped db is then a compile error. This also works for the `tx` inside `wrapped.transaction(fn)`.
- Runtime: each `withMiddleware` call sets a new random, read-only `__drizzleMiddlewareId`. Each stacked layer gets its own. No code reads or compares the value; it exists for the type brand.
- A type test covers: subtype of the base db; branded `tx` and nested savepoints; sync SQLite returns `T`, async drivers return `Promise<T>`; the unwrapped db is rejected.

## 10. Breaking changes from v1

- `withMiddleware` returns `WithMiddleware<TDb>`, not `TDb`.
- `$client` on a wrapped db throws.
- A db with a query cache is rejected.
- pg-proxy and Xata are rejected.
- `executeBatchTransaction` no longer rejects a mix of array-mode and object-mode queries.
- Inside `wrapped.transaction(fn)`, the transaction object is wrapped, not raw.

## 11. Tests

Each rule of section 0 has tests. The driver matrix (`test/drivers.test.ts`) runs each shared test on all 11 driver configurations.

**Rule 1: the database's transaction semantics**
- `drivers.test.ts`: savepoints on a stacked db; a savepoint that fails rolls back only its part; `before` with the first query and `after` before the commit.
- `pg.test.ts`: `wrapped.transaction` forwards the transaction config (isolation level).
- `security.test.ts`: `setTransaction()` in `wrapped.transaction` runs first.

**Rule 2: the middleware runs, or the query fails**
- `drivers.test.ts`, units: `before`, the query and `after` run in order; a failing statement rolls back the whole unit; every query API runs the middleware once; stacked layers; `executeBatchTransaction`, also with stacked layers, in `wrapped.transaction`, and with builders from a raw transaction.
- `drivers.test.ts`, transactions: a failed first query and a failed later query fail the whole transaction, even when the callback catches the error; a rolled-back savepoint does not undo `before`; a query that starts after the callback settles throws; work admitted before the end finishes inside the transaction; a kept `tx` throws.
- `concurrency.test.ts`: one request's middleware state never reaches another request, on pools and on single connections (`pg.Client`, a Bun SQL reserved connection, Bun SQL SQLite).
- `pg-drivers.test.ts`: a statement that postgres-js retries cannot run outside its unit; a transaction handle as the client is rejected; a lost connection or a value that cannot be converted leaves no stuck or broken connection.
- `e2e-sqlite.test.ts`: an async callback in a sync transaction throws.
- `guard-members.test.ts`: every Drizzle session and prepared-query member is on the allowed or the denied list; `security.test.ts`: the v1 audit findings.
- `pg.test.ts`, `sqlite.test.ts`: `withMiddleware` rejects a transaction; unknown members are blocked.

**Rule 3: one round trip**
- `pg-drivers.test.ts`: a proxy counts round trips. A wrapped query, and the first query in `wrapped.transaction`, take exactly one, on each TCP driver that can pipeline.
- `driver-plan.test.ts`: every Drizzle session kind has a planned strategy.

**Other**
- `pg-inline.test.ts`: the inline encoder, with fixed cases against Postgres.
- `internal-drizzle.test.ts`: the checks of Drizzle's internals.
- `types.test-d.ts`: the public types.

## 12. Open questions

None at the moment.
