import net from "node:net";

/**
 * A TCP proxy that counts round trips. A round trip starts when the client
 * sends data after it got server data (or for the first time). A pipelining
 * client sends all its messages before any reply, so it makes one round trip.
 *
 * Each server-to-client chunk is delayed by `latencyMs`, so a pipelined
 * client finishes its writes before any reply gets to it.
 */
export async function startLatencyProxy(
	target: { host: string; port: number },
	latencyMs: number,
): Promise<{
	port: number;
	/** The round trips since the last call to `resetRoundTrips()`. */
	roundTrips(): number;
	resetRoundTrips(): void;
	close(): Promise<void>;
}> {
	const sockets = new Set<net.Socket>();
	let roundTrips = 0;
	let replied = true;
	const server = net.createServer((client) => {
		const upstream = net.connect(target.port, target.host);
		for (const s of [client, upstream]) {
			sockets.add(s);
			s.on("close", () => sockets.delete(s));
			s.on("error", () => {});
		}
		client.on("data", (chunk) => {
			if (replied) roundTrips++;
			replied = false;
			upstream.write(chunk);
		});
		upstream.on("data", (chunk) =>
			setTimeout(() => {
				replied = true;
				client.write(chunk);
			}, latencyMs),
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
		roundTrips: () => roundTrips,
		resetRoundTrips: () => {
			roundTrips = 0;
			replied = true;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
				server.close(() => resolve());
			}),
	};
}
