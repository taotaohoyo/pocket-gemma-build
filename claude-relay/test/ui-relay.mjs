// The relay for the app's claude UI check (scripts/check-ui.sh, scope
// claude): claude-relay in Cloudflare's own runtime (workerd, through
// `wrangler dev`) on 127.0.0.1:<port>, against a stand-in for Anthropic
// on this Mac. Runs until killed. No real key and no network.
//
//   node test/ui-relay.mjs <port> <admin key>
//
// The stand-in answers "テスト用のClaudeが答えています。受け取った発言はN件です。"
// with N the turns it was given (after a short thinking summary), and
// "画像I枚と文書D件を受け取りました。" when photos or files came with them
// (1.1.0 (260)); "長く話して" slowly, for a stop; "つなぎ直して" in twelve
// sentences, for a connection the app drops and reads again; "検索して"
// with a web search and a citation, and "ファイルを作って" with a file made by
// code execution (served by its Files API), when the request has those
// tools; and "billing" with Anthropic's out-of-credit error. FAKE-CLAUDE
// lines say what it was asked (model, effort, max_tokens, tools,
// attachments) and when a reply's connection closed early.

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

// Anthropic's Models API, as the relay asks it which models and levels it offers now.
const MODEL_IDS = ["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
function modelsList(res) {
  const effort = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };
  const data = MODEL_IDS.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-10-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort } }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }));
}

// The file "ファイルを作って" makes, as Anthropic's Files API gives it.
const MADE_FILE = { id: "file_ui0001report", filename: "report.txt", mime_type: "text/plain" };
const MADE_TEXT = "Fieluaのテスト用ファイルです。\n";
function filesAPI(req, res) {
  const match = /^\/v1\/files\/([^/?]+)(\/content)?/.exec(req.url);
  if (!match || match[1] !== MADE_FILE.id) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "File not found" } }));
    return;
  }
  console.log(`FAKE-CLAUDE files ${match[2] ? "content" : "metadata"} ${match[1]}`);
  if (match[2]) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(MADE_TEXT);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "file", ...MADE_FILE, size_bytes: Buffer.byteLength(MADE_TEXT), created_at: "2026-11-11T00:00:00Z", downloadable: true }));
}

const anthropic = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) return modelsList(res);
  if (req.method === "GET" && req.url.startsWith("/v1/files/")) return filesAPI(req, res);
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    const body = JSON.parse(data);
    // A turn with attachments is the relay's blocks: the photos and files, then the text.
    const content = body.messages.at(-1).content;
    const question = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const blocks = body.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const images = blocks.filter((b) => b.type === "image").length;
    const documents = blocks.filter((b) => b.type === "document").length;
    const tools = (body.tools ?? []).map((t) => t.name);
    console.log(`FAKE-CLAUDE asked turns=${body.messages.length} model=${body.model} effort=${body.output_config?.effort} max_tokens=${body.max_tokens} tools=${tools.join("+") || "none"} container=${body.container?.id ?? "none"} images=${images} documents=${documents} last=${JSON.stringify(question)}`);
    if (question === "billing") {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low." } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (question === "検索して" && tools.includes("web_search")) return searchReply(body, send, res);
    if (question === "ファイルを作って" && tools.includes("code_execution")) return fileReply(body, send, res);
    send("message_start", { type: "message_start", message: { id: "msg_ui", model: body.model, content: [] } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "質問を読んでいます。" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    const slow = question === "長く話して";
    const again = question === "つなぎ直して";
    const pieces = slow
      ? Array.from({ length: 200 }, (_, i) => `これは長い返信の${i + 1}文目です。`)
      : again
        ? Array.from({ length: 12 }, (_, i) => `これは${i + 1}文目です。`)
        : [`テスト用のClaudeが答えています。`, `受け取った発言は${body.messages.length}件です。`,
           ...(images || documents ? [`画像${images}枚と文書${documents}件を受け取りました。`] : [])];
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
    }, slow ? 200 : again ? 150 : 40);
    res.on("close", () => {
      clearInterval(timer);
      if (!done) console.log(`FAKE-CLAUDE CLOSED-EARLY after ${sent} pieces`);
    });
  });
});
/** "検索して": a web search, its results, and text that cites one of them. */
function searchReply(body, send, res) {
  const pages = [
    { type: "web_search_result", url: "https://example.com/fielua-a", title: "Fieluaのテストページ A", encrypted_content: "x", page_age: null },
    { type: "web_search_result", url: "https://example.org/fielua-b", title: "Fieluaのテストページ B", encrypted_content: "y", page_age: null },
  ];
  const steps = [
    () => send("message_start", { type: "message_start", message: { id: "msg_search", model: body.model, content: [] } }),
    () => send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "調べます。" } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 0 }),
    () => send("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_ui", name: "web_search", input: {} } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Fielua テスト"}' } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 1 }),
    () => send("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_ui", content: pages } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 2 }),
    () => send("content_block_start", { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "検索した結果です。" } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: pages[1].url, title: pages[1].title, cited_text: "テスト", encrypted_index: "z" } } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 3 }),
    () => send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20, server_tool_use: { web_search_requests: 1 } } }),
    () => send("message_stop", { type: "message_stop" }),
  ];
  play(steps, res, "search");
}

/** "ファイルを作って": code execution writes report.txt in a container, and says so. */
function fileReply(body, send, res) {
  const container = { id: body.container?.id ?? "container_ui0001", expires_at: "2026-12-11T00:00:00Z" };
  const steps = [
    () => send("message_start", { type: "message_start", message: { id: "msg_file", model: body.model, content: [], container } }),
    () => send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_edit", name: "text_editor_code_execution", input: {} } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"create","path":"/tmp/outputs/report.txt"}' } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 0 }),
    () => send("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text_editor_code_execution_tool_result", tool_use_id: "srvtoolu_edit", content: { type: "text_editor_code_execution_create_result", is_file_update: false } } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 1 }),
    () => send("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "srvtoolu_bash", name: "bash_code_execution", input: {} } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 2 }),
    () => send("content_block_start", { type: "content_block_start", index: 3, content_block: { type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_bash", content: { type: "bash_code_execution_result", stdout: "", stderr: "", return_code: 0, content: [{ type: "bash_code_execution_output", file_id: MADE_FILE.id }] } } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 3 }),
    () => send("content_block_start", { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } }),
    () => send("content_block_delta", { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "report.txtを作りました。" } }),
    () => send("content_block_stop", { type: "content_block_stop", index: 4 }),
    () => send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", container }, usage: { output_tokens: 20 } }),
    () => send("message_stop", { type: "message_stop" }),
  ];
  play(steps, res, "file");
}

function play(steps, res, name) {
  let next = 0;
  let done = false;
  const timer = setInterval(() => {
    if (next < steps.length) { steps[next++](); return; }
    clearInterval(timer);
    done = true;
    console.log(`FAKE-CLAUDE finished ${name}`);
    res.end();
  }, 60);
  res.on("close", () => {
    clearInterval(timer);
    if (!done) console.log(`FAKE-CLAUDE CLOSED-EARLY ${name} after ${next} steps`);
  });
}

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
