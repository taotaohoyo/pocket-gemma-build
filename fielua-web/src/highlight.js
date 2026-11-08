// Code colours, ported from the iPhone app's SyntaxHighlighter
// (PocketCore/SyntaxHighlighter.swift): a small scanner per language
// family, the same keywords, the same token kinds, the same names in the
// code block's header. The tokens always join back into the code exactly
// as written, so copying is unaffected. Output is escaped HTML.

export const MAXIMUM_LENGTH = 200_000;

const words = (list) => new Set(list.split(" "));

const C_KEYWORDS = "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr";
const JS_KEYWORDS = "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set null undefined true false NaN Infinity from as";

const SLASH = ["//"];
const C_BLOCK = [["/*", "*/"]];

function grammar(g) {
  return {
    keywords: new Set(), types: new Set(), lineComments: [], blockComments: [], strings: ['"', "'"], multilineStrings: [],
    capitalizedTypes: true, caseInsensitive: false, attributePrefixes: "", identifierExtras: "", variablePrefix: null,
    colonKeys: false, hashNumbers: false, macroBang: false, ...g,
  };
}

/** `language-python`, `{.python}`, `python:main.py` and `py title=x` all name a language by their first word. */
export function normalizedHint(hint) {
  if (typeof hint !== "string") return null;
  let word = hint.trim().toLowerCase().split(/\s+/)[0] ?? "";
  word = word.replace(/^[{}.]+|[{}.]+$/g, "");
  for (const prefix of ["language-", "lang-"]) if (word.startsWith(prefix)) word = word.slice(prefix.length);
  const colon = word.indexOf(":");
  if (colon > 0) word = word.slice(0, colon);
  return word || null;
}

const PLAIN_NAMES = {
  toml: "TOML", ini: "INI", cfg: "INI", dockerfile: "Dockerfile", docker: "Dockerfile", makefile: "Makefile", make: "Makefile",
  powershell: "PowerShell", ps1: "PowerShell", pwsh: "PowerShell", graphql: "GraphQL", gql: "GraphQL", proto: "Protocol Buffers",
  protobuf: "Protocol Buffers", scala: "Scala", haskell: "Haskell", hs: "Haskell", tex: "TeX", latex: "LaTeX", zig: "Zig",
  cmake: "CMake", text: "テキスト", txt: "テキスト", plaintext: "テキスト", plain: "テキスト", csv: "CSV", tsv: "TSV", nginx: "nginx",
  elixir: "Elixir", erlang: "Erlang", clojure: "Clojure", perl: "Perl", julia: "Julia", matlab: "MATLAB", asm: "アセンブリ",
  assembly: "アセンブリ", vb: "Visual Basic", vba: "VBA", fortran: "Fortran", groovy: "Groovy", gradle: "Gradle",
  terraform: "Terraform", hcl: "HCL", solidity: "Solidity", verilog: "Verilog", vhdl: "VHDL", regex: "正規表現", mermaid: "Mermaid",
  env: ".env", properties: "Properties", http: "HTTP", applescript: "AppleScript", ocaml: "OCaml", fsharp: "F#", "f#": "F#",
  elm: "Elm", lisp: "Lisp", scheme: "Scheme", prolog: "Prolog", cobol: "COBOL", pascal: "Pascal", nim: "Nim", crystal: "Crystal",
};

