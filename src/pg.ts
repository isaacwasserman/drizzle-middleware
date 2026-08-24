import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import { buildWrappedDb } from "./shared.js";

export type Middleware = (
	next: () => Promise<unknown>,
	tx: PgTransaction<any, any, any>,
) => Promise<unknown>;

export function withMiddleware<TDb extends PgDatabase<any, any, any>>(
	db: TDb,
	middleware: Middleware,
): TDb {
	return buildWrappedDb(db, middleware, (d, session, schema) => [
		d.dialect,
		session,
		schema,
	]) as TDb;
}
