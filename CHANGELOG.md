# drizzle-middleware

## 0.2.0

### Minor Changes

- deee724: Add `executeBatchTransaction`, a standalone helper that runs an array of Drizzle queries in a single round trip and returns a typed result tuple. The middleware, nested (composed) middleware, and this helper now share one execution envelope, so every middleware layer's before/after is applied around the batch and never bypassed.

  Also fixes a result-mapping bug in the batched path: a query selecting two columns with the same SQL label (for example a join where both tables expose `id`) dropped a column, because rows were mapped positionally from object-mode results. Field-based queries now request the driver's native array-mode rows; relational and raw queries keep object rows.

- 635ef90: Consolidate the single-round-trip middleware API around the Postgres and SQLite entry points.
- b996d8a: Support transaction objects as input to withMiddleware. Before/after middleware queries execute separately from the inner query so the inner query stays within the transaction's prepared statement path.

### Patch Changes

- 13f9b67: Fix PostgresJsTransaction constructor argument order. This subclass swaps schema and relations parameters compared to the base PgAsyncTransaction, which broke middleware wrapping for postgres.js transaction objects.
- 99ca737: Fix customResultMapper not being applied for relational queries via prepareRelationalQuery, where the mapper argument position differs from other session methods.
- 3ff042a: Fix PostgreSQL `$count()` returning `0` when middleware batches the query. The
  middleware now preserves Drizzle's declared row mode for mapped queries, while
  leaving native raw-result shapes unchanged.

## 0.1.0

### Minor Changes

- f7735f2: Add drizzle-orm v1 beta support with new ./beta/\* export paths.
- 675dab0: Initial release with query middleware for Postgres, MySQL, and SQLite (sync and async).

### Patch Changes

- b3bee15: Intercept prepareRelationalQuery in v1 beta so middleware applies to db.query.\*.findMany/findFirst calls.
