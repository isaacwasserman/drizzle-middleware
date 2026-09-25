# drizzle-middleware v2: design and semantics

Status: draft for review. Nothing here is implemented yet.

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
| `wrapped.transaction(fn)` | `before` is sent with the first query in the transaction. `after` is sent as one batch before the commit. The factory is called once for the transaction. |
| A query on `withMiddleware(tx)` (an open transaction) | `before`, the query, `after`, inside that transaction. There is no new transaction; atomicity comes from the outer one. |
| A nested transaction (savepoint) on a wrapped transaction | Same rules as its parent. The savepoint is opened by the driver on the unwrapped transaction. |

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
| node-postgres | Pipeline | Yes (tests, real Postgres) |
| neon-serverless (WebSocket) | Pipeline | Yes (spike, through Neon wsproxy) |
| Vercel Postgres | Pipeline (uses the neon-serverless client) | No |
| Netlify DB, WebSocket session | Pipeline, if its client is node-postgres compatible | No |
| postgres-js, `prepare: true` | Pipelined transaction (`unsafe(sql, params, { prepare: true })`) | Yes (tests, real Postgres) |
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

Note: Drizzle uses the session kind `SQLJsSession` for both sql.js and node:sqlite. Both use the same strategy. A test fails if Drizzle adds another shared kind.
| op-sqlite, Turso Database, Bun SQL SQLite | Local transaction | No |
| libSQL | Batch API (`batch` / `tx.batch`) | Fake client only |
| Cloudflare D1 | Batch API (`batch`) | No |
| sqlite-proxy with a batch callback | Batch API (the batch callback) | No |
| sqlite-proxy without a batch callback | Sequential (`begin` … `commit`) | Yes (e2e, bun:sqlite backend) |
| SQLite Cloud | Sequential | No |
| Prisma SQLite | Sequential (`$transaction`) | Fake client only |

A driver counts as supported only when its tests run against the real driver (section 11).

## 6. Values

- **Default:** every value is a parameter. The package never puts a value into SQL text.
- **Exception:** postgres-js with `prepare: false`. The strict encoder writes each value as an `E'…'` literal:
  - The placeholders are found with a small SQL lexer that skips string literals, quoted identifiers, dollar-quoted strings and comments. A backslash in a plain string literal throws, because its meaning depends on `standard_conforming_strings`. Every parameter must be used, and no placeholder may be out of range.
  - The literal copies postgres-js's parameter typing: booleans, bigints and bytes are cast (`::boolean`, `::int8`, `::bytea`), everything else is untyped.
  - `\` becomes `\\` and `'` becomes `''`. The literal does not depend on `standard_conforming_strings`.
  - Accepted values: string, number, bigint, boolean, null, `Uint8Array` (hex `bytea` form). Drizzle's own column encoders produce only these.
  - Anything else throws: objects, arrays, `Date` (Drizzle's postgres-js client passes dates through unchanged, so their text form is not defined), strings with NUL, symbols, functions.
  - The encoder never passes a string as the replacement argument of `String.replace` (`$$` would become `$`).
  - Known difference: an untyped `NULL` literal succeeds where an untyped `NULL` parameter fails (error 42P18). This is more permissive and does not change data.
- **Fuzz test** (`test/pg-inline.test.ts`): through a postgres-js client configured by Drizzle, an inlined value must give the same result as the parameter, for random strings, bytes, numbers, bigints and booleans, with `standard_conforming_strings` on and off.

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

1. **Real-driver tests** for each driver entry, against the real driver: Postgres in CI (service container) for node-postgres, postgres-js and Bun SQL; the Neon wsproxy container for neon-serverless; local libSQL; PGlite; bun:sqlite; Bun SQL SQLite. Each checks the guarantees in section 3 and the round-trip count (through a latency proxy).
2. **Security regression suite.** Each audit finding becomes a test:
   - replay of a previous query after `toSQL()` or a batch;
   - SQL injection with `standard_conforming_strings = off`;
   - a db with a query cache is rejected;
   - neon-http auth token dropped;
   - errors swallowed on Bun SQL SQLite;
   - `bytea`, blob, `NaN` and `Date` values;
   - `db.batch()` and `session.migrate()` skipping the middleware.
3. **Member review** (kept from v1).
4. **Encoder fuzz test** (section 6).
5. **The v1 tests**, copied (e2e) or rewritten as behavior tests (unit), in `test/`. `test/MAPPING.md` accounts for every v1 test. All tests run against v2; tests for a driver without a registry entry are `test.todo` until the entry lands.

## 12. Open questions

None at the moment.
