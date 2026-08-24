import type { MySqlDatabase, MySqlTransaction } from "drizzle-orm/mysql-core";
import { buildWrappedDb } from "./shared.js";

export type Middleware = (
	next: () => Promise<unknown>,
	tx: MySqlTransaction<any, any, any, any>,
) => Promise<unknown>;

export function withMiddleware<TDb extends MySqlDatabase<any, any, any, any>>(
	db: TDb,
	middleware: Middleware,
): TDb {
	return buildWrappedDb(db, middleware, (d, session, schema) => [
		d.dialect,
		session,
		schema,
		d.mode,
	]) as TDb;
}
