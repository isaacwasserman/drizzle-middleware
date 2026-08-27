---
"drizzle-middleware": patch
---

Intercept prepareRelationalQuery in v1 beta so middleware applies to db.query.*.findMany/findFirst calls.
