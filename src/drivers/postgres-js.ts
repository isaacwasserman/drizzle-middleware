// postgres-js and Bun SQL (the same API). BEGIN, the statements, and COMMIT
// are sent concurrently on one reserved connection, and the driver pipelines
// them into one round trip (docs/design.md, sections 5 and 6).
//
// How each client sends the statements:
// - postgres-js, `prepare: true`: `unsafe(sql, params, { prepare: true })`.
//   postgres-js's `unsafe()` does not use prepared statements unless asked,
//   so each statement with parameters would wait a round trip for its types.
// - postgres-js, `prepare: false`: values inlined by the strict encoder, so no
//   statement has parameters and none waits for its types.
// - Bun SQL 1.4+, `prepare: true`: tagged-template calls. Pipelined `unsafe()`
//   calls take extra round trips; tagged calls pipeline fully.
// - Bun SQL, `prepare: false`, or Bun before 1.4: sequentially, in a
//   transaction. With `prepare: false`, Bun does not pipeline. Bun 1.3 gave
//   pipelined queries the wrong results, and hung on a failing pipelined
//   batch once an earlier batch had run on the connection.

import {
	BatchError,
	type Driver,
	type DriverEntry,
	type SendContext,
	batchDriver,
} from "../core/driver.js";
import {
	type DrizzleSession,
	copySession,
	readMember,
} from "../internal/drizzle.js";
import {
	type Inference,
	inlineParams,
	postgresJsInference,
	splitAtPlaceholders,
} from "./pg-inline.js";
import { drizzleAsyncTransaction, serializeOnClient } from "./transactions.js";

/** One `client.unsafe(sql, params)` call, and whether Drizzle wanted `.values()`. */
interface SqlCall {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly mode: "rows" | "values";
}

type Query = PromiseLike<unknown> & { values(): PromiseLike<unknown> };

/** The driver client methods this entry uses. */
interface SqlClient {
	unsafe(
		sql: string,
		params?: readonly unknown[],
		options?: { prepare?: boolean; onexecute?: () => boolean },
	): Query;
}

type TemplateStrings = readonly string[] & { readonly raw: readonly string[] };
type TaggedClient = SqlClient &
	((strings: TemplateStrings, ...values: readonly unknown[]) => Query);

function asSqlClient(value: unknown): SqlClient {
	if (typeof readMember(value, "unsafe") !== "function")
		throw new TypeError(
			"drizzle-middleware: the driver client has no unsafe(). This driver version is not supported.",
		);
	// Checked above: `unsafe` is a function.
	return value as SqlClient;
}

function asTaggedClient(value: unknown): TaggedClient {
	const client = asSqlClient(value);
	if (typeof client !== "function")
		throw new TypeError(
			"drizzle-middleware: the driver client is not a tagged-template function. This driver version is not supported.",
		);
	// Checked above: the client is callable and has `unsafe`.
	return client as TaggedClient;
}

type SendMode = "prepared" | "inline" | "tagged";

/**
 * A stand-in for the client's `unsafe()`. Drizzle calls `unsafe(sql, params)`
 * and then either awaits it or calls `.values()`; the call is recorded at that
 * point, so the mode is known.
 */
function recordingClient(record: (call: SqlCall) => Promise<unknown>) {
	return {
		unsafe(sql: unknown, params: unknown) {
			if (typeof sql !== "string")
				throw new TypeError(
					"drizzle-middleware: Drizzle called unsafe() without a query text. This Drizzle version is not supported for batching.",
				);
			const values = Array.isArray(params) ? params : [];
			let result: Promise<unknown> | undefined;
			const run = (mode: SqlCall["mode"]) => {
				result ??= record({ sql, params: values, mode });
				return result;
			};
			return {
				values: () => run("values"),
				// biome-ignore lint/suspicious/noThenProperty: Drizzle awaits the query.
				then: (
					onFulfilled?: (value: unknown) => unknown,
					onRejected?: (error: unknown) => unknown,
				) => run("rows").then(onFulfilled, onRejected),
			};
		},
	};
}

