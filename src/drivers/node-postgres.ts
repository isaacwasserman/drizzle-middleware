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

export const nodePostgres: DriverEntry = {
	sessionKind: "NodePgSession",
	dialect: "pg",
	driverFor: () =>
		batchDriver<PgCall, PgResult>({
			strategy: "pipeline",
			recordingSession: (session, recorder) =>
				copySession(session, {
					client: {
						query: (config: unknown, values: unknown) =>
							recorder.record(toPgCall(config, values)),
					},
				}),
			send: (session, calls) => send(readMember(session, "client"), calls),
		}),
};
