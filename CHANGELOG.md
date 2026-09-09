# drizzle-middleware

## 0.2.0

### Minor Changes

- 635ef90: Consolidate the single-round-trip middleware API around the Postgres and SQLite entry points.
- b996d8a: Support transaction objects as input to withMiddleware. Before/after middleware queries execute separately from the inner query so the inner query stays within the transaction's prepared statement path.

### Patch Changes

- 13f9b67: Fix PostgresJsTransaction constructor argument order. This subclass swaps schema and relations parameters compared to the base PgAsyncTransaction, which broke middleware wrapping for postgres.js transaction objects.
- 99ca737: Fix customResultMapper not being applied for relational queries via prepareRelationalQuery, where the mapper argument position differs from other session methods.

## 0.1.0

### Minor Changes

- f7735f2: Add drizzle-orm v1 beta support with new ./beta/\* export paths.
- 675dab0: Initial release with query middleware for Postgres, MySQL, and SQLite (sync and async).

### Patch Changes

- b3bee15: Intercept prepareRelationalQuery in v1 beta so middleware applies to db.query.\*.findMany/findFirst calls.
