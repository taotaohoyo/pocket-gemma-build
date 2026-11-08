// Text-level steps around the Markdown parser, ported from the iPhone
// app (PocketCore/MarkdownSource.swift) so a reply reads the same on both:
// splitting a reply into chunks that are parsed and drawn on their own,
// closing syntax a streaming reply has not finished yet, taking LaTeX out
// of the text so Markdown never touches it, and letting emphasis work next
// to Japanese punctuation. (The app's charts are Gemma's; Claude's replies
// have none, so that part is left out.)

/** Put where CommonMark would not see emphasis next to Japanese punctuation; removed after parsing. */
export const FLANK = " ";
export const MATH_OPEN = "";
export const MATH_CLOSE = "";

// MARK: Characters

const isSpace = (c) => c !== undefined && /\s/u.test(c);
const isNumber = (c) => c !== undefined && /\p{N}/u.test(c);
const isPunctuation = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const trimWS = (s) => s.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
const trimEndSpaces = (s) => s.replace(/ +$/, "");

export function isJapanese(c) {
  if (!c) return false;
  const v = c.codePointAt(0);
  return (v >= 0x3000 && v <= 0x30FF) || (v >= 0x3400 && v <= 0x4DBF) || (v >= 0x4E00 && v <= 0x9FFF)
    || (v >= 0xF900 && v <= 0xFAFF) || (v >= 0xFF01 && v <= 0xFF9F);
}

/** The character (code point) ending just before `index`, in UTF-16 units. */
function charBefore(text, index) {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && index >= 2) return text.slice(index - 2, index);
  return text[index - 1];
}
function charAt(text, index) {
  if (index >= text.length) return undefined;
  return String.fromCodePoint(text.codePointAt(index));
}

