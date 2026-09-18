---
"drizzle-middleware": minor
---

Add `executeBatchTransaction`, a standalone helper that runs an array of Drizzle queries in a single round trip and returns a typed result tuple. The middleware, nested (composed) middleware, and this helper now share one execution envelope, so every middleware layer's before/after is applied around the batch and never bypassed.

Also fixes a result-mapping bug in the batched path: a query selecting two columns with the same SQL label (for example a join where both tables expose `id`) dropped a column, because rows were mapped positionally from object-mode results. Field-based queries now request the driver's native array-mode rows; relational and raw queries keep object rows.
