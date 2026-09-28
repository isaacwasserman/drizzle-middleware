// Drivers whose unit runs inside a normal transaction.

import type {
	AsyncTransactionDriver,
	Serialize,
	SyncTransactionDriver,
} from "../core/driver.js";
import {
	DrizzleInternalsError,
	type DrizzleSession,
	asDrizzleDb,
	readMember,
} from "../internal/drizzle.js";

const noCallback = () =>
	new DrizzleInternalsError("the transaction did not run its callback");

/** An async driver: Drizzle's own `session.transaction(fn)`. */
export function drizzleAsyncTransaction(
	strategy: AsyncTransactionDriver["strategy"],
): AsyncTransactionDriver {
	return {
		kind: "transaction",
		mode: "async",
		strategy,
		async run<T>(
			session: DrizzleSession,
			body: (txSession: DrizzleSession) => Promise<T>,
		): Promise<T> {
			const box: { result?: { value: T } } = {};
			await session.transaction(async (tx) => {
				box.result = { value: await body(asDrizzleDb(tx).session) };
			});
			if (box.result === undefined) throw noCallback();
			return box.result.value;
		},
	};
}

/** The tail of each client's queue. */
const queues = new WeakMap<object, Promise<unknown>>();

/**
 * A queue for each client: work from wrapped dbs on the session's client runs
 * one item at a time, in call order. An item is a unit, or a whole
 * `wrapped.transaction(fn)`.
 */
export const serializeOnClient: Serialize = <T>(
	session: DrizzleSession,
	body: () => Promise<T>,
): Promise<T> => {
	const client = readMember(session, "client");
	// A Bun SQL client is a function (a tagged template).
	if (
		client === null ||
		(typeof client !== "object" && typeof client !== "function")
	)
		throw new DrizzleInternalsError("the session has no client");
	const result = (queues.get(client) ?? Promise.resolve()).then(body);
	const settled = () => undefined;
	queues.set(client, result.then(settled, settled));
	return result;
};

/**
 * Like `drizzleAsyncTransaction("local-transaction")`, for a client with one
 * connection that does not queue transactions.
 */
export function serializedAsyncTransaction(): AsyncTransactionDriver {
	return {
		...drizzleAsyncTransaction("local-transaction"),
		serialize: serializeOnClient,
	};
}

/** A sync SQLite driver: Drizzle's own sync `session.transaction(fn)`. */
export const drizzleSyncTransaction: SyncTransactionDriver = {
	kind: "transaction",
	mode: "sync",
	strategy: "local-transaction",
	run<T>(session: DrizzleSession, body: (txSession: DrizzleSession) => T): T {
		const box: { result?: { value: T } } = {};
		session.transaction((tx) => {
			box.result = { value: body(asDrizzleDb(tx).session) };
		});
		if (box.result === undefined) throw noCallback();
		return box.result.value;
	},
};