export function language(hint) {
  const name = normalizedHint(hint);
  if (!name) return null;
  switch (name) {
    case "swift":
      return { name: "Swift", mode: "code", grammar: grammar({
        keywords: words("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any await async false is nil self Self super throws true try some any actor nonisolated isolated mutating nonmutating override final lazy weak unowned convenience required dynamic indirect optional get set willSet didSet package macro consuming borrowing"),
        lineComments: SLASH, blockComments: C_BLOCK, strings: ['"'], multilineStrings: ['"""'], attributePrefixes: "@#" }) };
    case "python": case "py": case "python3": case "py3":
      return { name: "Python", mode: "code", grammar: grammar({
        keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case False None True self"),
        types: words("int float str bool list dict set tuple bytes object type range complex frozenset"),
        lineComments: ["#"], multilineStrings: ['"""', "'''"], attributePrefixes: "@" }) };
    case "javascript": case "js": case "jsx": case "mjs": case "cjs": case "node":
      return { name: "JavaScript", mode: "code", grammar: grammar({
        keywords: words(JS_KEYWORDS), lineComments: SLASH, blockComments: C_BLOCK, multilineStrings: ["`"], attributePrefixes: "@", identifierExtras: "$" }) };
    case "typescript": case "ts": case "tsx":
      return { name: "TypeScript", mode: "code", grammar: grammar({
        keywords: words(JS_KEYWORDS + " interface type enum implements namespace declare abstract private protected public readonly is keyof infer satisfies override"),
        types: words("string number boolean any unknown never void object symbol bigint"),
        lineComments: SLASH, blockComments: C_BLOCK, multilineStrings: ["`"], attributePrefixes: "@", identifierExtras: "$" }) };
    case "java":
      return { name: "Java", mode: "code", grammar: grammar({
        keywords: words("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield true false null"),
        types: words("int long short byte char float double boolean void"),
        lineComments: SLASH, blockComments: C_BLOCK, multilineStrings: ['"""'], attributePrefixes: "@" }) };
    case "kotlin": case "kt": case "kts":
      return { name: "Kotlin", mode: "code", grammar: grammar({
        keywords: words("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by catch constructor finally get import init set where abstract annotation companion const data enum external final infix inline inner internal lateinit open operator out override private protected public reified sealed suspend tailrec vararg"),
        lineComments: SLASH, blockComments: C_BLOCK, multilineStrings: ['"""'], attributePrefixes: "@" }) };
    case "c": case "h":
      return { name: "C", mode: "code", grammar: grammar({
        keywords: words(C_KEYWORDS), types: words("size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE"),
        lineComments: SLASH, blockComments: C_BLOCK, capitalizedTypes: false, attributePrefixes: "#" }) };
    case "cpp": case "c++": case "cc": case "cxx": case "hpp": case "hh":
      return { name: "C++", mode: "code", grammar: grammar({
        keywords: words(C_KEYWORDS + " alignas alignof and asm catch class constexpr const_cast decltype delete dynamic_cast explicit export friend mutable namespace new noexcept operator or not private protected public reinterpret_cast static_assert static_cast template this thread_local throw try typeid typename using virtual co_await co_return co_yield concept requires override final"),
        types: words("string vector map set unordered_map size_t auto"),
        lineComments: SLASH, blockComments: C_BLOCK, attributePrefixes: "#" }) };
    case "objective-c": case "objc": case "objectivec": case "m": case "mm":
      return { name: "Objective-C", mode: "code", grammar: grammar({
        keywords: words(C_KEYWORDS + " self super nil Nil YES NO id instancetype interface implementation end property synthesize protocol selector import nonatomic strong weak copy readonly"),
        lineComments: SLASH, blockComments: C_BLOCK, attributePrefixes: "#@" }) };
    case "csharp": case "cs": case "c#":
      return { name: "C#", mode: "code", grammar: grammar({
        keywords: words("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await record init get set yield where"),
        lineComments: SLASH, blockComments: C_BLOCK, attributePrefixes: "#" }) };
    case "go": case "golang":
      return { name: "Go", mode: "code", grammar: grammar({
        keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota"),
        types: words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 byte rune string bool error any"),
        lineComments: SLASH, blockComments: C_BLOCK, multilineStrings: ["`"] }) };
    case "rust": case "rs":
      return { name: "Rust", mode: "code", grammar: grammar({
        keywords: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
        types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str"),
        lineComments: SLASH, blockComments: C_BLOCK, strings: ['"'], macroBang: true }) };
    case "ruby": case "rb":
      return { name: "Ruby", mode: "code", grammar: grammar({
        keywords: words("alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor attr_reader puts"),
        lineComments: ["#"], attributePrefixes: "@" }) };
    case "php":
      return { name: "PHP", mode: "code", grammar: grammar({
        keywords: words("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global if implements include include_once instanceof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null"),
        lineComments: ["//", "#"], blockComments: C_BLOCK, variablePrefix: "$" }) };
    case "bash": case "sh": case "shell": case "zsh": case "console": case "terminal": case "shellscript": case "fish":
      return { name: "Shell", mode: "code", grammar: grammar({
        keywords: words("if then else elif fi case esac for select while until do done in function time return exit export local readonly declare unset shift break continue source alias echo cd sudo"),
        lineComments: ["#"], capitalizedTypes: false, identifierExtras: "-", variablePrefix: "$" }) };
    case "sql": case "mysql": case "postgresql": case "postgres": case "sqlite": case "plsql":
      return { name: "SQL", mode: "code", grammar: grammar({
        keywords: words("select from where and or not insert into values update set delete create table drop alter add column primary key foreign references index view join inner left right outer full on group by order having limit offset as distinct union all exists in is null like between case when then else end default unique check constraint begin commit rollback transaction if returning with asc desc true false"),
        types: words("integer int text varchar char boolean real date timestamp numeric decimal serial bigint"),
        lineComments: ["--"], blockComments: C_BLOCK, strings: ["'", '"'], capitalizedTypes: false, caseInsensitive: true }) };
    case "json": case "jsonc": case "json5":
      return { name: "JSON", mode: "code", grammar: grammar({
        keywords: words("true false null"), lineComments: SLASH, blockComments: C_BLOCK, strings: ['"'], capitalizedTypes: false, colonKeys: true }) };
    case "yaml": case "yml":
      return { name: "YAML", mode: "code", grammar: grammar({
        keywords: words("true false null yes no on off"), lineComments: ["#"], capitalizedTypes: false, identifierExtras: "-", colonKeys: true }) };
    case "css": case "scss": case "less":
      return { name: "CSS", mode: "code", grammar: grammar({
        keywords: words("important inherit initial unset auto none"), lineComments: name === "css" ? [] : SLASH, blockComments: C_BLOCK,
        capitalizedTypes: false, attributePrefixes: "@", identifierExtras: "-", colonKeys: true, hashNumbers: true }) };
    case "dart":
      return { name: "Dart", mode: "code", grammar: grammar({
        keywords: words("abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield"),
        lineComments: SLASH, blockComments: C_BLOCK, multilineStrings: ['"""', "'''"], attributePrefixes: "@" }) };
    case "lua":
      return { name: "Lua", mode: "code", grammar: grammar({
        keywords: words("and break do else elseif end false for function goto if in local nil not or repeat return then true until while"),
        lineComments: ["--"], blockComments: [["--[[", "]]"]], capitalizedTypes: false }) };
    case "r":
      return { name: "R", mode: "code", grammar: grammar({
        keywords: words("if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA return library"), lineComments: ["#"], capitalizedTypes: false }) };
    case "html": case "xml": case "svg": case "xhtml": case "plist": case "vue": case "xaml":
      return { name: name === "xml" || name === "plist" ? "XML" : "HTML", mode: "markup" };
    case "diff": case "patch":
      return { name: "Diff", mode: "diff" };
    case "markdown": case "md":
      return { name: "Markdown", mode: "markdown" };
    default:
      return null;
  }
}