function query(
	client: unknown,
	s: SqlCall,
	mode: SendMode,
): PromiseLike<unknown> {
	let q: Query;
	if (mode === "tagged") {
		const strings = splitAtPlaceholders(s.sql, s.params.length);
		const template: TemplateStrings = Object.assign([...strings], {
			raw: [...strings],
		});
		q = asTaggedClient(client)(template, ...s.params);
	} else if (mode === "prepared") {
		q = asSqlClient(client).unsafe(s.sql, s.params, { prepare: true });
	} else {
		q = asSqlClient(client).unsafe(s.sql, s.params);
	}
	return s.mode === "values" ? q.values() : q;
}

/**
 * The driver sends a query when it is first awaited, so every query must be
 * awaited in order, by one `Promise.allSettled` over the whole list.
 */
function sendInOrder(
	client: unknown,
	statements: readonly SqlCall[],
	mode: SendMode,
): Promise<PromiseSettledResult<unknown>[]> {
	return Promise.allSettled(statements.map((s) => query(client, s, mode)));
}

function firstFailure(settled: readonly PromiseSettledResult<unknown>[]) {
	const index = settled.findIndex((s) => s.status === "rejected");
	const failed = settled[index];
	return failed?.status === "rejected"
		? new BatchError(index, failed.reason)
		: undefined;
}

const valuesOf = (settled: readonly PromiseSettledResult<unknown>[]) =>
	settled.map((s) => (s.status === "fulfilled" ? s.value : undefined));

async function sendUnit(
	session: DrizzleSession,
	calls: readonly SqlCall[],
	context: SendContext,
	mode: SendMode,
	inference: Inference,
	pinned: boolean,
): Promise<unknown[]> {
	const client = readMember(session, "client");
	const statements =
		mode === "inline"
			? calls.map((c) => ({
					sql: inlineParams(c.sql, c.params, inference),
					params: [],
					mode: c.mode,
				}))
			: calls;

	if (context.inTransaction) {
		// Inside the transaction's own client: no BEGIN or COMMIT.
		const settled = await sendInOrder(client, statements, mode);
		const failure = firstFailure(settled);
		if (failure) throw failure;
		return valuesOf(settled);
	}

	// A pinned client is already one connection (its work is queued), so the
	// unit runs on it. Otherwise the unit reserves a connection from the pool.
	const reserved: unknown = pinned ? client : await reserveOn(client);

	// postgres-js retries a cached prepared statement that the server rejects
	// as out of date (for example after ALTER TABLE). It writes the retry after
	// everything already on the connection, which here is after the COMMIT, so
	// the retry would run outside the transaction. So in "prepared" mode a
	// guard BEGIN follows the COMMIT in the same flight: a retry lands in the
	// guard transaction, and the ROLLBACK after the results discards it.
	// postgres-js writes at most `max_pipeline` queries at once; a longer unit
	// sends its COMMIT after the statements have settled, so a retry stays
	// inside the unit's transaction.
	const unit: SqlCall[] = [BEGIN, ...statements, COMMIT];
	const guarded = mode === "prepared";
	const oneFlight = !guarded || unit.length + 1 <= maxPipeline(client);
	const sent = (
		guarded && oneFlight
			? [...unit, BEGIN]
			: oneFlight
				? unit
				: unit.slice(0, -1)
	).map((s) => query(reserved, s, mode));
	const guardOpen = guarded && oneFlight;
	let lost = false;
	try {
		const settled = await Promise.allSettled(sent);
		if (!oneFlight)
			settled.push(
				...(await Promise.allSettled([query(reserved, COMMIT, mode)])),
			);
		lost = settled.some(
			(s) => s.status === "rejected" && isConnectionLost(s.reason),
		);
		const begin = settled[0];
		const commit = settled[unit.length - 1];
		const inner = settled.slice(1, unit.length - 1);
		if (begin?.status === "rejected") throw begin.reason;
		const failure = firstFailure(inner);
		if (failure) throw failure;
		if (commit?.status === "rejected") throw commit.reason;
		// After a failure, Postgres turns the COMMIT into a ROLLBACK. A
		// statement whose error the driver hid (a postgres-js retry) shows only
		// here.
		if (readMember(commit?.value, "command") !== "COMMIT")
			throw silentRollback(sent.slice(1, unit.length - 1));
		return valuesOf(inner);
	} finally {
		// postgres-js has already moved a lost connection to its closed list;
		// release() would put it back in the open list, and the next query on
		// it would hang.
		let released = pinned || lost;
		const release = () => {
			if (released) return;
			released = true;
			const fn = readMember(reserved, "release");
			if (typeof fn === "function") Reflect.apply(fn, reserved, []);
		};
		if (guardOpen && !lost) closeGuard(reserved, release);
		else release();
	}
}

