import net from "node:net";

export const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@localhost:55441/postgres";

/**
 * A TCP proxy in front of Postgres that counts round trips: a round trip
 * starts each time the client sends data after the server sent data (or for
 * the first data on a connection).
 */
export async function startProxy(target: string) {
	const url = new URL(target);
	let roundTrips = 0;
	const sockets = new Set<net.Socket>();
	const server = net.createServer((client) => {
		let clientTurn = false;
		const upstream = net.connect(Number(url.port), url.hostname);
		sockets.add(client);
		sockets.add(upstream);
		client.on("data", (chunk) => {
			if (!clientTurn) roundTrips++;
			clientTurn = true;
			upstream.write(chunk);
		});
		upstream.on("data", (chunk) => {
			clientTurn = false;
			client.write(chunk);
		});
		const close = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on("close", close);
		upstream.on("close", close);
		client.on("error", close);
		upstream.on("error", close);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	const proxyUrl = new URL(target);
	proxyUrl.hostname = "127.0.0.1";
	proxyUrl.port = String(port);
	return {
		url: proxyUrl.toString(),
		/** Runs fn and returns the number of round trips it made. */
		async count(fn: () => Promise<unknown>): Promise<number> {
			const start = roundTrips;
			await fn();
			// Let the last responses reach the client side of the proxy.
			await new Promise((resolve) => setTimeout(resolve, 20));
			return roundTrips - start;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
