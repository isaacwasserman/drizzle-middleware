---
"drizzle-middleware": minor
---

Add batch query middleware for PG and SQLite (beta). `withBatchMiddleware` accepts arrays of SQL queries to run before/after the inner query, stringifies them with inlined params, and executes them in a single round-trip.
