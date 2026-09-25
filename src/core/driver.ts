// Driver registry types, and the plan for every Drizzle session kind.
//
// Each supported driver gets one explicit entry, keyed by Drizzle's session
// kind. A session kind without an entry throws: the package does not guess
// what a driver can do. See docs/design.md, section 5.

import type { Dialect, DrizzleSession } from "../internal/drizzle.js";

export type StrategyKind =
	/** Parse/Bind/Execute for every statement, then one Sync. */
	| "pipeline"
	/** BEGIN, the statements, and COMMIT, sent concurrently on one connection. */
	| "pipelined-transaction"
	/** Like `pipelined-transaction`, with values inlined by the strict encoder. */
	| "pipelined-transaction-inline"
	/** The driver's own atomic batch call, with parameters. */
	| "batch-api"
	/** A normal transaction on an in-process database. */
	| "local-transaction"
	/** A normal transaction with one call per statement. */
	| "sequential";

/** One Drizzle prepared-query execution, run on the session it gets. */
export type Execution = (session: DrizzleSession) => Promise<unknown>;

/** Records one driver call and returns a promise for its result. */
export interface Recorder<TCall, TResult> {
	record(call: TCall): Promise<TResult>;
}

/** A driver whose calls are recorded, then sent together as one batch. */
export interface BatchDriverSpec<TCall, TResult> {
	readonly strategy: Exclude<StrategyKind, "local-transaction" | "sequential">;
	/** A copy of `session` whose driver handle records calls instead of sending them. */
	recordingSession(
		session: DrizzleSession,
		recorder: Recorder<TCall, TResult>,
	): DrizzleSession;
	/**
	 * Sends the calls as one atomic unit. Returns one result per call, in
	 * order. If one statement fails, rejects with a `BatchError` that names it.
	 */
	send(
		session: DrizzleSession,
		calls: readonly TCall[],
		context: SendContext,
	): Promise<readonly TResult[]>;
}

export interface SendContext {
	/**
	 * True when the session is already inside a transaction. The batch then
	 * runs in that transaction; otherwise the driver must make it atomic.
	 */
	readonly inTransaction: boolean;
}

/** A batch failed at statement `index`; the database rolled back the unit. */
export class BatchError extends Error {
	readonly index: number;
	constructor(index: number, cause: unknown) {
		super(`drizzle-middleware: statement ${index + 1} of the batch failed`, {
			cause,
		});
		this.name = "BatchError";
		this.index = index;
	}
}

/**
 * A batch driver with its call and result types hidden. `use` gives the spec
 * back with its own types, so the registry needs no `any`.
 */
export interface BatchDriver {
	readonly kind: "batch";
	readonly strategy: BatchDriverSpec<unknown, unknown>["strategy"];
	use<R>(
		visit: <TCall, TResult>(spec: BatchDriverSpec<TCall, TResult>) => R,
	): R;
}

export function batchDriver<TCall, TResult>(
	spec: BatchDriverSpec<TCall, TResult>,
): BatchDriver {
	return {
		kind: "batch",
		strategy: spec.strategy,
		use: (visit) => visit(spec),
	};
}

/** A sync SQLite driver: the unit runs inside a native sync transaction. */
export interface SyncTransactionDriver {
	readonly kind: "transaction";
	readonly mode: "sync";
	readonly strategy: "local-transaction";
	run<T>(session: DrizzleSession, body: (txSession: DrizzleSession) => T): T;
}

/** An async driver whose unit runs inside a transaction, one call per statement. */
export interface AsyncTransactionDriver {
	readonly kind: "transaction";
	readonly mode: "async";
	readonly strategy: "local-transaction" | "sequential";
	run<T>(
		session: DrizzleSession,
		body: (txSession: DrizzleSession) => Promise<T>,
	): Promise<T>;
}

/** A driver that cannot give the guarantees; `withMiddleware` throws. */
export interface RejectedDriver {
	readonly kind: "rejected";
	readonly reason: string;
}

export type Driver =
	| BatchDriver
	| SyncTransactionDriver
	| AsyncTransactionDriver
	| RejectedDriver;

export interface DriverEntry {
	readonly sessionKind: SessionKind;
	readonly dialect: Dialect;
	/** Picks the driver for one session, e.g. by the `prepare` option. */
	driverFor(session: DrizzleSession): Driver;
}

