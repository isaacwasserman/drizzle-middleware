import { entityKind } from "drizzle-orm-beta";
import type { BaseSQLiteDatabase } from "drizzle-orm-beta/sqlite-core";
import { type BatchMiddleware, buildBatchWrappedDb } from "../shared-batch.js";

export type { BatchMiddleware };

export const SQLITE_DRIVER_KINDS = [
	"SQLiteBunSession",
	"BetterSQLiteSession",
	"SQLJsSession",
	"SQLiteDOSession",
	"ExpoSQLiteSession",
	"OPSQLiteSession",
	"LibSQLSession",
	"SQLiteD1Session",
	"SQLiteRemoteSession",
	"SQLiteCloudSession",
	"TursoDatabaseSession",
	"BunSQLiteSession",
	"PrismaSQLiteSession",
] as const;

function extractInnerResult(
	rawResult: any,
	beforeCount: number,
	afterCount: number,
	session: any,
): any {
	if (beforeCount === 0 && afterCount === 0) return rawResult;

	const kind: string = session.constructor?.[entityKind] ?? "";

	switch (kind) {
		// Sync drivers: most SQLite engines only process the first
		// statement from a prepared query, so multi-statement
		// extraction is best-effort.
		case "SQLiteBunSession":
		case "BetterSQLiteSession":
		case "SQLJsSession":
		case "SQLiteDOSession":
		case "ExpoSQLiteSession":
		case "OPSQLiteSession":
			return rawResult;

		// Async drivers: result format varies.
		case "LibSQLSession":
		case "SQLiteD1Session":
		case "SQLiteCloudSession":
		case "TursoDatabaseSession":
		case "SQLiteRemoteSession":
		case "PrismaSQLiteSession": {
			if (Array.isArray(rawResult) && rawResult.length > beforeCount) {
				return rawResult[beforeCount];
			}
			return rawResult;
		}

		// bun-sql/sqlite uses postgres.js-style API
		case "BunSQLiteSession": {
			if (Array.isArray(rawResult) && Array.isArray(rawResult[0])) {
				return rawResult[beforeCount];
			}
			return rawResult;
		}

		default: {
			if (Array.isArray(rawResult) && rawResult.length > beforeCount) {
				return rawResult[beforeCount];
			}
			return rawResult;
		}
	}
}

export function withBatchMiddleware<
	TDb extends BaseSQLiteDatabase<any, any, any, any>,
>(db: TDb, middleware: BatchMiddleware): TDb {
	const d = db as any;
	return buildBatchWrappedDb(d, middleware, {
		extractInnerResult,
		rawPrepareArgs: () => [undefined, "all", false],
		txPrepareArgs: () => [undefined, "run", false],
		makeDbArgs: (d, dialect, session, schemaArg) => [
			d.resultKind,
			dialect,
			session,
			d._.relations,
			schemaArg,
		],
		isSync: d.resultKind === "sync",
	}) as TDb;
}
