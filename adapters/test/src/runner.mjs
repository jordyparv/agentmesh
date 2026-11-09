// Child process for the simulated test adapter. Reads a JSON script on stdin.
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
let input = "";
for await (const c of process.stdin) input += c;
const steps = JSON.parse(input);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
for (const s of steps) {
  if (s.write) {
    mkdirSync(dirname(s.write.path), { recursive: true });
    writeFileSync(s.write.path, s.write.content);
    emit({ type: "file", path: s.write.path });
  } else if (s.symlink) {
    symlinkSync(s.symlink.target, s.symlink.path);
    emit({ type: "file", path: s.symlink.path });
  } else if (s.message !== undefined) emit({ type: "message", text: s.message });
  else if (s.sleepMs) await new Promise((r) => setTimeout(r, s.sleepMs));
  else if (s.output !== undefined) emit({ type: "output", value: s.output });
  else if (s.tool) {
    // Calls an AgentMesh collaboration operation exactly like the MCP server does.
    const res = await fetch(`${process.env.AGENTMESH_API_URL}/api/v1/agent-tools/${s.tool.name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AGENTMESH_AGENT_TOKEN}` },
      body: JSON.stringify(s.tool.args ?? {}),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    const body = await res.text();
    emit({ type: "message", text: `tool ${s.tool.name} -> ${res.status} ${body.slice(0, 4000)}` });
    if (!res.ok && s.tool.required) {
      process.stderr.write(`tool ${s.tool.name} failed: ${res.status}\n`);
      process.exit(3);
    }
  }
  else if (s.exit !== undefined) {
    if (s.stderr) process.stderr.write(s.stderr + "\n");
    process.exit(s.exit);
  }
}
