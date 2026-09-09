---
"drizzle-middleware": patch
---

Fix PostgresJsTransaction constructor argument order. This subclass swaps schema and relations parameters compared to the base PgAsyncTransaction, which broke middleware wrapping for postgres.js transaction objects.
