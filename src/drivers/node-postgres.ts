// node-postgres (and pg-compatible clients): the pipeline strategy.

import { type DriverEntry, batchDriver } from "../core/driver.js";
import { copySession, readMember } from "../internal/drizzle.js";
import {
	type PgCall,
	type PgPipelineDeps,
	type PgResult,
	asPgResult,
	isPool,
	runPipeline,
	toPgCall,
} from "./pg-pipeline.js";
import { serializeOnClient } from "./transactions.js";

// node-postgres's own value conversion and Result, from the `pg` module the
// app uses. They make the batched values and results equal to Drizzle's.
let pgDeps: Promise<PgPipelineDeps> | undefined;
function loadPg(): Promise<PgPipelineDeps> {
	pgDeps ??= import("pg").then((mod: unknown) => {
		const pg = readMember(mod, "default") ?? mod;
		const Result = readMember(pg, "Result");
		const prepareValue = readMember(readMember(pg, "utils"), "prepareValue");
		if (typeof Result !== "function" || typeof prepareValue !== "function")
			throw new TypeError(
				"drizzle-middleware: the `pg` module has no Result or utils.prepareValue. This node-postgres version is not supported.",
			);
		return {
			createResult: (rowMode, types) =>
				asPgResult(Reflect.construct(Result, [rowMode, types])),
			prepareValue: (value) => Reflect.apply(prepareValue, undefined, [value]),
		};
	});
	return pgDeps;
}

async function send(
	client: unknown,
	calls: readonly PgCall[],
): Promise<PgResult[]> {
	const deps = await loadPg();
	if (!isPool(client)) return runPipeline(client, calls, deps);
	const connect = readMember(client, "connect");
	if (typeof connect !== "function")
		throw new TypeError("drizzle-middleware: the pool has no connect()");
	const connection: unknown = await Reflect.apply(connect, client, []);
	try {
		return await runPipeline(connection, calls, deps);
	} finally {
		const release = readMember(connection, "release");
		if (typeof release === "function") Reflect.apply(release, connection, []);
	}
}

// A client that is not a pool (a `pg.Client`, or a `PoolClient` that the app
// checked out) is one connection, and Drizzle opens its transactions on it.
// Work from another request sent during an open transaction would run inside
// it, so the client's work runs one item at a time, like a pool of one.
// Drizzle's own pool check covers more than `isPool`, so the queue is on
// whenever Drizzle shares the connection.
export const nodePostgres: DriverEntry = {
	sessionKind: "NodePgSession",
	dialect: "pg",
	driverFor: (session) =>
		batchDriver<PgCall, PgResult>(
			{
				strategy: "pipeline",
				recordingSession: (s, recorder) =>
					copySession(s, {
						client: {
							query: (config: unknown, values: unknown) =>
								recorder.record(toPgCall(config, values)),
						},
					}),
				send: (s, calls) => send(readMember(s, "client"), calls),
			},
			isPool(readMember(session, "client")) ? undefined : serializeOnClient,
		),
};
