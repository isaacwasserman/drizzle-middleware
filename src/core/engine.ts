// The recording engine: runs Drizzle's own prepared queries against a
// recording session, sends the recorded driver calls as one batch, and gives
// each result back to Drizzle, which maps it. See docs/design.md, section 5.

import type { DrizzleSession } from "../internal/drizzle.js";
import {
	type BatchDriverSpec,
	BatchError,
	type Execution,
	type Recorder,
} from "./driver.js";

/**
 * A Drizzle prepared query did not make exactly one driver call while it was
 * recorded. The batch cannot pair results with statements, so it fails closed.
 */
export class RecordingError extends Error {
	constructor(statement: number, problem: string) {
		super(
			`drizzle-middleware: statement ${statement + 1} of the unit made ${problem} while it was recorded. This Drizzle version is not supported for batching.`,
		);
		this.name = "RecordingError";
	}
}

/** Another statement of the unit failed; the database rolled back the unit. */
export class RolledBackError extends Error {
	constructor(failed: number) {
		super(
			`drizzle-middleware: statement ${failed + 1} of the unit failed, so the unit was rolled back`,
		);
		this.name = "RolledBackError";
	}
}

interface Pending<TCall, TResult> {
	readonly call: TCall;
	resolve(result: TResult): void;
	reject(error: unknown): void;
}

/**
 * Runs `executions` against recording sessions, one at a time, so their driver
 * calls are recorded in order. Then sends all calls with `spec.send` and gives
 * each result back. Returns each execution's value, in order.
 */
export async function runRecordedBatch<TCall, TResult>(
	spec: BatchDriverSpec<TCall, TResult>,
	session: DrizzleSession,
	executions: readonly Execution[],
): Promise<unknown[]> {
	const pending: Pending<TCall, TResult>[] = [];
	const outputs: Promise<unknown>[] = [];
	let sent = false;

	// If recording stops early, settle every call that was recorded, and keep
	// the outputs from reporting unhandled rejections.
	const abandon = (error: unknown) => {
		for (const p of pending) p.reject(error);
		for (const output of outputs) output.catch(() => {});
	};

	for (const [index, execute] of executions.entries()) {
		let markRecorded: () => void = () => {};
		const recorded = new Promise<"recorded">((resolve) => {
			markRecorded = () => resolve("recorded");
		});
		let calls = 0;
		const recorder: Recorder<TCall, TResult> = {
			record(call) {
				calls++;
				if (calls > 1)
					return Promise.reject(
						new RecordingError(index, "more than one driver call"),
					);
				if (sent)
					return Promise.reject(
						new RecordingError(index, "a driver call after the batch was sent"),
					);
				return new Promise<TResult>((resolve, reject) => {
					pending.push({ call, resolve, reject });
					markRecorded();
				});
			},
		};
		const output = execute(spec.recordingSession(session, recorder));
		outputs.push(output);
		const first = await Promise.race([
			recorded,
			output.then(
				() => "settled" as const,
				() => "settled" as const,
			),
		]);
		if (first === "settled") {
			// Drizzle finished without a driver call. Pass its error on, or
			// fail closed if it succeeded (for example, from a cache).
			const failure = await output.then(
				() => new RecordingError(index, "no driver call"),
				(error: unknown) => error,
			);
			abandon(failure);
			throw failure;
		}
	}

	sent = true;
	let results: readonly TResult[];
	try {
		results = await spec.send(
			session,
			pending.map((p) => p.call),
		);
	} catch (error) {
		const failed = error instanceof BatchError ? error.index : -1;
		const cause = error instanceof BatchError ? error.cause : error;
		pending.forEach((p, i) =>
			p.reject(
				failed === -1 || i === failed ? cause : new RolledBackError(failed),
			),
		);
		// Report the failing statement's error, as Drizzle wrapped it.
		const settled = await Promise.allSettled(outputs);
		const report =
			failed >= 0
				? settled[failed]
				: settled.find((s) => s.status === "rejected");
		throw report?.status === "rejected" ? report.reason : cause;
	}

	if (results.length !== pending.length) {
		const error = new RecordingError(
			results.length,
			`a batch with ${results.length} results for ${pending.length} statements`,
		);
		abandon(error);
		throw error;
	}
	pending.forEach((p, i) => {
		const result = results[i];
		// Checked above: `results` has one entry per pending call.
		p.resolve(result as TResult);
	});
	return Promise.all(outputs);
}
