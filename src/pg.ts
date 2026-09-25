import { entityKind } from "drizzle-orm-beta";
import type { PgAsyncDatabase } from "drizzle-orm-beta/pg-core";
import { PREPARED_ALLOWED, SESSION_ALLOWED } from "./pg-guard.js";
import {
	type Middleware,
	buildWrappedDb,
	executeBatch,
	executeBatchTransaction,
} from "./shared.js";

export type { Middleware };
export { executeBatchTransaction };

// These drivers send one statement per call and have no transactions. Running
// before, the query, and after as separate calls would not be atomic, and
// transaction-local state (`set_config(..., true)`) would not reach the query.
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

// Drizzle keeps `parseRqbJson` only on the relational query builders, as
// `parseJson`. All builders of one db share the value. Without relations there
// is no builder, and the flag has no effect.
function parseRqbJson(db: any): boolean | undefined {
	const builder = Object.values(db.query ?? {})[0] as
		| { parseJson?: boolean }
		| undefined;
	return builder?.parseJson;
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
		// Keep `parseRqbJson`, which AWS Data API sets; it changes how
		// relational results are parsed. `PostgresJsTransaction` takes no such
		// argument (postgres-js does not use it).
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
						parseRqbJson(d),
					]
			: (d, dialect, session, schemaArg) => [
					dialect,
					session,
					d._.relations,
					schemaArg,
					parseRqbJson(d),
				],
		// `PrismaPgDatabase(client, logger)` builds its own session. Run the
		// parent `PgAsyncDatabase` constructor instead.
		dbClass:
			dbKind === "PrismaPgDatabase"
				? Object.getPrototypeOf((db as any).constructor)
				: undefined,
		isTransactionInput: isTransaction,
		execBatch: executeBatch,
		wrap: withMiddleware,
		sessionMembers: SESSION_ALLOWED,
		preparedMembers: PREPARED_ALLOWED,
	}) as TDb;
}
