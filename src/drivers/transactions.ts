// Drivers whose unit runs inside a normal transaction.

import type {
	AsyncTransactionDriver,
	SyncTransactionDriver,
} from "../core/driver.js";
import {
	DrizzleInternalsError,
	type DrizzleSession,
	asDrizzleDb,
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
