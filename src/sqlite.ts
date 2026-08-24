import type {
	BaseSQLiteDatabase,
	SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import { buildWrappedDb } from "./shared.js";

export type Middleware = (
	next: () => Promise<unknown>,
	tx: SQLiteTransaction<"async", any, any, any>,
) => Promise<unknown>;

export type SyncMiddleware = (
	next: () => unknown,
	tx: SQLiteTransaction<"sync", any, any, any>,
) => unknown;

export function withMiddleware<
	TDb extends BaseSQLiteDatabase<"async", any, any, any>,
>(db: TDb, middleware: Middleware): TDb;
export function withMiddleware<
	TDb extends BaseSQLiteDatabase<"sync", any, any, any>,
>(db: TDb, middleware: SyncMiddleware): TDb;
export function withMiddleware(db: any, middleware: any): any {
	return buildWrappedDb(db, middleware, (d, session, schema) => [
		d.resultKind,
		d.dialect,
		session,
		schema,
	]);
}
