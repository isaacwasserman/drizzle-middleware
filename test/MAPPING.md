# Where each v1 test went

The v1 tests were copied or rewritten for v2. This file accounts for every one
of them. All tests in `test/` run against v2 (`src/v2/`).

- **Drivers without a registry entry yet:** their tests are `test.todo` (see
  `helpers/drivers.ts`). They become normal tests when the driver's entry lands.
- **Error messages:** tests check stable fragments only: the driver kind,
  `not compatible with`, `blocked access to \`<member>\``, `cannot wrap`.
- **Real drivers:** `pg-drivers.test.ts` runs only when `TEST_PG_URL` is set.

## Files

| File | Content |
|---|---|
| `e2e-pg.test.ts`, `e2e-sqlite.test.ts`, `e2e-batched.test.ts` | The v1 e2e suites, copied. Only the imports changed. |
| `pg.test.ts`, `sqlite.test.ts` | The applicable v1 unit tests, rewritten to check behavior on registered drivers. |
| `pg-drivers.test.ts` | node-postgres, postgres-js (`prepare: true` / `false`) and Bun SQL against a real Postgres. |
| `security.test.ts` | The v1 audit findings. |
| `guard-members.test.ts` | The review of the guard member lists (from the v1 unit tests). |
| `driver-plan.test.ts`, `internal-drizzle.test.ts`, `types.test-d.ts` | v2 only: the driver plan, the Drizzle boundary, the types. |

## e2e suites (47 tests): copied

All tests in `e2e-pg.test.ts` (21), `e2e-sqlite.test.ts` (18) and
`e2e-batched.test.ts` (8) are copied with the same names.

## pg.test.ts (55 tests)

| v1 test | Now in |
|---|---|
| returns a new db instance | `pg`: same name |
| blocks $client and preserves $cache | `pg`: blocks $client. The `$cache` check is dropped: v2 rejects a db with a cache. |
| keeps parseRqbJson of the input db and transaction | `pg`: same name |
| Prisma PG: runs each statement in order in a Prisma transaction | `pg`: same name |
| Prisma PG: stacked layers run in onion order | `pg`: same name |
| Prisma PG: a failed statement rolls back the whole envelope | `pg`: …rolls back the whole unit |
| Prisma PG: no middleware runs the query directly | `pg`: same name |
| Prisma PG: executeBatchTransaction runs in a Prisma transaction | `pg`: same name |
| rejects pg-proxy and Xata (no batch and no transactions) | `pg`: same name |
| fails closed for a db class with its own constructor | `pg`: same name |
| fast path: no before/after skips transaction | `pg`: no middleware: the query runs directly, without a transaction |
| before + inner are concatenated into one statement | Not applicable (v1 internal). Intent: `pg-drivers` order and one-round-trip tests. |
| inner + after are concatenated into one statement | Not applicable (v1 internal). Intent: as above. |
| before + inner + after all in one statement, correct order | Not applicable (v1 internal). Intent: `pg-drivers`: before, the query, and after run in order. |
| before query params are inlined | Not applicable (v2 keeps values as parameters). Intent: `pg`: query values reach the database unchanged; `security`. |
| inlineSql does not leak shouldInlineParams onto middleware SQL | `pg`: middleware SQL objects can be reused unchanged |
| inner query params are inlined via dialect capture | `pg`: query values reach the database unchanged |
| setToken is forwarded to the batched prepared query | `pg`: neon-http: the auth token reaches the driver  |
| joinsNotNullableMap is copied to the batched prepared query | `pg`: a left join without a match maps the joined table to null |
| placeholder values are resolved and inlined into concatenated query | `pg`: a prepared query with placeholders runs with each set of values |
| placeholder query uses single round trip, not tx fallback | `pg-drivers`: a wrapped query with middleware takes one round trip |
| user-managed transaction: before/after run individually at boundaries | `e2e-pg`: user transaction: before/after run at boundaries |
| transaction config is forwarded | `pg`: wrapped.transaction forwards the transaction config |
| prepareRelationalQuery is also wrapped | `e2e-pg`: every supported query API still runs the middleware; `pg-drivers`: a relational query runs the middleware |
| allowed session members pass through | Not applicable (v1 guard internals). The member-review test checks the lists. |
| unknown session members are blocked | `e2e-pg`: blocks direct driver access through the wrapped session |
| unknown prepared-query members are blocked | `pg`: same name |
| NeonHttpSession.batch is blocked (it skips the middleware) | `pg`: same name |
| customResultMapper is applied to the extracted inner result | `e2e-pg`: $count uses positional rows and still runs middleware |
| custom positional mappers request postgres-js array mode | `pg-drivers`: $count returns the count (positional rows) |
| unmapped queries preserve postgres-js native object results | `pg-drivers`: raw execute returns the same rows as the unwrapped db |
| customResultMapper is applied for relational queries | `e2e-pg`: every supported query API still runs the middleware |
| result is returned unmodified when no fields/mapper | `pg`: raw execute returns the same result as the unwrapped db |
| object-mode rows are mapped to selected fields | `e2e-pg`: select returns correctly typed rows |
| after-only: inner result is extracted from multi-statement response | `pg`: after-only middleware returns the query's result |
| standalone: 3 before + inner = 1 execute and no explicit tx | Not applicable (v1 internal count). Intent: `pg-drivers` one round trip. |
| standalone: inner + 3 after = 1 execute and no explicit tx | As above. |
| standalone: 3 before + inner + 3 after = 1 execute and no explicit tx | As above. |
| user tx: 3 before queries = 3 prepareQuery calls (no concatenation) | Not applicable (v1 internal; v2 sends `before` with the first query). |
| tx input: before + inner execute separately, correct order | `pg`: tx input: before and after run around each query, in order, in that transaction |
| tx input: inner + after execute separately, correct order | As above. |
| tx input: before + inner + after, all separate, correct order | As above. |
| tx input: no before/after uses fast path | `pg`: tx input: no middleware: the query runs directly |
| tx input: does not concatenate before+inner into one statement | Not applicable (v1 internal). |
| tx input: multiple before queries each get their own execute | `pg`: tx input order test (two `before` statements) |
| tx input: result comes from the inner query, not before/after | `pg`: tx input: the result is the query's, not the middleware's |
| tx input: no explicit tx opened (no tx:begin) | `pg`: tx input: no new transaction is opened |
| PostgresJsTransaction: nested transaction (savepoint) runs the middleware | `pg-drivers` (postgres-js): a nested transaction on a wrapped open transaction runs the middleware |
| PostgresJsTransaction: detected as transaction input | `pg-drivers` (postgres-js): a wrapped open transaction runs before and after around each query, in it |
| PostgresJsTransaction: before + inner execute separately | As above. |
| PostgresJsTransaction: before + inner + after, correct order | As above. |
| PostgresJsTransaction: no explicit tx opened (no tx:begin) | As above (the outer rollback removes everything). |
| PostgresJsTransaction: relational query also works | As above (the test runs `findMany`). |
| covers every PG session in drizzle-orm-beta | `driver-plan` |
| every Drizzle PG session and prepared-query member is reviewed | `guard-members`: same name (for Postgres) |

