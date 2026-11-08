// Builds Fielua for the web into dist/chat/, the folder that goes to
// https://suelira.com/chat/ as it is, and dist/fielua-web-chat.zip.
//
//   RELAY_URL=https://fielua-claude.<subdomain>.workers.dev node build.mjs
//
// The relay's address is the only setting, and it is not a secret: it is
// written into the script and into the page's Content Security Policy, so
// the page can talk to that relay and nowhere else. No key of any kind is
// ever built in.

import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, process.env.OUT_DIR ?? "dist", "chat");

const relay = (process.env.RELAY_URL ?? "").trim().replace(/\/+$/, "");
const local = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(relay);
if (!/^https:\/\/[a-z0-9.-]+$/.test(relay) && !local) {
  console.error("RELAY_URL must be the relay's https address, such as https://fielua-claude.example.workers.dev");
  process.exit(1);
}
const relayOrigin = new URL(relay).origin;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const hash = (data) => createHash("sha256").update(data).digest("hex");
const short = (data) => hash(data).slice(0, 10);

// Script: the app, with KaTeX in a chunk of its own loaded at the first formula.
const result = await build({
  entryPoints: [join(root, "src/app.js")],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: out,
  entryNames: "[name]-[hash]",
  chunkNames: "[name]-[hash]",
  minify: true,
  target: ["safari16.4", "chrome116", "firefox115", "edge116"],
  define: { __RELAY_URL__: JSON.stringify(relay) },
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});
const entry = Object.entries(result.metafile.outputs).find(([, info]) => info.entryPoint?.endsWith("src/app.js"))[0];
const script = relative(out, join(root, entry)).replace(/\\/g, "/");

// Styles: Fielua's, then KaTeX's with only its woff2 fonts.
const katexDir = join(root, "node_modules/katex/dist");
const katexCSS = readFileSync(join(katexDir, "katex.min.css"), "utf8")
  .replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, "")
  .replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, "");
const css = (await transform(`${readFileSync(join(root, "src/styles.css"), "utf8")}\n${katexCSS}`, { loader: "css", minify: true, legalComments: "eof" })).code;
const styles = `styles-${short(css)}.css`;
writeFileSync(join(out, styles), css);
mkdirSync(join(out, "fonts"));
for (const font of readdirSync(join(katexDir, "fonts")).filter((name) => name.endsWith(".woff2"))) {
  cpSync(join(katexDir, "fonts", font), join(out, "fonts", font));
}

// Images and the home-screen manifest.
cpSync(join(root, "src/assets"), join(out, "assets"), { recursive: true });
writeFileSync(join(out, "manifest.webmanifest"), JSON.stringify({
  name: "Fielua",
  short_name: "Fielua",
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#FAF7F1",
  theme_color: "#FAF7F1",
  lang: "ja",
  icons: [
    { src: "assets/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "assets/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
}, null, 2));

// The page may load only its own files and talk only to the relay.
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // Attachments: photos and videos are read on the page from the person's own files.
  "img-src 'self' data: blob:",
  "media-src blob:",
  "font-src 'self'",
  `connect-src ${relayOrigin}`,
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");
const html = readFileSync(join(root, "src/index.html"), "utf8")
  .replace("__CSP__", csp)
  .replace("__CSS__", styles)
  .replace("__JS__", script);
if (/__[A-Z]+__/.test(html)) throw new Error("a placeholder is left in index.html");
writeFileSync(join(out, "index.html"), html);

// Only this folder's own rules: the site's top .htaccess is never touched.
writeFileSync(join(out, ".htaccess"), `# Fielua for the web: rules for this folder (/chat/) only.
Options -Indexes
DirectoryIndex index.html

<IfModule mod_mime.c>
  AddType text/javascript .js
  AddType application/manifest+json .webmanifest
  AddType font/woff2 .woff2
</IfModule>

# Text files go compressed where the server can (a first visit loads about a third as much).
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/javascript application/javascript application/manifest+json
</IfModule>

<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${csp}; frame-ancestors 'none'"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "no-referrer"
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
  Header always set X-Robots-Tag "noindex, nofollow"
  <FilesMatch "\\.(html|webmanifest)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <FilesMatch "-[A-Za-z0-9]{8,10}\\.(js|css)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
</IfModule>
`);

// What was built, with SHA-256, next to the folder (not inside it).
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(out);
const sums = files.map((path) => `${hash(readFileSync(path))}  chat/${relative(out, path).replace(/\\/g, "/")}`).join("\n") + "\n";
writeFileSync(join(out, "..", "SHA256SUMS.txt"), sums);

// The forbidden check: no key-like text anywhere in what is published.
const leak = /(sk-ant-[A-Za-z0-9_-]{8,}|ADMIN_TOKEN\s*=|fcl_[A-Za-z0-9_-]{20,}|fws_[A-Za-z0-9_-]{20,})/;
for (const path of files) {
  if (/\.(js|css|html|htaccess|webmanifest)$/.test(path) || path.endsWith(".htaccess")) {
    const text = readFileSync(path, "utf8");
    if (leak.test(text)) throw new Error(`key-like text in ${path}`);
  }
}

const zip = join(out, "..", "fielua-web-chat.zip");
rmSync(zip, { force: true });
if (!process.env.NO_ZIP && existsSync("/usr/bin/zip")) {
  execFileSync("zip", ["-q", "-X", "-r", zip, "chat"], { cwd: join(out, "..") });
}
const size = files.reduce((sum, path) => sum + statSync(path).size, 0);
console.log(`built ${files.length} files (${Math.round(size / 1024)} KB) in ${relative(root, out)} for ${relayOrigin}`);