/** The language's name for the code block header, or null when unknown. */
export function displayName(hint) {
  const found = language(hint);
  if (found) return found.name;
  const name = normalizedHint(hint);
  return name ? PLAIN_NAMES[name] ?? null : null;
}

const SHELL_COMMANDS = new Set(("brew npm npx yarn pnpm pip pip3 git cd sudo apt apt-get curl wget mkdir ls export echo chmod docker xcodebuild cargo make ssh rm cp mv touch cat source conda pod gem bundle kubectl xcrun defaults open").split(" "));

/** A language for code that names none, from unmistakable signs only. Null when nothing is certain. */
export function detectedLanguage(code) {
  const sample = code.slice(0, 4000);
  const trimmed = sample.trim();
  if (trimmed.length <= 1) return null;
  const lines = trimmed.split("\n").slice(0, 40).map((line) => line.trim()).filter(Boolean);
  const any = (test) => lines.some(test);
  const first = lines[0] ?? "";
  if (first.startsWith("#!")) {
    if (first.includes("python")) return "python";
    if (first.includes("node")) return "javascript";
    if (first.includes("ruby")) return "ruby";
    if (first.includes("sh")) return "bash";
    return null;
  }
  if (trimmed.startsWith("diff --git") || (any((l) => l.startsWith("@@ ") && l.slice(3).includes("@@")) && any((l) => l.startsWith("--- ") || l.startsWith("+++ ")))) return "diff";
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("<?xml")) return "xml";
  if (lowered.startsWith("<!doctype html") || lowered.startsWith("<html")) return "html";
  if ((trimmed[0] === "{" || trimmed[0] === "[") && code.length <= 100_000) {
    try { JSON.parse(code.trim()); return "json"; } catch { /* not JSON */ }
  }
  const firstWord = (first.split(" ")[0] ?? "").toUpperCase();
  const upper = trimmed.toUpperCase();
  if (["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "WITH"].includes(firstWord)
    && [" FROM ", " INTO ", " TABLE ", " SET ", "\nFROM ", "\nSET "].some((w) => upper.includes(w))) return "sql";
  if (any((l) => l.startsWith("package ")) && trimmed.includes("func ")) return "go";
  if (any((l) => ["import SwiftUI", "import UIKit", "import Foundation", "import Combine"].includes(l))
    || (trimmed.includes("func ") && trimmed.includes("->") && !trimmed.includes("fn "))) return "swift";
  if (trimmed.includes("fn main()") || (trimmed.includes("fn ") && trimmed.includes("let mut "))) return "rust";
  if (trimmed.includes("public static void main") || any((l) => l.startsWith("public class "))) return "java";
  if (any((l) => l.startsWith("#include"))) return trimmed.includes("std::") || trimmed.includes("<iostream>") ? "cpp" : "c";
  if (any((l) => (l.startsWith("def ") || l.startsWith("class ")) && l.endsWith(":"))
    || any((l) => l.startsWith("from ") && l.includes(" import "))
    || (any((l) => l.startsWith("import ")) && trimmed.includes("print("))) return "python";
  if (trimmed.includes("console.log(")
    || (any((l) => l.startsWith("const ") || l.startsWith("let ")) && (trimmed.includes("=>") || trimmed.includes("function ")))) return "javascript";
  const commands = lines.filter((l) => !l.startsWith("#"));
  if (commands.length > 0 && commands.length <= 20 && commands.every((line) =>
    line.startsWith("$ ") || (SHELL_COMMANDS.has(line.split(" ")[0] ?? "") && !line.endsWith(";") && !line.endsWith("{")))) return "bash";
  return null;
}

