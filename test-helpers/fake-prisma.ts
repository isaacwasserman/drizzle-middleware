// A fake Prisma client. It logs each statement with the handle that ran it:
// the main client (`prisma`) or the interactive transaction client (`tx`).
export function fakePrisma(log: string[], fail?: string) {
	const client = (who: string) => ({
		$queryRawUnsafe: async (query: string, ...params: unknown[]) => {
			log.push(
				`${who}: ${query}${params.length > 0 ? ` ${JSON.stringify(params)}` : ""}`,
			);
			if (fail && query.includes(fail)) throw new Error(`failed: ${fail}`);
			return [{ id: 1 }];
		},
	});
	return {
		...client("prisma"),
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
			log.push("begin");
			try {
				const result = await fn(client("tx"));
				log.push("commit");
				return result;
			} catch (err) {
				log.push("rollback");
				throw err;
			}
		},
	};
}