function find(pattern, chars, start) {
  for (let i = Math.max(start, 0); i + pattern.length <= chars.length; i++) {
    let ok = true;
    for (let k = 0; k < pattern.length; k++) if (chars[i + k] !== pattern[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
function startsAt(pattern, chars, start) {
  if (start + pattern.length > chars.length) return false;
  for (let k = 0; k < pattern.length; k++) if (chars[start + k] !== pattern[k]) return false;
  return true;
}
function closingTicks(chars, from, length) {
  let i = from;
  while (i < chars.length) {
    if (chars[i] !== "`") { i++; continue; }
    let run = 0;
    while (chars[i + run] === "`") run++;
    if (run === length) return i;
    i += run;
  }
  return -1;
}
function codeSpanTicks(text) {
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== "`") { i++; continue; }
    let run = 0;
    while (chars[i + run] === "`") run++;
    const end = closingTicks(chars, i + run, run);
    if (end < 0) return { open: true, length: run };
    i = end + run;
  }
  return { open: false, length: 0 };
}

// MARK: Lines

export function lines(source) {
  return (source.includes("\r") ? source.replace(/\r\n?/g, "\n") : source).split("\n");
}
const isBlank = (line) => /^[ \t]*$/.test(line);

function isListMarker(line) {
  const content = line.replace(/^ +/, "");
  const first = content[0];
  if (!first) return false;
  if ("-*+".includes(first)) return content[1] === " ";
  return /^\p{N}{1,9}[.)] /u.test(content);
}

/** Leading spaces and quote markers, which a fence or math block keeps. */
export function splitPrefix(line) {
  const match = /^[ \t>]*/.exec(line);
  return { prefix: match[0], content: line.slice(match[0].length) };
}

function fenceOpening(line) {
  const { prefix, content } = splitPrefix(line);
  const marker = content[0];
  if (marker !== "`" && marker !== "~") return null;
  let run = 0;
  while (content[run] === marker) run++;
  if (run < 3) return null;
  if (marker === "`" && content.slice(run).includes("`")) return null;
  return { marker, length: run, prefix };
}

function closes(fence, line) {
  const { content } = splitPrefix(line);
  let run = 0;
  while (content[run] === fence.marker) run++;
  return run >= fence.length && /^[ \t]*$/.test(content.slice(run));
}

/** Whether each line belongs to a fenced code block, fences included. */
export function fencedLines(ls) {
  const result = new Array(ls.length).fill(false);
  let open = null;
  ls.forEach((line, i) => {
    if (open) {
      result[i] = true;
      if (closes(open, line)) open = null;
    } else {
      const fence = fenceOpening(line);
      if (fence) { result[i] = true; open = fence; }
    }
  });
  return result;
}

function openFenceStart(ls) {
  let open = null;
  ls.forEach((line, i) => {
    if (open) {
      if (closes(open.fence, line)) open = null;
    } else {
      const fence = fenceOpening(line);
      if (fence) open = { index: i, fence };
    }
  });
  return open ? { index: open.index, closing: open.fence.prefix + open.fence.marker.repeat(open.fence.length) } : null;
}

// MARK: Chunks

/**
 * The reply split at blank lines that start a new top-level block, so a
 * growing reply only parses its last chunk again. Fenced code, math
 * blocks, indented continuations and lists stay in one chunk.
 */
export function chunks(source) {
  const ls = lines(source);
  const fenced = fencedLines(ls);
  const math = mathBlockLines(ls, fenced);
  const result = [];
  let current = [];
  let currentHasList = false;
  let i = 0;
  while (i < ls.length) {
    const line = ls[i];
    if (!isBlank(line) || fenced[i] || math[i]) {
      current.push(line);
      if (!fenced[i] && !math[i] && isListMarker(line)) currentHasList = true;
      i++;
      continue;
    }
    let next = i + 1;
    while (next < ls.length && isBlank(ls[next])) next++;
    if (next === ls.length) break;
    const following = ls[next];
    const startsBlock = !(following[0] === " " || following[0] === "\t");
    const continuesList = isListMarker(following) && currentHasList;
    if (startsBlock && !continuesList && current.length) {
      result.push(current.join("\n"));
      current = [];
      currentHasList = false;
      i = next;
    } else {
      current.push(...ls.slice(i, next));
      i = next;
    }
  }
  if (current.length) result.push(current.join("\n"));
  return result;
}

/** Link reference definitions from the whole reply, added to every chunk so a reference resolves wherever it is used. */
export function referenceDefinitions(source) {
  const ls = lines(source);
  const fenced = fencedLines(ls);
  return ls.filter((raw, i) => {
    if (fenced[i]) return false;
    const line = raw.replace(/^ +/, "");
    if (line[0] !== "[" || line.startsWith("[^") || isProseReference(line)) return false;
    const close = line.indexOf("]");
    if (close < 0) return false;
    const rest = line.slice(close + 1);
    return rest[0] === ":" && /\S/.test(rest.slice(1));
  }).join("\n");
}

/** `[注]: 上記は概算です。` is a note, not a link definition; it is shown as written. */
function isProseReference(content) {
  if (content[0] !== "[") return false;
  const close = content.indexOf("]");
  if (close < 0) return false;
  const rest = content.slice(close + 1);
  if (rest[0] !== ":") return false;
  const destination = rest.slice(1).replace(/^[ \t]+/, "").split(/\s/)[0] ?? "";
  return Array.from(destination).some(isJapanese);
}

// MARK: Streaming

/**
 * Closes what a streaming reply has opened but not finished, so the text
 * never shows raw syntax or flips between layouts: an open code fence or
 * math block is closed, half a table row and a lone `-` wait, and
 * emphasis, code spans and links on the last line are closed or held back.
 * `closedMath` says the text ends in a formula still being written.
 */
export function repairStreaming(chunk) {
  const ls = lines(chunk);
  const endedLine = /\n[ \t]*$/.test(chunk);
  while (ls.length && isBlank(ls[ls.length - 1])) ls.pop();
  if (!ls.length) return { text: "", closedMath: false };
  const open = openFenceStart(ls);
  if (open) {
    // A fence's opening line still arriving (```pyt) waits, so its language never shows half-named.
    if (open.index === ls.length - 1 && !endedLine) {
      ls.pop();
      return { text: ls.join("\n"), closedMath: false };
    }
    ls.push(open.closing);
    return { text: ls.join("\n"), closedMath: false };
  }
  const fenced = fencedLines(ls);
  const closing = openMathBlock(ls, fenced);
  if (closing !== null) {
    ls.push(closing);
    return { text: ls.join("\n"), closedMath: true };
  }
  const start = openBareEnvironment(ls, fenced);
  if (start !== null) {
    const { prefix } = splitPrefix(ls[start]);
    ls.splice(start, 0, prefix + "$$");
    ls.push(prefix + "$$");
    return { text: ls.join("\n"), closedMath: true };
  }
  holdBackTableRows(ls);
  let last = ls.pop();
  if (last === undefined) return { text: "", closedMath: false };
  if (isDangling(last, ls.length === 0)) return { text: ls.join("\n"), closedMath: false };
  last = repairInline(last);
  if (isDangling(last, ls.length === 0) || (ls.length && trimWS(last).startsWith("|") && !/[^|\s]/u.test(last))) {
    return { text: ls.join("\n"), closedMath: false };
  }
  ls.push(last);
  return { text: ls.join("\n"), closedMath: false };
}

/** A last line that would change the layout for a moment: `-` under a line, a list or heading marker still arriving. */
function isDangling(line, first) {
  const content = trimWS(splitPrefix(line).content);
  if (!content) return false;
  const quoted = line.includes(">");
  const chars = Array.from(content);
  return (chars.length < 3 && chars.every((c) => c === "-" || c === "="))
    || chars.every((c) => c === "`" || c === "~")
    || ["*", "+", "-"].includes(content) || chars.every((c) => c === "#")
    || (chars.length < 11 && chars.every((c) => isNumber(c) || c === "." || c === ")") && !(first && !quoted));
}

/** Inline math still arriving would show as raw LaTeX, so a short run that looks like LaTeX waits for its closing delimiter. */
function holdBackOpenMath(text) {
  if (!text.includes("$") && !text.includes("\\")) return text;
  const ch = Array.from(text);
  let i = 0;
  let opener = null;
  while (i < ch.length) {
    const c = ch[i];
    if (c === "`") {
      let run = 0;
      while (ch[i + run] === "`") run++;
      const end = closingTicks(ch, i + run, run);
      i = end >= 0 ? end + run : i + run;
      continue;
    }
    if (c === "\\" && i + 1 < ch.length) {
      const next = ch[i + 1];
      if (next === "(" || next === "[") {
        const end = find(next === "(" ? ["\\", ")"] : ["\\", "]"], ch, i + 2);
        if (end < 0) { opener = { start: i, length: 2, sure: true }; break; }
        i = end + 2;
        continue;
      }
      const begin = mathEnvironmentBegin(ch, i);
      if (begin) {
        const end = environmentEnd(ch, begin.name, begin.end);
        if (end) { i = end.end; continue; }
        // One that runs into a code span is LaTeX named in a sentence.
        if (!ch.slice(begin.end).includes("`")) { opener = { start: i, length: begin.end - i, sure: true }; break; }
      }
      i += 2;
      continue;
    }
    if (c === "$") {
      // A dollar sign that just arrived waits one token to show whether it opens a formula.
      if (i + 1 >= ch.length) { opener = { start: i, length: 1, sure: true }; break; }
      if (ch[i + 1] === "$") {
        const end = find(["$", "$"], ch, i + 2);
        if (end < 0) { opener = { start: i, length: 2, sure: true }; break; }
        i = end + 2;
        continue;
      }
      if (!isSpace(ch[i + 1])) {
        let end = i + 1;
        let found = -1;
        while (end < ch.length) {
          if (ch[end] === "\\") { end += 2; continue; }
          if (ch[end] === "`") break;
          if (ch[end] === "$") {
            if (!isSpace(ch[end - 1]) && !isNumber(ch[end + 1])) found = end;
            break;
          }
          end++;
        }
        if (found >= 0) { i = found + 1; continue; }
        opener = { start: i, length: 1, sure: false };
        break;
      }
    }
    i++;
  }
  if (!opener) return holdBackPartialBegin(text);
  const content = ch.slice(opener.start + opener.length);
  const limit = opener.sure ? 80 : 60;
  if (!(content.length <= limit && (opener.sure || looksLikeLaTeX(content)))) return text;
  return trimEndSpaces(ch.slice(0, opener.start).join(""));
}

/** `\begin{ca` at the end of the text waits until its name is complete. */
function holdBackPartialBegin(text) {
  const slash = text.lastIndexOf("\\");
  if (slash < 0) return text;
  const tail = text.slice(slash);
  const begin = "\\begin{";
  const partial = tail.length < begin.length
    ? tail.length > 1 && begin.startsWith(tail)
    : tail.startsWith(begin) && tail.length <= begin.length + 12 && /^[A-Za-z*]*$/.test(tail.slice(begin.length));
  if (!partial) return text;
  return trimEndSpaces(text.slice(0, slash));
}

function repairInline(line) {
  let text = line;
  if (text.endsWith("\\")) text = text.slice(0, -1);
  const open = text.lastIndexOf("](");
  const labelBeforeOpen = open >= 0 ? text.slice(0, open).lastIndexOf("[") : -1;
  if (open >= 0 && !text.slice(open + 2).includes(")") && labelBeforeOpen >= 0) {
    // A link or image whose address is still arriving shows its label.
    const label = labelBeforeOpen;
    const isImage = label > 0 && text[label - 1] === "!";
    const labelText = text.slice(label + 1, open);
    text = text.slice(0, isImage ? label - 1 : label) + (isImage ? "" : labelText);
  } else {
    const label = text.lastIndexOf("[");
    if (label >= 0 && !text.slice(label).includes("]")
      && (!text.slice(0, label).includes("`") || !codeSpanTicks(text.slice(0, label)).open)) {
      // A label still arriving shows without its bracket; an image's label waits for the image.
      const isImage = label > 0 && text[label - 1] === "!";
      text = isImage ? text.slice(0, label - 1) : text.slice(0, label) + text.slice(label + 1);
    }
  }
  // An unfinished code span is closed, so its text shows as code.
  const ticks = codeSpanTicks(text);
  if (ticks.open) return text + "`".repeat(ticks.length);
  text = holdBackOpenMath(text);
  // Emphasis: markers still arriving at the end wait; an open marker gets its closing one, or waits when nothing follows it yet.
  if (/[*~]$/.test(text)) text = text.replace(/[*~]+$/, "").replace(/ +$/, "");
  for (const marker of ["***", "**", "__", "~~", "*"]) {
    const runs = delimiterRuns(text, marker);
    if (runs.length % 2 !== 1) continue;
    const last = runs[runs.length - 1];
    if (last.end === text.length || /^\s*$/u.test(text.slice(last.end))) {
      text = trimEndSpaces(text.slice(0, last.start) + text.slice(last.end));
    } else {
      text += marker;
    }
  }
  return text;
}

/** Runs of exactly `marker` outside code spans that could open or close emphasis (not with spaces on both sides). */
function delimiterRuns(text, marker) {
  const symbol = marker[0];
  const runs = [];
  let i = 0;
  let inCode = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "`") { inCode = !inCode; i++; continue; }
    if (inCode || c !== symbol) { i++; continue; }
    let end = i;
    while (end < text.length && text[end] === symbol) end++;
    const before = charBefore(text, i);
    const after = charAt(text, end);
    const spacedBefore = before === undefined || isSpace(before);
    const spacedAfter = after === undefined || isSpace(after);
    if (end - i === marker.length && !(spacedBefore && spacedAfter)) runs.push({ start: i, end });
    i = end;
  }
  return runs;
}