// MARK: Scanning

const LETTER = /[\p{L}_]/u;
const UPPER = /\p{Lu}/u;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;
const isLetter = (c) => c !== undefined && LETTER.test(c);
const isDigit = (c) => c !== undefined && DIGIT.test(c);

class Scanner {
  constructor(code) {
    // By code point, as the app scans Unicode scalars.
    this.s = Array.from(code);
    this.tokens = [];
  }
  emit(kind, start, end) {
    if (end <= start) return;
    const text = this.s.slice(start, end).join("");
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.tokens.push({ kind, text });
  }
  starts(pattern, at) {
    if (!pattern.length || at + pattern.length > this.s.length) return false;
    for (let i = 0; i < pattern.length; i++) if (this.s[at + i] !== pattern[i]) return false;
    return true;
  }
  find(pattern, from) {
    for (let p = from; p + pattern.length <= this.s.length; p++) if (this.starts(pattern, p)) return p;
    return -1;
  }
  nextNonSpace(after) {
    let p = after;
    while (p < this.s.length && (this.s[p] === " " || this.s[p] === "\t")) p++;
    return this.s[p];
  }

  code(g) {
    const s = this.s;
    const blockComments = g.blockComments.map(([open, close]) => [Array.from(open), Array.from(close)]);
    const lineComments = g.lineComments.map((m) => Array.from(m));
    const multiline = g.multilineStrings.map((m) => Array.from(m));
    const delimiters = [...multiline, ...g.strings.map((m) => Array.from(m))].sort((a, b) => b.length - a.length);
    const multilineKeys = new Set(g.multilineStrings);
    const ident = (c) => isLetter(c) || isDigit(c) || (c !== undefined && g.identifierExtras.includes(c));
    let i = 0;
    let plain = 0;
    scanning: while (i < s.length) {
      const c = s[i];
      for (const [open, close] of blockComments) {
        if (!this.starts(open, i)) continue;
        this.emit("plain", plain, i);
        const found = this.find(close, i + open.length);
        const end = found < 0 ? s.length : found + close.length;
        this.emit("comment", i, end);
        i = end; plain = end;
        continue scanning;
      }
      for (const marker of lineComments) {
        if (!this.starts(marker, i)) continue;
        this.emit("plain", plain, i);
        let end = i;
        while (end < s.length && s[end] !== "\n") end++;
        this.emit("comment", i, end);
        i = end; plain = end;
        continue scanning;
      }
      for (const delimiter of delimiters) {
        if (!this.starts(delimiter, i)) continue;
        this.emit("plain", plain, i);
        const spansLines = multilineKeys.has(delimiter.join(""));
        let end = i + delimiter.length;
        while (end < s.length) {
          if (s[end] === "\\") { end += 2; continue; }
          if (this.starts(delimiter, end)) { end += delimiter.length; break; }
          if (s[end] === "\n" && !spansLines) break;
          end++;
        }
        end = Math.min(end, s.length);
        const isKey = g.colonKeys && this.nextNonSpace(end) === ":";
        this.emit(isKey ? "property" : "string", i, end);
        i = end; plain = end;
        continue scanning;
      }
      const previous = i > 0 ? s[i - 1] : undefined;
      const followedByDigit = isDigit(s[i + 1]);
      if ((isDigit(c) || (c === "." && followedByDigit) || (g.hashNumbers && c === "#" && s[i + 1] !== undefined && HEX.test(s[i + 1])))
        && !(previous !== undefined && ident(previous))) {
        this.emit("plain", plain, i);
        let end = i + 1;
        const hex = s[i] === "0" && s[i + 1] === "x";
        while (end < s.length) {
          const next = s[end];
          if (ident(next) || next === ".") { end++; continue; }
          if ((next === "+" || next === "-") && (s[end - 1] === "e" || s[end - 1] === "E") && !hex) { end++; continue; }
          break;
        }
        this.emit("number", i, end);
        i = end; plain = end;
        continue;
      }
      if (g.variablePrefix && c === g.variablePrefix && i + 1 < s.length && (ident(s[i + 1]) || s[i + 1] === "{")) {
        this.emit("plain", plain, i);
        let end = i + 1;
        if (s[end] === "{") {
          while (end < s.length && s[end] !== "}" && s[end] !== "\n") end++;
          end = Math.min(end + 1, s.length);
        } else {
          while (end < s.length && ident(s[end])) end++;
        }
        this.emit("property", i, end);
        i = end; plain = end;
        continue;
      }
      if (g.attributePrefixes.includes(c) && isLetter(s[i + 1]) && !(previous !== undefined && ident(previous))) {
        this.emit("plain", plain, i);
        let end = i + 1;
        while (end < s.length && ident(s[end])) end++;
        this.emit("attribute", i, end);
        i = end; plain = end;
        continue;
      }
      if (isLetter(c) || (g.identifierExtras.includes(c) && c !== "-")) {
        this.emit("plain", plain, i);
        let end = i + 1;
        while (end < s.length && ident(s[end])) end++;
        const text = s.slice(i, end).join("");
        const key = g.caseInsensitive ? text.toLowerCase() : text;
        const next = this.nextNonSpace(end);
        let kind;
        if (g.keywords.has(key)) kind = "keyword";
        else if (g.types.has(key)) kind = "type";
        else if (g.colonKeys && next === ":" && s[end + 1] !== ":") kind = "property";
        else if (g.capitalizedTypes && UPPER.test(text[0]) && Array.from(text).length > 1) kind = "type";
        else if (next === "(" || (g.macroBang && s[end] === "!")) kind = "function";
        else kind = "plain";
        this.emit(kind, i, end);
        i = end; plain = end;
        continue;
      }
      i++;
    }
    this.emit("plain", plain, s.length);
  }

