import type {
	PgAsyncDatabase,
	PgAsyncTransaction,
} from "drizzle-orm-beta/pg-core";
import { buildWrappedDb } from "../shared.js";

export type Middleware = (
	next: () => Promise<unknown>,
	tx: PgAsyncTransaction<any, any, any, any>,
) => Promise<unknown>;

export function withMiddleware<TDb extends PgAsyncDatabase<any, any, any, any>>(
	db: TDb,
	middleware: Middleware,
): TDb {
	return buildWrappedDb(db, middleware, (d, session, schema) => [
		d.dialect,
		session,
		d._.relations,
		schema,
	]) as TDb;
}