/** CommonMark emphasis fails next to Japanese punctuation (`これは**「重要」**です`); a hair space is put where it would. */
function fixFlanking(line) {
  if (!line.includes("*") && !line.includes("~")) return line;
  let text = line;
  for (const marker of ["***", "**", "*", "~~"]) {
    const runs = delimiterRuns(text, marker);
    const inserts = [];
    runs.forEach((run, n) => {
      const before = charBefore(text, run.start);
      const after = charAt(text, run.end);
      if (n % 2 === 0) {
        if (after && isPunctuation(after) && before && !isSpace(before) && !isPunctuation(before)) inserts.push(run.start);
      } else if (before && isPunctuation(before) && after && !isSpace(after) && !isPunctuation(after)) {
        inserts.push(run.end);
      }
    });
    for (const index of inserts.reverse()) text = text.slice(0, index) + FLANK + text.slice(index);
  }
  return text;
}

// MARK: Before parsing

function blockMathDelimiters(trimmed) {
  if (trimmed.startsWith("$$")) return ["$$", "$$"];
  if (trimmed.startsWith("\\[")) return ["\\[", "\\]"];
  return null;
}

function isNoteLine(content) {
  return (content.startsWith("[^") && content.includes("]:")) || isProseReference(content);
}

/**
 * The chunk with LaTeX taken out (block math becomes a ```math fence,
 * inline math a placeholder numbered into `math`) and hair spaces where
 * emphasis meets Japanese punctuation.
 */