  markup() {
    const s = this.s;
    const open = Array.from("<!--"), close = Array.from("-->");
    const nameChar = (c) => isLetter(c) || isDigit(c) || (c !== undefined && ":-.".includes(c));
    let i = 0;
    let plain = 0;
    while (i < s.length) {
      if (this.starts(open, i)) {
        this.emit("plain", plain, i);
        const found = this.find(close, i + 4);
        const end = found < 0 ? s.length : found + 3;
        this.emit("comment", i, end);
        i = end; plain = end;
        continue;
      }
      if (!(s[i] === "<" && i + 1 < s.length && (isLetter(s[i + 1]) || "/?!".includes(s[i + 1])))) { i++; continue; }
      this.emit("plain", plain, i);
      let end = i + 1;
      while (end < s.length && "/?!".includes(s[end])) end++;
      while (end < s.length && nameChar(s[end])) end++;
      this.emit("tag", i, end);
      i = end;
      while (i < s.length && s[i] !== ">") {
        const c = s[i];
        if (c === '"' || c === "'") {
          let to = i + 1;
          while (to < s.length && s[to] !== c) to++;
          to = Math.min(to + 1, s.length);
          this.emit("string", i, to);
          i = to;
        } else if (isLetter(c)) {
          let to = i + 1;
          while (to < s.length && nameChar(s[to])) to++;
          this.emit("attribute", i, to);
          i = to;
        } else {
          this.emit("plain", i, i + 1);
          i++;
        }
      }
      if (i < s.length) { this.emit("tag", i, i + 1); i++; }
      plain = i;
    }
    this.emit("plain", plain, s.length);
  }

