import { entityKind } from "drizzle-orm-beta";
import type { PgAsyncDatabase } from "drizzle-orm-beta/pg-core";
import { type Middleware, buildWrappedDb, executeBatch } from "./shared.js";

export type { Middleware };

const UNSUPPORTED_DRIVERS = new Set(["XataHttpSession", "PgRemoteSession"]);

export function withMiddleware<TDb extends PgAsyncDatabase<any, any, any, any>>(
	db: TDb,
	middleware: Middleware,
): TDb {
	const kind: string = (db as any).session?.constructor?.[entityKind] ?? "";
	if (UNSUPPORTED_DRIVERS.has(kind)) {
		throw new Error(
			`withMiddleware is not compatible with ${kind}. This driver has no multi-statement, batch, or transaction support.`,
		);
	}
	return buildWrappedDb(db as any, middleware, {
		rawPrepareArgs: () => [undefined, undefined, false],
		txPrepareArgs: () => [undefined, undefined, false],
		makeDbArgs: (d, dialect, session, schemaArg) => [
			dialect,
			session,
			d._.relations,
			schemaArg,
		],
		execBatch: executeBatch,
	}) as TDb;
}
