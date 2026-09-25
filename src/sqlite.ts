import { entityKind } from "drizzle-orm-beta";
import type { BaseSQLiteDatabase } from "drizzle-orm-beta/sqlite-core";
import {
	type Middleware,
	buildWrappedDb,
	executeBatch,
	executeBatchTransaction,
} from "./shared.js";
import { PREPARED_ALLOWED, SESSION_ALLOWED } from "./sqlite-guard.js";

export type { Middleware };
export { executeBatchTransaction };

// Driver transactions subclass `SQLiteTransaction` (e.g. `SQLiteBunTransaction`,
// `LibSQLTransaction`), so match on the prototype chain, not the exact kind.
function isSqliteTransaction(db: unknown): boolean {
	let proto = Object.getPrototypeOf(db);
	while (proto != null) {
		if (proto.constructor?.[entityKind] === "SQLiteTransaction") return true;
		proto = Object.getPrototypeOf(proto);
	}
	return false;
}

export function withMiddleware<
	TDb extends BaseSQLiteDatabase<any, any, any, any>,
>(db: TDb, middleware: Middleware): TDb {
	const d = db as any;
	const isTransaction = isSqliteTransaction(db);
	return buildWrappedDb(d, middleware, {
		rawPrepareArgs: () => [undefined, "all", false],
		txPrepareArgs: () => [undefined, "run", false],
		// Keep the relational-query flags that D1, Durable Objects, and the
		// proxy driver set; they change the shape of relational results.
		makeDbArgs: isTransaction
			? (d, dialect, session, schemaArg) => [
					d.resultKind,
					dialect,
					session,
					d._.relations,
					schemaArg,
					d.nestedIndex,
					d.rowModeRQB,
					d.forbidJsonb,
				]
			: (d, dialect, session, schemaArg) => [
					d.resultKind,
					dialect,
					session,
					d._.relations,
					schemaArg,
					d.rowModeRQB,
					d.forbidJsonb,
				],
		isSync: d.resultKind === "sync",
		isTransactionInput: isTransaction,
		execBatch: d.resultKind === "sync" ? undefined : executeBatch,
		wrap: withMiddleware,
		sessionMembers: SESSION_ALLOWED,
		preparedMembers: PREPARED_ALLOWED,
	}) as TDb;
}
