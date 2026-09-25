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
import { drizzleAsyncTransaction } from "./transactions.js";

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
		options?: { prepare: boolean },
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

	const reserve = readMember(client, "reserve");
	if (typeof reserve !== "function")
		throw new TypeError(
			"drizzle-middleware: the driver client has no reserve(), so the batch cannot run in one transaction on one connection.",
		);
	const reserved: unknown = await Reflect.apply(reserve, client, []);
	try {
		// After a failure, Postgres turns the COMMIT into a ROLLBACK.
		const settled = await sendInOrder(
			reserved,
			[
				{ sql: "begin", params: [], mode: "rows" },
				...statements,
				{ sql: "commit", params: [], mode: "rows" },
			],
			mode,
		);
		const begin = settled[0];
		const commit = settled[settled.length - 1];
		const inner = settled.slice(1, -1);
		if (begin?.status === "rejected") throw begin.reason;
		const failure = firstFailure(inner);
		if (failure) throw failure;
		if (commit?.status === "rejected") throw commit.reason;
		return valuesOf(inner);
	} finally {
		const release = readMember(reserved, "release");
		if (typeof release === "function") Reflect.apply(release, reserved, []);
	}
}

/** What differs between postgres-js and Bun SQL. */
interface DriverRules {
	readonly sessionKind: "PostgresJsSession" | "BunSQLSession";
	/** How the driver types parameters, for the inline encoder. */
	readonly inference: Inference;
	/** How this client's batches are sent, or "sequential" if they cannot be. */
	mode(client: unknown): SendMode | "sequential";
}

const prepareDisabled = (client: unknown) =>
	readMember(readMember(client, "options"), "prepare") === false;

const POSTGRES_JS: DriverRules = {
	sessionKind: "PostgresJsSession",
	inference: postgresJsInference,
	mode: (client) => (prepareDisabled(client) ? "inline" : "prepared"),
};

/** True on Bun 1.4 or newer, where pipelined queries behave correctly. */
function bunAtLeast14(): boolean {
	const version = readMember(readMember(globalThis, "Bun"), "version");
	if (typeof version !== "string") return false;
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > 1 || (major === 1 && minor >= 4);
}

const BUN_SQL: DriverRules = {
	sessionKind: "BunSQLSession",
	inference: postgresJsInference,
	mode: (client) =>
		prepareDisabled(client) || !bunAtLeast14() ? "sequential" : "tagged",
};

function entry(rules: DriverRules): DriverEntry {
	return {
		sessionKind: rules.sessionKind,
		dialect: "pg",
		driverFor: (session): Driver => {
			const mode = rules.mode(readMember(session, "client"));
			if (mode === "sequential") return drizzleAsyncTransaction("sequential");
			return batchDriver<SqlCall, unknown>({
				strategy:
					mode === "inline"
						? "pipelined-transaction-inline"
						: "pipelined-transaction",
				recordingSession: (s, recorder) =>
					copySession(s, {
						client: recordingClient((call) => recorder.record(call)),
					}),
				send: (s, calls, context) =>
					sendUnit(s, calls, context, mode, rules.inference),
			});
		},
	};
}

export const postgresJs: DriverEntry = entry(POSTGRES_JS);
export const bunSqlPostgres: DriverEntry = entry(BUN_SQL);
