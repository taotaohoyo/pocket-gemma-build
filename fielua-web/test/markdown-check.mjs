// The Markdown steps that need no browser (src/mdsource.js, src/highlight.js),
// against the iPhone app's own cases (ios-markdown-cases.json, taken from
// PocketCore's MarkdownTests.swift) and a few of the web's.
//
//   node test/markdown-check.mjs

import { readFileSync } from "node:fs";
import { chunks, prepare, repairStreaming, tableHeadEnd, wholeSyntax, FLANK, MATH_OPEN, MATH_CLOSE } from "../src/mdsource.js";
import { detectedLanguage, displayName, highlightHTML, tokens } from "../src/highlight.js";
import { streamEvent, Pacer } from "../src/stream.js";

let failed = 0;
let passed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}\n  got      ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
  }
}

// The app's cases.
const cases = JSON.parse(readFileSync(new URL("./ios-markdown-cases.json", import.meta.url), "utf8"));
for (const c of cases) {
  const actual = c.fn === "chunks" ? chunks(c.input) : repairStreaming(c.input).text;
  check(`${c.fn}(${JSON.stringify(c.input)}) [${c.from}]`, actual, c.expected);
}

// The web's own.
check("an opening fence still arriving waits", repairStreaming("説明\n```pyt").text, "説明");
check("an opening fence with its line ended shows as code", repairStreaming("説明\n```python\n").text, "説明\n```python\n```");
check("an open $$ block is a formula still being written", repairStreaming("$$\nx^2").closedMath, true);

const m1 = prepare("面積は $\\pi r^2$ です。");
check("inline math becomes a placeholder", m1.text, `面積は ${MATH_OPEN}0${MATH_CLOSE} です。`);
check("inline math keeps its LaTeX", m1.math, [{ latex: "\\pi r^2", display: false, raw: "$\\pi r^2$" }]);
check("prices stay text", prepare("価格は $5 と $10 です").math.length, 0);
check("a price with Japanese stays text", prepare("$5と$10").math.length, 0);
check("\\( \\) is inline math", prepare("\\(a+b\\)").math[0], { latex: "a+b", display: false, raw: "\\(a+b\\)" });
check("$$ on one line becomes a math fence", prepare("$$ E = mc^2 $$").text, "```math\nE = mc^2\n```");
check("$$ over lines becomes a math fence", prepare("$$\n\\int_0^1 x\\,dx\n$$").text, "```math\n\\int_0^1 x\\,dx\n```");
check("\\[ \\] over lines becomes a math fence", prepare("\\[\na^2+b^2=c^2\n\\]").text, "```math\na^2+b^2=c^2\n```");
check("a bare cases environment is a formula", prepare("\\begin{cases}\nx+y=5 \\\\\nx-y=1\n\\end{cases}").text, "```math\n\\begin{cases}\nx+y=5 \\\\\nx-y=1\n\\end{cases}\n```");
check("math in a code span stays code", prepare("`$x$` は").math.length, 0);
check("math in fenced code stays code", prepare("```\n$x$\n```").text, "```\n$x$\n```");
check("emphasis next to Japanese punctuation gets hair spaces", prepare("これは**「重要」**です").text, `これは${FLANK}**「重要」**${FLANK}です`);
check("a note line is shown as written", prepare("[注]: 上記は概算です。").text, "\\[注]: 上記は概算です。");
check("a footnote line is shown as written", prepare("[^1]: 出典").text, "\\[^1]: 出典");

check("chunks keep a table whole", chunks("| a |\n|---|\n| 1 |\n\n次"), ["| a |\n|---|\n| 1 |", "次"]);

// Pacing: a table's head is taken whole.
const table = "表です。\n\n| 日程 | 時間帯 |\n| :--- | :--- |\n| 1日目 | 午前 |\n";
const head = "表です。\n\n".length;
check("a step into a table's header takes the header and its delimiter row", tableHeadEnd(table, head + 2), head + "| 日程 | 時間帯 |\n| :--- | :--- |\n".length);
check("a step never ends inside syntax", wholeSyntax("a **b**", 3), 4);
check("a step never splits an emoji", wholeSyntax("家族👨‍👩‍👧", 3) >= 4, true);

// The pacer lays a steady reply out behind the model, and finishes after it.
{
  const pacer = new Pacer();
  let t = 0;
  let written = 0;
  const steps = [];
  for (; t < 8; t += 1 / 24) {
    if (t < 5) { const owed = Math.floor(t * 40); while (written < owed) { pacer.text += "あ"; written++; } }
    else pacer.generating = false;
    steps.push(pacer.advance(t));
  }
  check("the pacer shows everything once the reply ended", pacer.finished, true);
  const mid = steps[Math.floor(3 * 24)];
  check("the pacer stays within two seconds of the model", mid >= (3 - 2) * 40, true);
}

// Stream events, as the app reads them.
check("text delta", streamEvent('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"こん"}}'), { type: "text", text: "こん" });
check("thinking", streamEvent('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'), { type: "thinking" });
check("refusal", streamEvent('data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}'), { type: "refused" });
check("cut off", streamEvent('data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}'), { type: "cutOff" });
check("an error in the stream", streamEvent('data: {"type":"error","error":{"type":"overloaded_error"}}'), { type: "failed", error: "overloaded_error" });
check("event names are not data", streamEvent("event: ping"), null);

// Code colours, as the app's.
check("Swift's name", displayName("swift"), "Swift");
check("a language hint with a file name", displayName("python:main.py"), "Python");
check("TOML is named without colours", displayName("toml"), "TOML");
check("JSON is recognized", detectedLanguage('{"a": 1}'), "json");
check("Python is recognized", detectedLanguage("def f(x):\n    return x"), "python");
check("tokens join back into the code", tokens("let x = \"a\" // c\n", "swift").map((t) => t.text).join(""), "let x = \"a\" // c\n");
check("keywords and strings", tokens('let x = "a"', "swift").map((t) => t.kind), ["keyword", "plain", "string"]);
check("HTML is escaped", highlightHTML("<script>alert(1)</script>", "text"), "&lt;script&gt;alert(1)&lt;/script&gt;");
check("markup is escaped inside its colours", highlightHTML('<a href="x">', "html").includes("<a"), false);

console.log(`${passed} passed, ${failed} failed (${cases.length} of them the app's own cases)`);
process.exit(failed ? 1 : 0);