/**
 * postgres-js's own codes for a closed connection, and the socket errors
 * that make it close one. A server error, even FATAL, is not included:
 * postgres-js can report a stale FATAL error on the next query of a new,
 * live connection, which must go back to the pool.
 */
const LOST_CONNECTION = new Set([
	"CONNECTION_CLOSED",
	"CONNECTION_DESTROYED",
	"CONNECTION_ENDED",
	"ECONNRESET",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
]);

function isConnectionLost(error: unknown): boolean {
	const code = readMember(error, "code");
	return typeof code === "string" && LOST_CONNECTION.has(code);
}

/**
 * Writes the ROLLBACK that closes the guard, then releases the connection.
 * postgres-js keeps the writes on a connection in order, so the next user's
 * queries go after the ROLLBACK; the connection need not wait for its reply.
 * The `onexecute` option runs when the query is written. If it does not run,
 * the connection is released after the reply.
 */
function closeGuard(reserved: unknown, release: () => void): void {
	const rollback = asSqlClient(reserved).unsafe("rollback", [], {
		onexecute: () => {
			queueMicrotask(release);
			return true;
		},
	});
	rollback.then(release, (error: unknown) => {
		if (!isConnectionLost(error)) release();
	});
}

async function reserveOn(client: unknown): Promise<unknown> {
	const reserve = readMember(client, "reserve");
	if (typeof reserve !== "function")
		throw new TypeError(
			"drizzle-middleware: the driver client has no reserve(), so the batch cannot run in one transaction on one connection.",
		);
	return Reflect.apply(reserve, client, []);
}

const BEGIN: SqlCall = { sql: "begin", params: [], mode: "rows" };
const COMMIT: SqlCall = { sql: "commit", params: [], mode: "rows" };

/** postgres-js's `max_pipeline` option (default 100). */
function maxPipeline(client: unknown): number {
	const value = readMember(readMember(client, "options"), "max_pipeline");
	return typeof value === "number" ? value : 100;
}

/**
 * The unit's transaction rolled back, but no statement reported an error.
 * postgres-js keeps the first error of a retried query on the query object;
 * it is used only to name the statement in the error.
 */
function silentRollback(statements: readonly PromiseLike<unknown>[]): Error {
	const index = statements.findIndex((q) => readMember(q, "retried") != null);
	const cause =
		index === -1 ? undefined : readMember(statements[index], "retried");
	return index === -1
		? new Error(
				"drizzle-middleware: the database rolled back the unit's transaction, but no statement reported an error.",
			)
		: new BatchError(index, cause);
}

/** What differs between postgres-js and Bun SQL. */
interface DriverRules {
	readonly sessionKind: "PostgresJsSession" | "BunSQLSession";
	/** How the driver types parameters, for the inline encoder. */
	readonly inference: Inference;
	/** How this client's batches are sent, or "sequential" if they cannot be. */
	mode(client: unknown): SendMode | "sequential";
	/**
	 * "pool" for a client that gives each unit its own connection, "connection"
	 * for one connection (like a `pg.Client`), or why the client is rejected.
	 */
	clientKind(client: unknown): "pool" | "connection" | { rejected: string };
}

