---
"drizzle-middleware": minor
---

A wrapped db now fails closed, on Postgres and SQLite.

**Breaking:** reading `$client` on a wrapped db now throws. A query sent on the driver client does not run the middleware. Use the unwrapped db's `$client` if you need the driver.

The wrapped session and prepared queries expose only the members that are known to run the middleware. Reading any other member throws. Before this change, unknown members passed through, so a Drizzle API that calls the driver directly skipped the middleware. These APIs sent their queries without the before/after statements, and now throw:

- `db.batch()` on neon-http, Netlify DB, libSQL, and D1
- `session.migrate()` on libSQL
- direct access to the driver through the wrapped session (for example `session.client` or `session.exec()`)

Transaction fixes:

- SQLite now detects a driver transaction (for example `SQLiteBunTransaction` or `LibSQLTransaction`) as a transaction input. Before this change, only the base `SQLiteTransaction` class was detected. With libSQL, a wrapped transaction sent the middleware and the query on the main client, outside the open transaction.
- `executeBatchTransaction` with queries from a libSQL transaction now sends the batch on that transaction, not on the main client.
- For a transaction input, the before/after statements now run through Drizzle's own transaction session, so they always use the transaction's connection.
- A nested transaction (savepoint) on a wrapped transaction input is now wrapped with the same middleware, for every driver. The driver opens the savepoint on the input transaction, and each query inside it runs the middleware. Before this change, postgres-js and Bun SQL opened the savepoint on a raw session, so its queries skipped the middleware. Other drivers ran the middleware around the `SAVEPOINT` and `RELEASE` statements too.
- Stacked middleware on a transaction input (`withMiddleware(withMiddleware(tx, a), b)`) no longer runs the inner layer's before/after more than once.
- A wrapped SQLite db keeps the relational-query flags (`rowModeRQB`, `forbidJsonb`) that D1, Durable Objects, and the proxy driver set.

Other fixes:

- A wrapped Postgres db keeps `parseRqbJson`, which AWS Data API sets. Before this change, the wrapped db dropped it, so relational results could come back unparsed.
- The SQLite proxy driver (`sqlite-proxy`) is now supported. It sends one statement per callback call, so the middleware runs before, the query, and after one at a time inside Drizzle's own proxy transaction (`begin` … `commit`). pg-proxy and Xata stay rejected: they have no batch and no transactions, so separate calls would not be atomic, and transaction-local state would not reach the query.
- Prisma (PG and SQLite) is now supported. Prisma runs one statement per call, and Drizzle's Prisma sessions have no transactions. So the middleware opens a Prisma interactive transaction and runs before, the query, and after one at a time in it. `executeBatchTransaction` does the same. Before this change, Prisma SQLite was rejected, and a wrapped Prisma PG db was built with the wrong constructor arguments and did not work.
- `withMiddleware` throws if the rebuilt db does not hold the wrapped session and dialect (for example, a db class with its own constructor). Before this change, such a db was silently built without the middleware.
