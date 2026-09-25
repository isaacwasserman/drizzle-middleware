// Public types of the package.

import type { SQL } from "drizzle-orm-beta";
import type { PgAsyncDatabase } from "drizzle-orm-beta/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm-beta/sqlite-core";

/** The statements a middleware factory returns for one unit. */
export interface MiddlewareStatements {
	readonly before?: readonly SQL[] | undefined;
	readonly after?: readonly SQL[] | undefined;
}

/**
 * Called for each unit (a query, a batch, or a transaction). When both arrays
 * are empty or missing, the unit runs without middleware.
 */
export type Middleware = () => MiddlewareStatements;

/**
 * `T` if it is an async Postgres Drizzle db or transaction, else `never`.
 * Drizzle's type parameters are invariant, so a constraint with wide type
 * arguments would reject real dbs. Matching with `infer` accepts every
 * instantiation.
 */
export type PgDb<T> = T extends PgAsyncDatabase<
	infer _Result,
	infer _FullSchema,
	infer _Relations,
	infer _Schema
>
	? T
	: never;

/** `T` if it is a SQLite Drizzle db or transaction (sync or async), else `never`. */
export type SqliteDb<T> = T extends BaseSQLiteDatabase<
	infer _Kind,
	infer _RunResult,
	infer _FullSchema,
	infer _Relations,
	infer _Schema
>
	? T
	: never;

interface MiddlewareBrand {
	readonly __drizzleMiddlewareId: string;
}

/** The transaction type that `TDb`'s `transaction` callback receives. */
type TransactionOf<TDb> = TDb extends {
	transaction(fn: (tx: infer Tx) => never, ...rest: never[]): unknown;
}
	? Tx
	: never;

/**
 * A `transaction` signature whose `tx` is also branded. It comes first in the
 * intersection below, so a call to `transaction` picks it. The db's own
 * signature stays, so `WithMiddleware<TDb>` is still a subtype of `TDb`. The
 * return type follows the db's own: `T` for sync SQLite, `Promise` otherwise.
 */
type BrandedTransaction<TDb> = TDb extends {
	transaction(fn: never, ...rest: infer Rest): infer Returned;
}
	? {
			transaction<T>(
				fn: (tx: WithMiddleware<TransactionOf<TDb>>) => T,
				...rest: Rest
			): Returned extends PromiseLike<unknown> ? Promise<Awaited<T>> : T;
		}
	: unknown;

/**
 * A db returned by `withMiddleware`. It is a subtype of `TBaseDB`, so it is
 * accepted everywhere `TBaseDB` is. Declare a parameter as
 * `WithMiddleware<MyDb>` to require a wrapped db at compile time.
 */
export type WithMiddleware<TBaseDB> = BrandedTransaction<TBaseDB> &
	TBaseDB &
	MiddlewareBrand;

/** The results of `executeBatchTransaction`, one per query, in order. */
export type BatchResults<T extends readonly PromiseLike<unknown>[]> = {
	-readonly [K in keyof T]: Awaited<T[K]>;
};