const prepareDisabled = (client: unknown) =>
	readMember(readMember(client, "options"), "prepare") === false;

const POSTGRES_JS: DriverRules = {
	sessionKind: "PostgresJsSession",
	inference: postgresJsInference,
	// A postgres-js reserved client has no reserve() or begin(), so units and
	// transactions on it throw.
	clientKind: () => "pool",
	// Only `prepare: false` inlines values. withMiddleware accepts only a db,
	// so the client is always the top-level client, which has `options`.
	mode: (client) => (prepareDisabled(client) ? "inline" : "prepared"),
};

/** True on Bun 1.4 or newer, where pipelined queries behave correctly. */
function bunAtLeast14(): boolean {
	const version = readMember(readMember(globalThis, "Bun"), "version");
	if (typeof version !== "string") return false;
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > 1 || (major === 1 && minor >= 4);
}

/**
 * Bun names each SQL handle: the pool is `sql`, a reserved connection is
 * `reserved_sql` (with `release()`), and a transaction or savepoint handle is
 * `transaction_sql` (with `savepoint()`).
 */
export function bunClientKind(
	client: unknown,
): "pool" | "connection" | "transaction" | "unknown" {
	if (typeof client !== "function") return "unknown";
	const name = readMember(client, "name");
	const has = (member: string) =>
		typeof readMember(client, member) === "function";
	if (name === "transaction_sql" || has("savepoint")) return "transaction";
	if (name === "reserved_sql" && has("release")) return "connection";
	if (name === "sql" && !has("release")) return "pool";
	return "unknown";
}

// A unit on a transaction handle would reserve another connection, outside
// that transaction.
export const bunTransactionHandle =
	"its client is a transaction handle; pass the SQL client (the pool)";

const BUN_SQL: DriverRules = {
	sessionKind: "BunSQLSession",
	inference: postgresJsInference,
	clientKind: (client) => {
		const kind = bunClientKind(client);
		if (kind === "pool" || kind === "connection") return kind;
		return {
			rejected:
				kind === "transaction"
					? bunTransactionHandle
					: "its client is not a Bun SQL client, a reserved connection or a transaction",
		};
	},
	mode: (client) =>
		prepareDisabled(client) || !bunAtLeast14() ? "sequential" : "tagged",
};

function entry(rules: DriverRules): DriverEntry {
	return {
		sessionKind: rules.sessionKind,
		dialect: "pg",
		driverFor: (session): Driver => {
			const client = readMember(session, "client");
			const kind = rules.clientKind(client);
			if (typeof kind === "object")
				return { kind: "rejected", reason: kind.rejected };
			// One connection: Drizzle opens transactions on it, so its work runs
			// one item at a time, like a pool of one (see node-postgres).
			const pinned = kind === "connection";
			const mode = rules.mode(client);
			if (mode === "sequential") {
				const driver = drizzleAsyncTransaction("sequential");
				return pinned ? { ...driver, serialize: serializeOnClient } : driver;
			}
			return batchDriver<SqlCall, unknown>(
				{
					strategy:
						mode === "inline"
							? "pipelined-transaction-inline"
							: "pipelined-transaction",
					recordingSession: (s, recorder) =>
						copySession(s, {
							client: recordingClient((call) => recorder.record(call)),
						}),
					send: (s, calls, context) =>
						sendUnit(s, calls, context, mode, rules.inference, pinned),
				},
				pinned ? serializeOnClient : undefined,
			);
		},
	};
}

export const postgresJs: DriverEntry = entry(POSTGRES_JS);
export const bunSqlPostgres: DriverEntry = entry(BUN_SQL);
