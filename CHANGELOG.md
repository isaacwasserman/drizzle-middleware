# drizzle-middleware

## 0.2.0

### Minor Changes

- 3333853: Rewrite the package for node-postgres only. The only entry point is `drizzle-middleware/node-postgres`. `withMiddleware(db, middleware)` accepts only a db from `drizzle-orm/node-postgres` that uses a `pg.Pool`, and throws for all other drivers and clients.

  A query outside a transaction runs as `BEGIN; before; query; after; COMMIT` in one round trip, through pg's pipeline mode. Values stay bound parameters. In `db.transaction()`, `before` goes with the first query and `after` goes with `COMMIT`, so the middleware adds no round trips.

  A db with a Drizzle query cache uses it for reads. The cache key of a read is the hash of the whole unit, so a result is used again only for the same middleware statements and values. A cache hit does not run the middleware; `withMiddleware(db, middleware, { cache: false })` turns off reads from the cache.

  `withMiddleware` also takes a transaction of such a db (for example from a test harness that rolls back). Each query then runs as `SAVEPOINT; before; query; after; RELEASE` in one round trip.

  Removed: the `pg`, `sqlite` and root entry points, SQLite and all other Postgres drivers, `executeBatchTransaction`, and middleware on a wrapped db.

## 0.1.0

### Minor Changes

- f7735f2: Add drizzle-orm v1 beta support with new ./beta/\* export paths.
- 675dab0: Initial release with query middleware for Postgres, MySQL, and SQLite (sync and async).

### Patch Changes

- b3bee15: Intercept prepareRelationalQuery in v1 beta so middleware applies to db.query.\*.findMany/findFirst calls.
