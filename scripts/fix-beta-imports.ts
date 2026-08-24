import { Glob } from "bun";

const glob = new Glob("**/*.{js,d.ts,d.ts.map}");
for await (const path of glob.scan({ cwd: "dist/beta" })) {
	const fullPath = `dist/beta/${path}`;
	const file = Bun.file(fullPath);
	const content = await file.text();
	const fixed = content.replaceAll("drizzle-orm-beta", "drizzle-orm");
	if (content !== fixed) await Bun.write(fullPath, fixed);
}