export function prepare(source) {
  const ls = lines(source);
  const fenced = fencedLines(ls);
  const out = [];
  const math = [];
  let i = 0;
  while (i < ls.length) {
    const line = ls[i];
    if (fenced[i]) { out.push(line); i++; continue; }
    const { prefix, content } = splitPrefix(line);
    const trimmed = trimWS(content);
    const delimiters = blockMathDelimiters(trimmed);
    if (delimiters) {
      const [open, close] = delimiters;
      const body = trimmed.slice(open.length);
      const inner = body.endsWith(close) ? body.slice(0, body.length - close.length) : body;
      if (body.length > close.length && body.endsWith(close) && !inner.includes(open)) {
        // `$$ x $$` on a line of its own.
        out.push(prefix + "```math", prefix + trimWS(inner), prefix + "```");
        i++;
        continue;
      }
      // A block over several lines; without its closing line it stays text.
      if (!body.includes(close)) {
        let end = -1;
        for (let j = i + 1; j < ls.length; j++) {
          if (!fenced[j] && trimWS(splitPrefix(ls[j]).content).endsWith(close)) { end = j; break; }
        }
        if (end >= 0) {
          out.push(prefix + "```math");
          const first = trimWS(body);
          if (first) out.push(prefix + first);
          for (let m = i + 1; m < end; m++) out.push(ls[m]);
          const tail = splitPrefix(ls[end]);
          const lastPart = trimWS(trimWS(tail.content).slice(0, -close.length));
          if (lastPart) out.push(tail.prefix + lastPart);
          out.push(tail.prefix + "```");
          i = end + 1;
          continue;
        }
      }
    }
    // `\begin{cases} … \end{cases}` written without `$$` on lines of its own is a formula all the same.
    if (trimmed.startsWith("\\begin{")) {
      const env = bareEnvironment(ls, fenced, i);
      if (env && env.end !== null && env.endsLine && isMathBody(env.body, true)) {
        out.push(prefix + "```math", prefix + trimmed);
        if (env.end > i) {
          for (let m = i + 1; m < env.end; m++) out.push(ls[m]);
          const tail = splitPrefix(ls[env.end]);
          out.push(tail.prefix + trimWS(tail.content), tail.prefix + "```");
        } else {
          out.push(prefix + "```");
        }
        i = env.end + 1;
        continue;
      }
    }
    // A footnote (`[^1]: …`) and a note such as `[注]: 概算です` are shown as written. Math first.
    let withMath = extractInlineMath(line, math);
    if (isNoteLine(content)) withMath = withMath.slice(0, prefix.length) + "\\" + withMath.slice(prefix.length);
    out.push(fixFlanking(withMath));
    i++;
  }
  return { text: out.join("\n"), math };
}