  lines(diff) {
    const s = this.s;
    let start = 0;
    while (start < s.length) {
      let end = start;
      while (end < s.length && s[end] !== "\n") end++;
      const lineEnd = Math.min(end + 1, s.length);
      const first = start < end ? s[start] : undefined;
      let kind = "plain";
      if (diff) {
        if (this.starts(Array.from("+++"), start) || this.starts(Array.from("---"), start)
          || this.starts(Array.from("diff "), start) || this.starts(Array.from("index "), start)) kind = "comment";
        else if (first === "+") kind = "inserted";
        else if (first === "-") kind = "deleted";
        else if (this.starts(Array.from("@@"), start)) kind = "keyword";
      } else {
        kind = first === "#" ? "heading" : first === ">" ? "comment" : "plain";
      }
      this.emit(kind, start, lineEnd);
      start = lineEnd;
    }
  }
}

/** The code's tokens by kind; one plain token for an unknown language or very long code. */
export function tokens(code, hint) {
  if (!code) return [];
  const found = code.length <= MAXIMUM_LENGTH ? language(hint) : null;
  if (!found) return [{ kind: "plain", text: code }];
  const scanner = new Scanner(code);
  if (found.mode === "code") scanner.code(found.grammar);
  else if (found.mode === "markup") scanner.markup();
  else scanner.lines(found.mode === "diff");
  return scanner.tokens;
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHTML = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The code as escaped HTML, coloured by `tk-*` classes. */
export function highlightHTML(code, hint) {
  return tokens(code, hint).map(({ kind, text }) => kind === "plain" ? escapeHTML(text) : `<span class="tk-${kind}">${escapeHTML(text)}</span>`).join("");
}
