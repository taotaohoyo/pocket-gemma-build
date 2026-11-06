// The relay for the app's claude UI check (scripts/check-ui.sh, scope
// claude): claude-relay in Cloudflare's own runtime (workerd, through
// `wrangler dev`) on 127.0.0.1:<port>, against a stand-in for Anthropic
// on this Mac. Runs until killed. No real key and no network.
//
//   node test/ui-relay.mjs <port> <admin key>
//
// The stand-in answers "テスト用のClaudeが答えています。受け取った発言はN件です。"
// with N the turns it was given (after a short thinking summary); "長く話して" slowly, for a stop; and
// "billing" with Anthropic's out-of-credit error. FAKE-CLAUDE lines say
// what it was asked (model, effort, max_tokens) and when a reply's
// connection closed early.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 8787);
const admin = process.argv[3] ?? "";
if (admin.length < 32) {
  console.error("usage: node test/ui-relay.mjs <port> <admin key of 32+ characters>");
  process.exit(2);
}

const anthropic = createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    const body = JSON.parse(data);
    const question = body.messages.at(-1).content;
    console.log(`FAKE-CLAUDE asked turns=${body.messages.length} model=${body.model} effort=${body.output_config?.effort} max_tokens=${body.max_tokens} last=${JSON.stringify(question)}`);
    if (question === "billing") {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low." } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "msg_ui", model: body.model, content: [] } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "質問を読んでいます。" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    const slow = question === "長く話して";
    const pieces = slow
      ? Array.from({ length: 200 }, (_, i) => `これは長い返信の${i + 1}文目です。`)
      : [`テスト用のClaudeが答えています。`, `受け取った発言は${body.messages.length}件です。`];
    let sent = 0;
    let done = false;
    const timer = setInterval(() => {
      if (sent < pieces.length) {
        send("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: pieces[sent] } });
        sent++;
        return;
      }
      clearInterval(timer);
      send("content_block_stop", { type: "content_block_stop", index: 1 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: pieces.length } });
      send("message_stop", { type: "message_stop" });
      done = true;
      console.log(`FAKE-CLAUDE finished pieces=${pieces.length}`);
      res.end();
    }, slow ? 200 : 40);
    res.on("close", () => {
      clearInterval(timer);
      if (!done) console.log(`FAKE-CLAUDE CLOSED-EARLY after ${sent} pieces`);
    });
  });
});
await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
const anthropicPort = anthropic.address().port;

const state = mkdtempSync(join(tmpdir(), "fielua-relay-ui-"));
const wrangler = spawn("npx", [
  "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state,
  "--var", "ANTHROPIC_API_KEY:sk-ant-ui-check",
  "--var", `ADMIN_TOKEN:${admin}`,
  "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${anthropicPort}`,
], { env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
// npx, wrangler and workerd: the whole group goes when the check ends.
const stopRelay = () => { try { process.kill(-wrangler.pid, "SIGTERM"); } catch {} };
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));
wrangler.on("exit", (code) => {
  console.log(`FAKE-CLAUDE wrangler exited ${code}\n${log.slice(-2000)}`);
  process.exit(1);
});

for (let i = 0; i < 180; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/join`)).ok) {
      console.log(`FAKE-CLAUDE READY relay=http://127.0.0.1:${port}`);
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const stop = () => {
  stopRelay();
  anthropic.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
