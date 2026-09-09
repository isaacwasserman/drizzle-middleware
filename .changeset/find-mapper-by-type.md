---
"drizzle-middleware": patch
---

Fix customResultMapper not being applied for relational queries via prepareRelationalQuery, where the mapper argument position differs from other session methods.
