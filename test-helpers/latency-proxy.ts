import net from "node:net";

/**
 * A TCP proxy that delays every server-to-client chunk by `latencyMs`. With it,
 * the wall time of a call shows how many round trips the call made.
 */
export async function startLatencyProxy(
	target: { host: string; port: number },
	latencyMs: number,
): Promise<{ port: number; close(): Promise<void> }> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((client) => {
		const upstream = net.connect(target.port, target.host);
		for (const s of [client, upstream]) {
			sockets.add(s);
			s.on("close", () => sockets.delete(s));
			s.on("error", () => {});
		}
		client.on("data", (chunk) => upstream.write(chunk));
		upstream.on("data", (chunk) =>
			setTimeout(() => client.write(chunk), latencyMs),
		);
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("latency proxy: no port");
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
				server.close(() => resolve());
			}),
	};
}
