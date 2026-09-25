import type {
	BatchResults,
	Middleware,
	SqliteDb,
	WithMiddleware,
} from "../core/types.js";
import { withMiddlewareWith } from "../core/wrap.js";
import { SQLITE_CONFIG } from "./dialects.js";

export type { BatchResults, Middleware, WithMiddleware };
export { executeBatchTransaction } from "./pg.js";

/** Wraps a SQLite Drizzle db (or open transaction) with middleware. */
export function withMiddleware<TDb>(
	db: SqliteDb<TDb>,
	middleware: Middleware,
): WithMiddleware<TDb> {
	// The wrapped db is built at runtime from `db`'s own class: `TDb` plus the brand.
	return withMiddlewareWith(
		SQLITE_CONFIG,
		db,
		middleware,
	) as WithMiddleware<TDb>;
}
