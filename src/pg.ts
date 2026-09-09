import { entityKind } from "drizzle-orm-beta";
import type { PgAsyncDatabase } from "drizzle-orm-beta/pg-core";
import { type Middleware, buildWrappedDb, executeBatch } from "./shared.js";

export type { Middleware };

const UNSUPPORTED_DRIVERS = new Set(["XataHttpSession", "PgRemoteSession"]);

const SWAPPED_SCHEMA_RELATIONS = new Set(["PostgresJsTransaction"]);

function isPgTransaction(db: unknown): boolean {
	let proto = Object.getPrototypeOf(db);
	while (proto != null) {
		if (proto.constructor?.[entityKind] === "PgAsyncTransaction") return true;
		proto = Object.getPrototypeOf(proto);
	}
	return false;
}

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
	const isTransaction = isPgTransaction(db);
	const dbKind: string = (db as any).constructor?.[entityKind] ?? "";
	const swapped = SWAPPED_SCHEMA_RELATIONS.has(dbKind);
	return buildWrappedDb(db as any, middleware, {
		rawPrepareArgs: () => [undefined, undefined, false],
		txPrepareArgs: () => [undefined, undefined, false],
		makeDbArgs: isTransaction
			? swapped
				? (d, dialect, session, schemaArg) => [
						dialect,
						session,
						schemaArg,
						d._.relations,
						d.nestedIndex,
					]
				: (d, dialect, session, schemaArg) => [
						dialect,
						session,
						d._.relations,
						schemaArg,
						d.nestedIndex,
					]
			: (d, dialect, session, schemaArg) => [
					dialect,
					session,
					d._.relations,
					schemaArg,
				],
		isTransactionInput: isTransaction,
		execBatch: executeBatch,
	}) as TDb;
}
