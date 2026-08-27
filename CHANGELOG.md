# drizzle-middleware

## 0.1.0

### Minor Changes

- f7735f2: Add drizzle-orm v1 beta support with new ./beta/\* export paths.
- 675dab0: Initial release with query middleware for Postgres, MySQL, and SQLite (sync and async).

### Patch Changes

- b3bee15: Intercept prepareRelationalQuery in v1 beta so middleware applies to db.query.\*.findMany/findFirst calls.
