// A node-postgres "Submittable" that sends several statements in one round
// trip: Parse/Bind/Describe/Execute for each, then one Sync. Postgres runs
// everything before the Sync as one implicit transaction, or inside the open
// transaction. See docs/design.md, section 5 ("Pipeline").

import { BatchError } from "../core/driver.js";
import { readMember } from "../internal/drizzle.js";

/** The query config that Drizzle passes to `client.query(config, values)`. */
export interface PgQueryConfig {
	readonly text: string;
	readonly rowMode?: unknown;
	readonly types?: unknown;
}

export interface PgCall {
	readonly config: PgQueryConfig;
	readonly values: readonly unknown[];
}

/** What node-postgres's `Result` does for one statement. */
export interface PgResult {
	addFields(fields: unknown): void;
	parseRow(fields: unknown): unknown;
	addRow(row: unknown): void;
	addCommandComplete(message: unknown): void;
}

/** The driver's own value conversion and result type. */
export interface PgPipelineDeps {
	createResult(rowMode: unknown, types: unknown): PgResult;
	prepareValue(value: unknown): unknown;
}

/** The node-postgres connection methods the pipeline uses. */
interface PgConnection {
	parse(message: object, more: boolean): void;
	bind(message: object, more: boolean): void;
	describe(message: object, more: boolean): void;
	execute(message: object, more: boolean): void;
	sync(): void;
	sendCopyFail(message: string): void;
}

function asConnection(value: unknown): PgConnection {
	for (const name of ["parse", "bind", "describe", "execute", "sync"])
		if (typeof readMember(value, name) !== "function")
			throw new TypeError(
				`drizzle-middleware: the node-postgres connection has no ${name}(). This driver version is not supported.`,
			);
	// Checked above: each method the pipeline calls is a function.
	return value as PgConnection;
}

class Pipeline {
	private readonly results: PgResult[];
	private index = 0;
	private failed = false;
	readonly done: Promise<PgResult[]>;
	private resolve: (results: PgResult[]) => void = () => {};
	private reject: (error: unknown) => void = () => {};

	constructor(
		private readonly calls: readonly PgCall[],
		private readonly deps: PgPipelineDeps,
	) {
		this.results = calls.map((c) =>
			deps.createResult(c.config.rowMode, c.config.types),
		);
		this.done = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	// Called by node-postgres when the query reaches the front of its queue.
	submit(value: unknown): void {
		const connection = asConnection(value);
		for (const call of this.calls) {
			connection.parse({ text: call.config.text }, true);
			connection.bind(
				{ values: call.values.map((v) => this.deps.prepareValue(v)) },
				true,
			);
			connection.describe({ type: "P" }, true);
			connection.execute({ rows: 0 }, true);
		}
		connection.sync();
	}

	private current(): PgResult | undefined {
		return this.results[this.index];
	}
	handleRowDescription(message: { fields: unknown }): void {
		this.current()?.addFields(message.fields);
	}
	handleDataRow(message: { fields: unknown }): void {
		const result = this.current();
		result?.addRow(result.parseRow(message.fields));
	}
	handleCommandComplete(message: unknown): void {
		this.current()?.addCommandComplete(message);
		this.index++;
	}
	handleEmptyQuery(): void {
		this.index++;
	}
	handlePortalSuspended(): void {}
	handleCopyInResponse(connection: unknown): void {
		asConnection(connection).sendCopyFail(
			"drizzle-middleware: COPY is not supported in a batch",
		);
	}
	handleCopyData(): void {}
	// node-postgres calls this and drops the query; it then waits for
	// ReadyForQuery before it sends the next query.
	handleError(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.reject(new BatchError(this.index, error));
	}
	handleReadyForQuery(): void {
		if (!this.failed) this.resolve(this.results);
	}
}

/** Sends `calls` on `client` (a node-postgres Client or PoolClient). */
export function runPipeline(
	client: unknown,
	calls: readonly PgCall[],
	deps: PgPipelineDeps,
): Promise<PgResult[]> {
	const query = readMember(client, "query");
	if (typeof query !== "function")
		throw new TypeError("drizzle-middleware: the client has no query()");
	const pipeline = new Pipeline(calls, deps);
	Reflect.apply(query, client, [pipeline]);
	return pipeline.done;
}

/** Drizzle's own check: a node-postgres Pool, not a Client or PoolClient. */
export function isPool(client: unknown): boolean {
	const name = readMember(readMember(client, "constructor"), "name");
	return (
		typeof name === "string" &&
		name.includes("Pool") &&
		typeof readMember(client, "connect") === "function"
	);
}

/** Reads the query config and values of one `client.query(...)` call. */
export function toPgCall(config: unknown, values: unknown): PgCall {
	const text = readMember(config, "text");
	if (typeof text !== "string")
		throw new TypeError(
			"drizzle-middleware: Drizzle called client.query() without a query text. This Drizzle version is not supported for batching.",
		);
	return {
		config: {
			text,
			rowMode: readMember(config, "rowMode"),
			types: readMember(config, "types"),
		},
		values: Array.isArray(values) ? values : [],
	};
}

export function asPgResult(value: unknown): PgResult {
	for (const name of ["addFields", "parseRow", "addRow", "addCommandComplete"])
		if (typeof readMember(value, name) !== "function")
			throw new TypeError(
				`drizzle-middleware: the driver's Result has no ${name}(). This driver version is not supported.`,
			);
	// Checked above: each method the pipeline calls is a function.
	return value as PgResult;
}
