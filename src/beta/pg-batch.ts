import { entityKind } from "drizzle-orm-beta";
import type { PgAsyncDatabase } from "drizzle-orm-beta/pg-core";
import { type BatchMiddleware, buildBatchWrappedDb } from "../shared-batch.js";

export type { BatchMiddleware };

// ---------------------------------------------------------------------------
// Example: RLS via set_config
//
//   const db = withBatchMiddleware(baseDb, () => ({
//     before: [
//       sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
//       sql`SELECT set_config('app.user_role', ${role}, true)`,
//     ],
//     after: [
//       sql`SELECT set_config('app.tenant_id', '', true)`,
//     ],
//   }));
//
//   await db.select().from(users).where(eq(users.id, 42));
//
// Standalone query — runs inside PostgreSQL's implicit transaction for a
// multi-statement Simple Query message. All params are inlined, all statements
// are concatenated, and the message takes one round trip:
//
//   SELECT set_config('app.tenant_id', 'abc', true);
//   SELECT set_config('app.user_role', 'admin', true);
//   SELECT "id", "name" FROM "users" WHERE "id" = 42;
//   SELECT set_config('app.tenant_id', '', true)            -- one message
//
// User-managed transaction — the callback can't be stringified,
// so before/after queries execute individually on the tx session:
//
//   await db.transaction(async (tx) => {
//     await tx.select().from(users);
//     await tx.insert(logs).values({ action: 'read' });
//   });
//
//   BEGIN
//   SELECT set_config('app.tenant_id', 'abc', true)     -- before[0]
//   SELECT set_config('app.user_role', 'admin', true)    -- before[1]
//   SELECT "id", "name" FROM "users"                     -- user query 1
//   INSERT INTO "logs" ("action") VALUES ($1)             -- user query 2
//   SELECT set_config('app.tenant_id', '', true)          -- after[0]
//   COMMIT
// ---------------------------------------------------------------------------

export const PG_DRIVER_KINDS = [
	"NodePgSession",
	"NeonSession",
	"VercelPgSession",
	"NetlifyDbSession",
	"NetlifyDbWsSession",
	"PgliteSession",
	"PostgresJsSession",
	"EffectPgSession",
	"NeonHttpSession",
	"XataHttpSession",
	"PgRemoteSession",
] as const;

function extractInnerResult(
	rawResult: any,
	beforeCount: number,
	session: any,
): any {
	if (beforeCount === 0) return rawResult;

	const kind: string = session.constructor?.[entityKind] ?? "";

	switch (kind) {
		case "NodePgSession":
		case "NeonSession":
		case "VercelPgSession":
		case "NetlifyDbWsSession": {
			if (Array.isArray(rawResult)) return rawResult[beforeCount];
			return rawResult;
		}
		case "PostgresJsSession":
		case "EffectPgSession": {
			if (Array.isArray(rawResult) && (rawResult as any).statement != null) {
				return rawResult;
			}
			if (Array.isArray(rawResult) && Array.isArray(rawResult[0])) {
				return rawResult[beforeCount];
			}
			return rawResult;
		}
		case "PgliteSession": {
			if (Array.isArray(rawResult) && rawResult[0]?.rows !== undefined) {
				return rawResult[beforeCount];
			}
			return rawResult;
		}
		case "NeonHttpSession":
		case "XataHttpSession":
		case "PgRemoteSession":
		case "NetlifyDbSession":
			return rawResult;
		default: {
			if (Array.isArray(rawResult) && rawResult[0]?.rows !== undefined) {
				return rawResult[beforeCount];
			}
			return rawResult;
		}
	}
}

export function withBatchMiddleware<
	TDb extends PgAsyncDatabase<any, any, any, any>,
>(db: TDb, middleware: BatchMiddleware): TDb {
	return buildBatchWrappedDb(db as any, middleware, {
		extractInnerResult,
		rawPrepareArgs: () => [undefined, undefined, false],
		txPrepareArgs: () => [undefined, undefined, false],
		makeDbArgs: (d, dialect, session, schemaArg) => [
			dialect,
			session,
			d._.relations,
			schemaArg,
		],
	}) as TDb;
}
