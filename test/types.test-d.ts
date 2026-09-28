// Type tests. `tsc -p tsconfig.strict.json` checks this file; nothing runs it.
// Each `@ts-expect-error` must stay an error, or the check fails.

import type { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm-beta";
import type { SQLiteBunDatabase } from "drizzle-orm-beta/bun-sqlite";
import type { LibSQLDatabase } from "drizzle-orm-beta/libsql";
import type {
	PgAsyncTransaction,
	PgQueryResultHKT,
} from "drizzle-orm-beta/pg-core";
import type { PgliteDatabase } from "drizzle-orm-beta/pglite";
import {
	type BatchDriverSpec,
	type Driver,
	assertNever,
	batchDriver,
} from "../src/core/driver.ts";
import type {
	BatchResults,
	Middleware,
	PgDb,
	SqliteDb,
	WithMiddleware,
} from "../src/core/types.ts";
import type { DrizzleSession } from "../src/internal/drizzle.ts";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_value?: T): void {}

type Pg = PgliteDatabase & { $client: PGlite };
declare const pg: Pg;
declare const pgWrapped: WithMiddleware<Pg>;
declare const syncWrapped: WithMiddleware<SQLiteBunDatabase>;
declare const asyncWrapped: WithMiddleware<LibSQLDatabase>;
declare const pgTx: PgAsyncTransaction<PgQueryResultHKT>;
declare function requireWrapped<T>(db: WithMiddleware<T>): void;
declare function acceptPg(db: Pg): void;

// -----------------------------------------------------------------------
// WithMiddleware
// -----------------------------------------------------------------------

// A wrapped db is still accepted where the base db type is.
acceptPg(pgWrapped);
const asSyncBase: SQLiteBunDatabase = syncWrapped;

// The unwrapped db is rejected where a wrapped db is required.
// @ts-expect-error -- the unwrapped db has no brand
requireWrapped(pg);
requireWrapped(pgWrapped);

// The brand is a read-only string.
const id: string = pgWrapped.__drizzleMiddlewareId;
// @ts-expect-error -- read-only
pgWrapped.__drizzleMiddlewareId = "x";

// `$client` stays in the type, so the subtype relation holds.
const client: PGlite = pgWrapped.$client;

async function transactions(): Promise<void> {
	// Postgres: `tx` and nested savepoints are branded; the result is typed.
	const n: number = await pgWrapped.transaction(async (tx) => {
		requireWrapped(tx);
		await tx.transaction(async (savepoint) => {
			requireWrapped(savepoint);
		});
		return 1;
	});
	// Async SQLite returns a promise.
	const s: string = await asyncWrapped.transaction(async (tx) => {
		requireWrapped(tx);
		return "async";
	});
	// Sync SQLite returns the value itself, not a promise.
	const t: string = syncWrapped.transaction((tx) => {
		requireWrapped(tx);
		return "sync";
	});
	const rows: number[] = syncWrapped.transaction(() => [1]);
	syncWrapped.transaction(() => {});
	// @ts-expect-error -- a sync driver commits when the callback returns
	syncWrapped.transaction(async () => {});
	void [n, s, t, rows];
}

// -----------------------------------------------------------------------
// PgDb / SqliteDb (the withMiddleware constraints)
// -----------------------------------------------------------------------

declare function pgOnly<T>(db: PgDb<T>): T;
declare function sqliteOnly<T>(db: SqliteDb<T>): T;

// The exact db type is inferred.
assertType<Exact<ReturnType<typeof pgOnly<Pg>>, Pg>>();
const back: Pg = pgOnly(pg);
// @ts-expect-error -- withMiddleware accepts a db, not a transaction
pgOnly(pgTx);
sqliteOnly(syncWrapped);
// @ts-expect-error -- a SQLite db is not a Postgres db
pgOnly(syncWrapped);
// @ts-expect-error -- a Postgres db is not a SQLite db
sqliteOnly(pg);
// @ts-expect-error -- not a db
pgOnly({ session: {}, dialect: {} });

// -----------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------

declare const statement: SQL;
declare const maybe: SQL[] | undefined;
const ok: Middleware[] = [
	() => ({}),
	() => ({ before: [statement] }),
	() => ({ before: [statement], after: [sql`select 1`] }),
	() => ({ before: maybe }),
	() => ({ after: [statement] as const }),
];
// @ts-expect-error -- statements must be SQL objects
const notSql: Middleware = () => ({ before: ["select 1"] });
// @ts-expect-error -- a single SQL object is not an array
const notArray: Middleware = () => ({ before: statement });
// @ts-expect-error -- misspelled key
const typo: Middleware = () => ({ befor: [statement] });
// @ts-expect-error -- the factory is sync
const asyncFactory: Middleware = async () => ({ before: [statement] });

// -----------------------------------------------------------------------
// BatchResults
// -----------------------------------------------------------------------

assertType<
	Exact<
		BatchResults<[Promise<number>, PromiseLike<{ id: string }[]>]>,
		[number, { id: string }[]]
	>
>();
assertType<Exact<BatchResults<[]>, []>>();

// -----------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------

// A `switch` over `Driver` must handle every kind.
function describe(driver: Driver): string {
	switch (driver.kind) {
		case "batch":
			return driver.strategy;
		case "transaction":
			return driver.mode;
		case "rejected":
			return driver.reason;
		default:
			return assertNever(driver);
	}
}

// Inside `use`, the call and result types are generic, so code there cannot
// pass a call of the wrong driver.
declare const spec: BatchDriverSpec<{ text: string }, { rows: unknown[] }>;
declare const session: DrizzleSession;
const calls: number = batchDriver(spec).use((s) => {
	// @ts-expect-error -- `{ text }` is not the (unknown) call type
	void s.send(session, [{ text: "select 1" }]);
	return 0;
});

void [
	asSyncBase,
	id,
	client,
	back,
	ok,
	notSql,
	notArray,
	typo,
	asyncFactory,
	describe,
	calls,
	transactions,
];
