import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Bundles the MCP stdio server into one self-contained file that can be bind-mounted into agent sandboxes. */
export const MCP_ENTRY = fileURLToPath(new URL("./stdio.ts", import.meta.url));
export const MCP_BUNDLE = fileURLToPath(new URL("../dist/agentmesh-mcp.mjs", import.meta.url));

export async function buildMcpBundle(outfile = MCP_BUNDLE): Promise<string> {
  await build({
    entryPoints: [MCP_ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(await buildMcpBundle());
}
