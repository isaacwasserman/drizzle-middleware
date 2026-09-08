import { entityKind } from "drizzle-orm-beta";
import type { BaseSQLiteDatabase } from "drizzle-orm-beta/sqlite-core";
import { type Middleware, buildWrappedDb, executeBatch } from "./shared.js";

export type { Middleware };

const UNSUPPORTED_DRIVERS = new Set([
	"SQLiteRemoteSession",
	"PrismaSQLiteSession",
]);

export function withMiddleware<
	TDb extends BaseSQLiteDatabase<any, any, any, any>,
>(db: TDb, middleware: Middleware): TDb {
	const d = db as any;
	const kind: string = d.session?.constructor?.[entityKind] ?? "";
	if (UNSUPPORTED_DRIVERS.has(kind)) {
		throw new Error(
			`withMiddleware is not compatible with ${kind}. This driver has no multi-statement, batch, or transaction support.`,
		);
	}
	const isTransaction = d.constructor?.[entityKind] === "SQLiteTransaction";
	return buildWrappedDb(d, middleware, {
		rawPrepareArgs: () => [undefined, "all", false],
		txPrepareArgs: () => [undefined, "run", false],
		makeDbArgs: isTransaction
			? (d, dialect, session, schemaArg) => [
					d.resultKind,
					dialect,
					session,
					d._.relations,
					schemaArg,
					d.nestedIndex,
				]
			: (d, dialect, session, schemaArg) => [
					d.resultKind,
					dialect,
					session,
					d._.relations,
					schemaArg,
				],
		isSync: d.resultKind === "sync",
		isTransactionInput: isTransaction,
		execBatch: d.resultKind === "sync" ? undefined : executeBatch,
	}) as TDb;
}
