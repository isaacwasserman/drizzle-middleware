---
"drizzle-middleware": minor
---

Support transaction objects as input to withMiddleware. Before/after middleware queries execute separately from the inner query so the inner query stays within the transaction's prepared statement path.
