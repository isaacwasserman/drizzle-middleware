import type {
	BatchResults,
	Middleware,
	PgDb,
	WithMiddleware,
} from "./core/types.js";
import {
	executeBatchTransactionWith,
	withMiddlewareWith,
} from "./core/wrap.js";
import { CONFIGS, PG_CONFIG } from "./dialects.js";

export type { BatchResults, Middleware, WithMiddleware };

/** Wraps a Postgres Drizzle db with middleware. A transaction throws. */
export function withMiddleware<TDb>(
	db: PgDb<TDb>,
	middleware: Middleware,
): WithMiddleware<TDb> {
	// The wrapped db is built at runtime from `db`'s own class: `TDb` plus the brand.
	return withMiddlewareWith(PG_CONFIG, db, middleware) as WithMiddleware<TDb>;
}

/** Runs the queries (and the middleware, if any) as one unit. */
export function executeBatchTransaction<
	const T extends readonly PromiseLike<unknown>[],
>(queries: readonly [...T]): Promise<BatchResults<T>> {
	// One result per query, in order, as Drizzle maps it.
	return executeBatchTransactionWith(CONFIGS, queries) as Promise<
		BatchResults<T>
	>;
}