/** Undoes `prepare` in text the parser made an indented code block of. */
export function restoreCode(code, math) {
  if (!code.includes(MATH_OPEN) && !code.includes(FLANK) && !code.includes("\\")) return code;
  return lines(code).map((line) => {
    let text = line;
    if (text.startsWith("\\[") && isNoteLine(text.slice(1))) text = text.slice(1);
    text = text.split(FLANK).join("");
    return text.replace(/(\d+)/g, (whole, n) => math[Number(n)]?.raw ?? whole);
  }).join("\n");
}

/**
 * `$…$`, `\(…\)`, `$$…$$`, `\[…\]` and a math environment inside a line,
 * outside code spans. A dollar opens only before a non-space and closes
 * only after one and not before a digit, so "$5 and $10" stays text.
 */
function extractInlineMath(line, math) {
  if (!line.includes("$") && !line.includes("\\(") && !line.includes("\\[") && !line.includes("\\begin{")) return line;
  const ch = Array.from(line);
  let out = "";
  let i = 0;
  const placeholder = (latex, display, raw) => {
    math.push({ latex: trimWS(latex), display, raw });
    return `${MATH_OPEN}${math.length - 1}${MATH_CLOSE}`;
  };
  while (i < ch.length) {
    const c = ch[i];
    if (c === "`") {
      let run = 0;
      while (ch[i + run] === "`") run++;
      const end = closingTicks(ch, i + run, run);
      if (end >= 0) { out += ch.slice(i, end + run).join(""); i = end + run; }
      else { out += ch.slice(i, i + run).join(""); i += run; }
      continue;
    }
    if (c === "\\" && i + 1 < ch.length) {
      const next = ch[i + 1];
      if (next === "(") {
        const end = find(["\\", ")"], ch, i + 2);
        if (end >= 0) {
          out += placeholder(ch.slice(i + 2, end).join(""), false, ch.slice(i, end + 2).join(""));
          i = end + 2;
          continue;
        }
      }
      if (next === "[") {
        const end = find(["\\", "]"], ch, i + 2);
        if (end > i + 2 && looksLikeLaTeX(ch.slice(i + 2, end)) && isLikelyMath(ch.slice(i + 2, end))) {
          out += placeholder(ch.slice(i + 2, end).join(""), true, ch.slice(i, end + 2).join(""));
          i = end + 2;
          continue;
        }
      }
      if (next === "b") {
        const begin = mathEnvironmentBegin(ch, i);
        const end = begin ? environmentEnd(ch, begin.name, begin.end) : null;
        if (begin && end && isMathBody(ch.slice(begin.end, end.start), false)) {
          const raw = ch.slice(i, end.end).join("");
          out += placeholder(raw, true, raw);
          i = end.end;
          continue;
        }
      }
      out += c + next;
      i += 2;
      continue;
    }
    if (c === "$") {
      if (ch[i + 1] === "$") {
        const end = find(["$", "$"], ch, i + 2);
        if (end > i + 2) {
          out += placeholder(ch.slice(i + 2, end).join(""), true, ch.slice(i, end + 2).join(""));
          i = end + 2;
          continue;
        }
      }
      if (i + 1 < ch.length && !isSpace(ch[i + 1]) && ch[i + 1] !== "$") {
        let end = i + 1;
        let found = -1;
        while (end < ch.length) {
          if (ch[end] === "\\") { end += 2; continue; }
          // Math never runs into a code span.
          if (ch[end] === "`") break;
          if (ch[end] === "$") {
            if (!isSpace(ch[end - 1]) && !isNumber(ch[end + 1])) found = end;
            break;
          }
          end++;
        }
        if (found >= 0 && isLikelyMath(ch.slice(i + 1, found))) {
          out += placeholder(ch.slice(i + 1, found).join(""), false, ch.slice(i, found + 1).join(""));
          i = found + 1;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** A command, a script, braces or an equals sign: what a formula has and a price has not. */
function looksLikeLaTeX(content) {
  return content.some((c) => "\\^_{}=".includes(c));
}

/** Japanese outside `\text{}` makes `$5と$10` a price, not math, unless the content has an operator or a command. */
function isLikelyMath(content) {
  let depth = 0;
  let textDepth = null;
  let command = "";
  let japaneseOutsideText = false;
  let previous;
  for (const c of content) {
    const prev = previous;
    previous = c;
    if (c === "\\") { command = "\\"; continue; }
    if (command) {
      if (/[A-Za-z]/.test(c)) { command += c; continue; }
      if (c === "{" && ["\\text", "\\mathrm", "\\textrm", "\\mbox", "\\textbf", "\\operatorname"].includes(command)) {
        depth++;
        if (textDepth === null) textDepth = depth;
        command = "";
        continue;
      }
      command = "";
    }
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      if (textDepth === depth) textDepth = null;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (textDepth === null && isJapanese(c)) {
      // A unit or a particle right after a number or a word (`150円`, `HOMEと`) is prose.
      if (prev !== undefined && (isNumber(prev) || /[A-Za-z]/.test(prev))) return false;
      japaneseOutsideText = true;
    }
  }
  return !japaneseOutsideText || content.some((c) => "=\\^_".includes(c));
}

// MARK: Environments without delimiters

const MATH_ENVIRONMENTS = new Set([
  "align", "align*", "alignat", "alignat*", "alignedat", "flalign", "flalign*", "eqnarray*", "gather*", "gathered",
  "multline", "multline*", "array", "smallmatrix", "subarray", "cases*", "dcases", "dcases*", "rcases",
  "equation", "equation*", "displaymath",
  "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases", "aligned", "split", "gather", "eqnarray",
]);

const BEGIN = Array.from("\\begin{");

function mathEnvironmentBegin(chars, start) {
  if (!startsAt(BEGIN, chars, start)) return null;
  const window = chars.slice(start + BEGIN.length, start + BEGIN.length + 14);
  const closeOffset = window.indexOf("}");
  if (closeOffset < 0) return null;
  const close = start + BEGIN.length + closeOffset;
  const name = chars.slice(start + BEGIN.length, close).join("");
  return MATH_ENVIRONMENTS.has(name) ? { name, end: close + 1 } : null;
}

function environmentEnd(chars, name, from) {
  const open = Array.from(`\\begin{${name}}`);
  const close = Array.from(`\\end{${name}}`);
  let depth = 1;
  let i = from;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "`") return null;
    if (c !== "\\") { i++; continue; }
    if (startsAt(close, chars, i)) {
      depth--;
      if (depth === 0) return { start: i, end: i + close.length };
      i += close.length;
    } else if (startsAt(open, chars, i)) {
      depth++;
      i += open.length;
    } else {
      i += 2;
    }
  }
  return null;
}

/** A math environment opening the line at `index` without `$$`, to its `\end` over at most 40 lines. */
function bareEnvironment(ls, fenced, index) {
  if (fenced[index]) return null;
  const first = trimWS(splitPrefix(ls[index]).content);
  if (!first.startsWith("\\begin{")) return null;
  let chars = Array.from(first);
  const begin = mathEnvironmentBegin(chars, 0);
  if (!begin) return null;
  const lineEnds = [chars.length];
  let line = index;
  for (;;) {
    if (chars.includes("`")) return null;
    const close = environmentEnd(chars, begin.name, begin.end);
    if (close) {
      let closing = lineEnds.findIndex((end) => close.end <= end);
      if (closing < 0) closing = lineEnds.length - 1;
      const tail = trimWS(chars.slice(close.end, lineEnds[closing]).join(""));
      return { end: index + closing, endsLine: tail === "" || tail === "." || tail === ",", body: chars.slice(begin.end, close.start) };
    }
    line++;
    if (line >= ls.length) return { end: null, endsLine: false, body: chars.slice(begin.end) };
    if (line - index >= 40 || fenced[line] || isBlank(ls[line])) return null;
    chars = chars.concat(["\n"], Array.from(trimWS(splitPrefix(ls[line]).content)));
    lineEnds.push(chars.length);
  }
}

function openBareEnvironment(ls, fenced) {
  const closedMath = mathBlockLines(ls, fenced);
  let i = ls.length;
  while (i > 0 && !isBlank(ls[i - 1]) && !fenced[i - 1] && !closedMath[i - 1]) i--;
  while (i < ls.length) {
    const env = bareEnvironment(ls, fenced, i);
    if (!env) { i++; continue; }
    if (env.end === null) return i;
    i = env.end + 1;
  }
  return null;
}

function isMathBody(body, ownLines) {
  if (!body.some((c) => !isSpace(c))) return false;
  const rows = body.includes("&") || find(["\\", "\\"], body, 0) >= 0;
  if (ownLines && rows) return true;
  return (rows || looksLikeLaTeX(body)) && isLikelyMath(body);
}

/** Whether each line is inside a `$$` or `\[` block that has its closing line, delimiters included. */
function mathBlockLines(ls, fenced) {
  const result = new Array(ls.length).fill(false);
  for (let i = 0; i < ls.length; i++) {
    if (fenced[i]) continue;
    const trimmed = trimWS(splitPrefix(ls[i]).content);
    const delimiters = blockMathDelimiters(trimmed);
    if (!delimiters) continue;
    if (trimmed.length > delimiters[0].length && trimmed.slice(delimiters[0].length).includes(delimiters[1])) continue;
    let end = -1;
    for (let j = i + 1; j < ls.length; j++) {
      if (!fenced[j] && trimWS(splitPrefix(ls[j]).content).endsWith(delimiters[1])) { end = j; break; }
    }
    if (end < 0) continue;
    for (let k = i; k <= end; k++) result[k] = true;
    i = end;
  }
  return result;
}

function openMathBlock(ls, fenced) {
  const closed = mathBlockLines(ls, fenced);
  for (let i = ls.length - 1; i >= 0; i--) {
    if (fenced[i] || closed[i]) continue;
    const { prefix, content } = splitPrefix(ls[i]);
    const trimmed = trimWS(content);
    const delimiters = blockMathDelimiters(trimmed);
    if (!delimiters) continue;
    const [open, close] = delimiters;
    if (trimmed.length > open.length && trimmed.slice(open.length).includes(close)) return null;
    return prefix + close;
  }
  return null;
}

// MARK: Tables

/**
 * Trailing table lines wait until the table has its delimiter row; a row
 * still arriving shows as far as it has come once a cell has something in
 * it, so a row once shown never goes again.
 */
function holdBackTableRows(ls) {
  let start = ls.length;
  while (start > 0 && trimWS(ls[start - 1]).startsWith("|")) start--;
  if (start >= ls.length) return;
  const rows = ls.slice(start).map(trimWS);
  const headed = rows.length > 2 || (rows.length === 2 && rows[1].endsWith("|") && tableCells(rows[1]) === tableCells(rows[0]));
  if (!headed || !isTableDelimiter(rows[1])) { ls.splice(start); return; }
  if (rows.length > 2 && !/[^|\s]/u.test(rows[rows.length - 1])) ls.pop();
}

function isTableDelimiter(row) {
  return row.includes("-") && (row.match(/\|/g)?.length ?? 0) >= 2 && /^[|\-: ]*$/.test(row);
}

function tableCells(row) {
  const pipes = [];
  let escaped = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "|" && !escaped) pipes.push(i);
    escaped = row[i] === "\\" && !escaped;
  }
  let count = pipes.length + 1;
  if (pipes[0] === 0) count--;
  if (pipes.length && pipes[pipes.length - 1] === row.length - 1 && row.length > 1) count--;
  return count;
}

/**
 * Where a paced step that would end `end` characters into `text` ends
 * instead around a table's head: the header and its delimiter row are
 * taken whole, so the header fades in as soon as it has come.
 */
export function tableHeadEnd(text, end) {
  if (!text.includes("|")) return end;
  const ls = text.split("\n");
  const fenced = text.includes("```") || text.includes("~~~") ? fencedLines(ls) : null;
  const isRow = (i) => i >= 0 && i < ls.length && fenced?.[i] !== true && ls[i].replace(/^[ \t]+/, "")[0] === "|";
  let offset = 0;
  for (let i = 0; i < ls.length; i++) {
    const last = i === ls.length - 1;
    const after = offset + ls[i].length + (last ? 0 : 1);
    if (after >= end) {
      const header = isRow(i) && !isRow(i - 1);
      const delimiter = isRow(i) && isRow(i - 1) && !isRow(i - 2);
      if (!header && !delimiter) return end;
      const row = header ? i + 1 : i;
      if (row >= ls.length || (row === ls.length - 1 && ls[row] === "")) return Math.max(end, text.length);
      const delimiterRow = trimWS(ls[row]);
      if (row === ls.length - 1) {
        if (!isRow(row) || !/^[|\-: ]*$/.test(delimiterRow)) return end;
        return Math.max(end, text.length);
      }
      if (!isRow(row) || !isTableDelimiter(delimiterRow)) return end;
      const rowStart = header ? after : offset;
      return Math.max(end, rowStart + ls[row].length + 1);
    }
    offset = after;
  }
  return end;
}

// MARK: Pacing

const SYNTAX = new Set(["*", "_", "`", "$", "\\", "#", "|", "[", "]", "(", ")", "{", "}", "~", "<", ">", "!", "^"]);

/** The step's end, moved past any syntax it would end inside, and never inside a surrogate pair. */
export function wholeSyntax(text, end) {
  let i = end;
  // Inside a backslash command's name?
  let j = i;
  while (j > 0 && /[A-Za-z]/.test(text[j - 1])) j--;
  let command = j > 0 && text[j - 1] === "\\";
  while (i < text.length) {
    const next = text[i];
    if (SYNTAX.has(next)) command = next === "\\";
    else if (!(command && /[A-Za-z]/.test(next))) break;
    i++;
  }
  const code = text.charCodeAt(i - 1);
  if (code >= 0xD800 && code <= 0xDBFF) i++;
  // A combining mark or a joiner goes with what it belongs to.
  while (i < text.length && /[\p{M}‍️]/u.test(text[i])) i++;
  return Math.min(i, text.length);
}
