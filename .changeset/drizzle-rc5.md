---
"drizzle-middleware": minor
---

Support drizzle-orm 1.0.0-rc.5, which is now the lowest supported version. The package builds sessions and transactions with the rc.5 constructor arguments, and gives its own classes their own entity kind, because rc.5 matches `instanceof` by entity kind. Relational queries now use the query cache, keyed on the whole unit, when the cache strategy is `all`.
