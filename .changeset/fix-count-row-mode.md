---
"drizzle-middleware": patch
---

Fix PostgreSQL `$count()` returning `0` when middleware batches the query. The
middleware now preserves Drizzle's declared row mode for mapped queries, while
leaving native raw-result shapes unchanged.