## sqlite.test.ts (23 tests)

| v1 test | Now in |
|---|---|
| returns a new db instance | `sqlite`: same name |
| blocks $client and preserves $cache | `sqlite`: blocks $client (the `$cache` check is dropped, as for pg) |
| fast path: no before/after skips transaction | `sqlite`: no middleware: the query runs directly, without a transaction |
| before + inner concatenated into one statement | Not applicable (v1 internal). |
| params use ? syntax (SQLite), not $N (PG) | Not applicable (v1 inlining). Intent: `sqlite`: libSQL: values reach the driver as arguments . |
| inner query params are inlined via dialect capture | `sqlite`: libSQL: each execution of a prepared query uses its own values |
| standalone: 3 before + inner + 3 after = 1 prepareQuery call | Not applicable (v1 internal count). |
| user tx: before/after run individually | `e2e-sqlite`: user transaction: before/after run at boundaries |
| customResultMapper is applied to the extracted result | `sqlite`: $count runs the middleware and returns the count |
| driver transactions (subclasses) are detected as tx input | `sqlite`: libSQL: a wrapped transaction runs every statement on it, in order |
| libSQL: nested transaction on a wrapped transaction runs the middleware | `sqlite`: same intent |
| Prisma SQLite: runs each statement in order in a Prisma transaction | `sqlite`: same name |
| executeBatchTransaction on a libSQL transaction uses the transaction | `sqlite`: same intent |
| keeps the relational-query flags of the input db | `sqlite`: …of the input db and transaction |
| sync tx input: stacked layers each run once | `e2e-sqlite`: stacked middleware on a transaction runs each layer once |
| allowed session members pass through | Not applicable (v1 guard internals). |
| unknown session members are blocked | `e2e-sqlite`: blocks direct driver access through the wrapped session |
| unknown prepared-query members are blocked | `sqlite`: same name |
| LibSQLSession.batch and migrate are blocked | `sqlite`: libSQL: batch and migrate are blocked |
| placeholder values are resolved and inlined into concatenated query | `sqlite`: libSQL: each execution of a prepared query uses its own values |
| after-only: inner result is extracted from multi-statement response | `sqlite`: libSQL: after-only middleware returns the query's rows |
| covers every SQLite session in drizzle-orm-beta | `driver-plan` |
| every Drizzle SQLite session and prepared-query member is reviewed | `guard-members`: same name (for SQLite) |

## New tests (not in v1)

- `security.test.ts`: every audit finding.
- `pg-drivers.test.ts`: the whole file (real drivers, including injection,
  `bytea`, result order, transaction-local state, and one round trip).
- `sqlite.test.ts`: libSQL raw `all()` result, values as arguments, no replay
  after another query; a wrapped open bun:sqlite transaction.

## v1 bugs found while writing these tests

These were not in the audit:

- libSQL: raw `db.all(sql)` returns the libSQL result set instead of its rows.
- postgres-js: `.values()` on a multi-statement query drops the results of
  statements that return no rows, so v1's result-by-position slicing crashes
  when a `before` statement that returns rows comes before one that returns
  none.
