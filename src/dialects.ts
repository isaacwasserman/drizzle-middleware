// The Postgres and SQLite dialect configs of the v2 core.

import { PG_RULES, SQLITE_RULES } from "./core/unit.js";
import type { DialectConfig } from "./core/wrap.js";
import { driverFor } from "./drivers/registry.js";
import { entityKindOf } from "./internal/drizzle.js";
import {
	PREPARED_ALLOWED as PG_PREPARED,
	SESSION_ALLOWED as PG_SESSION,
} from "./pg-guard.js";
import {
	PREPARED_ALLOWED as SQLITE_PREPARED,
	SESSION_ALLOWED as SQLITE_SESSION,
} from "./sqlite-guard.js";

export const PG_CONFIG: DialectConfig = {
	rules: PG_RULES,
	transactionKind: "PgAsyncTransaction",
	sessionMembers: PG_SESSION,
	preparedMembers: PG_PREPARED,
	constructArgs(input, c, session, isTransaction) {
		if (!isTransaction)
			return [input.dialect, session, c.relations, c.schema, c.parseRqbJson];
		// `PostgresJsTransaction` swaps `schema` and `relations`, and takes no
		// `parseRqbJson` (postgres-js does not use it).
		if (entityKindOf(input) === "PostgresJsTransaction")
			return [input.dialect, session, c.schema, c.relations, c.nestedIndex];
		return [
			input.dialect,
			session,
			c.relations,
			c.schema,
			c.nestedIndex,
			c.parseRqbJson,
		];
	},
	driverFor: (session) => driverFor("pg", session),
};

export const SQLITE_CONFIG: DialectConfig = {
	rules: SQLITE_RULES,
	transactionKind: "SQLiteTransaction",
	sessionMembers: SQLITE_SESSION,
	preparedMembers: SQLITE_PREPARED,
	constructArgs(input, c, session, isTransaction) {
		return isTransaction
			? [
					c.resultKind,
					input.dialect,
					session,
					c.relations,
					c.schema,
					c.nestedIndex,
					c.rowModeRQB,
					c.forbidJsonb,
				]
			: [
					c.resultKind,
					input.dialect,
					session,
					c.relations,
					c.schema,
					c.rowModeRQB,
					c.forbidJsonb,
				];
	},
	driverFor: (session) => driverFor("sqlite", session),
};

export const CONFIGS: readonly DialectConfig[] = [PG_CONFIG, SQLITE_CONFIG];