/** For exhaustive `switch` statements over a union. */
export function assertNever(value: never): never {
	throw new Error(`drizzle-middleware: unhandled case ${String(value)}`);
}

// -----------------------------------------------------------------------
// The plan: every Drizzle Postgres and SQLite session kind, and the
// strategies its entry may use. A test compares this list with the session
// kinds in the installed Drizzle, so a new Drizzle driver fails CI until it
// has a plan.
// -----------------------------------------------------------------------

export type SessionKind =
	| "NodePgSession"
	| "NeonSession"
	| "VercelPgSession"
	| "NetlifyDbSession"
	| "NetlifyDbWsSession"
	| "PostgresJsSession"
	| "BunSQLSession"
	| "NeonHttpSession"
	| "PgliteSession"
	| "AwsDataApiSession"
	| "PrismaPgSession"
	| "PgRemoteSession"
	| "XataHttpSession"
	| "EffectPgSession"
	| "SQLiteBunSession"
	| "BetterSQLiteSession"
	| "SQLJsSession"
	| "SQLiteDOSession"
	| "ExpoSQLiteSession"
	| "OPSQLiteSession"
	| "TursoDatabaseSession"
	| "BunSQLiteSession"
	| "LibSQLSession"
	| "SQLiteD1Session"
	| "SQLiteRemoteSession"
	| "SQLiteCloudSession"
	| "PrismaSQLiteSession";

export type DriverPlan =
	| {
			readonly dialect: Dialect;
			readonly strategies: readonly [StrategyKind, ...StrategyKind[]];
	  }
	| { readonly dialect: Dialect; readonly rejected: string };

const noTransactions =
	"it has no batching, and its Drizzle session throws on transaction()";

export const DRIVER_PLAN: Readonly<Record<SessionKind, DriverPlan>> = {
	NodePgSession: { dialect: "pg", strategies: ["pipeline"] },
	NeonSession: { dialect: "pg", strategies: ["pipeline"] },
	VercelPgSession: { dialect: "pg", strategies: ["pipeline"] },
	NetlifyDbWsSession: { dialect: "pg", strategies: ["pipeline"] },
	NetlifyDbSession: { dialect: "pg", strategies: ["batch-api"] },
	// `pipelined-transaction` with `prepare: true`, the inline path without it.
	PostgresJsSession: {
		dialect: "pg",
		strategies: ["pipelined-transaction", "pipelined-transaction-inline"],
	},
	// Bun SQL 1.3 has no reliable one-round-trip mechanism (src/drivers/postgres-js.ts).
	BunSQLSession: { dialect: "pg", strategies: ["sequential"] },
	NeonHttpSession: { dialect: "pg", strategies: ["batch-api"] },
	PgliteSession: { dialect: "pg", strategies: ["local-transaction"] },
	AwsDataApiSession: { dialect: "pg", strategies: ["sequential"] },
	PrismaPgSession: { dialect: "pg", strategies: ["sequential"] },
	PgRemoteSession: { dialect: "pg", rejected: noTransactions },
	XataHttpSession: { dialect: "pg", rejected: noTransactions },
	EffectPgSession: {
		dialect: "pg",
		rejected: "its queries return Effect values, not promises",
	},
	SQLiteBunSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	BetterSQLiteSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	// Drizzle uses this kind for both sql.js and node:sqlite.
	SQLJsSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	SQLiteDOSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	ExpoSQLiteSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	OPSQLiteSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	TursoDatabaseSession: {
		dialect: "sqlite",
		strategies: ["local-transaction"],
	},
	BunSQLiteSession: { dialect: "sqlite", strategies: ["local-transaction"] },
	LibSQLSession: { dialect: "sqlite", strategies: ["batch-api"] },
	SQLiteD1Session: { dialect: "sqlite", strategies: ["batch-api"] },
	// `batch-api` with a batch callback, `sequential` without one.
	SQLiteRemoteSession: {
		dialect: "sqlite",
		strategies: ["batch-api", "sequential"],
	},
	SQLiteCloudSession: { dialect: "sqlite", strategies: ["sequential"] },
	PrismaSQLiteSession: { dialect: "sqlite", strategies: ["sequential"] },
};
