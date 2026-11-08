// What the person attaches, made ready in the browser before it is sent:
// photos made smaller (and without their location and other metadata),
// a video as a few still frames (Claude takes no video or sound), PDFs as
// they are, and text files as text. Only these leave the page, through the
// relay, which checks each again (claude-relay/src/turns.ts).

/** A photo's long edge: what Claude reads without making it smaller. */
const PHOTO_EDGE = 1568;
const PHOTO_QUALITY = 0.8;
/** A video's frames. */
const FRAME_EDGE = 768;
const FRAME_QUALITY = 0.72;
/** The picture shown in the chat (twice its size on screen, for sharp screens). */
const THUMB_EDGE = 440;
const THUMB_QUALITY = 0.7;
/** One text file, in UTF-8 bytes (the relay takes 256 KB). */
const TEXT_MAX_BYTES = 250 * 1024;

export const LIMITS = {
  /** Attachments on one message. */
  perMessage: 10,
  /** What one message's attachments become on the wire (the relay takes 40 a turn). */
  partsPerMessage: 40,
  /** Images in the whole request (the relay and Anthropic take 100). */
  images: 100,
  /** PDFs and text files in the whole request (the relay takes 20). */
  documents: 20,
  /** All text files together (the relay takes 512 KB). */
  textBytes: 500 * 1024,
};

export class AttachError extends Error {}

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
const VIDEO_NAME = /\.(mov|mp4|m4v|webm|3gp)$/i;
const OFFICE_NAME = /\.(docx?|xlsx?|pptx?|pages|numbers|key|odt|ods|odp|rtf|hwp)$/i;
const TEXT_NAME = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|ndjson|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|m|mm|cs|php|sh|zsh|bash|ps1|bat|sql|ya?ml|toml|ini|cfg|conf|log|tex|bib|srt|vtt|r|lua|pl|scala|dart|vue|svelte|gradle|properties)$/i;

/** The kinds a picker or a drop may bring. */
export function kindOf(file) {
  const type = file.type || "";
  const name = file.name || "";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (type.startsWith("image/") || IMAGE_NAME.test(name)) return "image";
  if (type.startsWith("video/") || VIDEO_NAME.test(name)) return "video";
  if (OFFICE_NAME.test(name)) return "office";
  if (type.startsWith("text/") || TEXT_NAME.test(name) || /^application\/(json|xml|x-yaml|x-sh|javascript)$/.test(type)) return "text";
  return "other";
}

/** What the file pickers offer. */
export const ACCEPT = {
  photos: "image/*",
  videos: "video/*",
  files: "application/pdf,.pdf,text/*,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.html,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.m,.cs,.php,.sh,.sql,.yaml,.yml,.toml,.ini,.log,.tex,.srt,.vtt",
};

const id = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** A short name for captions: Claude sees it, so control characters are gone. */
function shortName(name) {
  const clean = String(name || "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > 60 ? `${chars.slice(0, 57).join("")}…` : clean || "名前なし";
}

/** A size; a limit is rounded down, so a file of that size is sure to fit. */
export function sizeLabel(bytes, limit = false) {
  const round = limit ? Math.floor : Math.round;
  if (bytes < 1024 * 1024) return `${Math.max(1, round(bytes / 1024))} KB`;
  return `${(round((bytes / 1024 / 1024) * 10) / 10).toFixed(1)} MB`;
}

export function timeLabel(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

// MARK: Pictures

function canvasFor(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

/** The source drawn on white (no transparency in a JPEG) at most `edge` long. */
function drawn(source, width, height, edge) {
  const canvas = canvasFor(width, height, edge);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function jpegData(canvas, quality) {
  const url = canvas.toDataURL("image/jpeg", quality);
  const data = url.slice(url.indexOf(",") + 1);
  if (!url.startsWith("data:image/jpeg;base64,") || data.length < 16) throw new AttachError("写真を変換できませんでした。");
  return data;
}

async function decodedImage(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new AttachError(/\.(heic|heif)$/i.test(file.name) ? `「${shortName(file.name)}」を読み込めません。このブラウザは HEIC に対応していません。` : `「${shortName(file.name)}」を写真として読み込めません。`);
  }
  URL.revokeObjectURL(url);
  if (!image.naturalWidth || !image.naturalHeight) throw new AttachError(`「${shortName(file.name)}」を写真として読み込めません。`);
  return image;
}

async function photo(file) {
  const image = await decodedImage(file);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const data = jpegData(drawn(image, width, height, PHOTO_EDGE), PHOTO_QUALITY);
  const thumb = drawn(image, width, height, THUMB_EDGE);
  return {
    id: id(), kind: "image", name: file.name || "写真",
    parts: [{ type: "image", mediaType: "image/jpeg", data }],
    chars: data.length, images: 1, documents: 0, textBytes: 0,
    thumb: thumb.toDataURL("image/jpeg", THUMB_QUALITY), width, height,
  };
}

// MARK: Video

function once(target, event, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new AttachError(what)); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new AttachError(what)); };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener("error", bad);
    };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener("error", bad, { once: true });
  });
}

/** How many scenes a video of this length is sent as. */
export function sceneCount(duration) {
  if (duration < 4) return 3;
  if (duration < 15) return 4;
  if (duration < 40) return 6;
  return 8;
}

async function video(file) {
  const name = shortName(file.name || "動画");
  const unreadable = `「${name}」を動画として読み込めません。`;
  const url = URL.createObjectURL(file);
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.setAttribute("playsinline", "");
  element.preload = "auto";
  element.src = url;
  try {
    if (element.readyState < 1) await once(element, "loadedmetadata", 20000, unreadable);
    const duration = element.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !element.videoWidth) throw new AttachError(unreadable);
    if (element.readyState < 2) await once(element, "loadeddata", 20000, unreadable);
    // Safari on iPhone draws a frame only once the video has played.
    try { await element.play(); } catch { /* not allowed: seeking still works on most */ }
    element.pause();
    const count = sceneCount(duration);
    const width = element.videoWidth;
    const height = element.videoHeight;
    const parts = [];
    let thumb = "";
    for (let index = 0; index < count; index++) {
      const time = Math.min(duration - 0.05, (duration * (index + 0.5)) / count);
      element.currentTime = Math.max(0, time);
      await once(element, "seeked", 15000, unreadable);
      const data = jpegData(drawn(element, width, height, FRAME_EDGE), FRAME_QUALITY);
      if (index === 0) thumb = drawn(element, width, height, THUMB_EDGE).toDataURL("image/jpeg", THUMB_QUALITY);
      const caption = index === 0
        ? `動画「${name}」（長さ ${timeLabel(duration)}、音声なし）から ${count} 場面。${timeLabel(time)} の場面`
        : `動画「${name}」 ${timeLabel(time)} の場面`;
      parts.push({ type: "image", mediaType: "image/jpeg", data, caption });
    }
    return {
      id: id(), kind: "video", name: file.name || "動画",
      parts, chars: parts.reduce((sum, part) => sum + part.data.length, 0), images: count, documents: 0, textBytes: 0,
      thumb, width, height, duration, note: `音声なし・${count} 場面`,
      play: url,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof AttachError ? error : new AttachError(unreadable);
  } finally {
    element.removeAttribute("src");
    element.load();
  }
}

// MARK: Files

function base64(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(text);
}

async function pdf(file, maxChars) {
  const name = file.name || "PDF";
  const most = Math.floor((maxChars * 3) / 4);
  if (file.size > most) throw new AttachError(`「${shortName(name)}」は大きすぎます（${sizeLabel(file.size)}）。PDF は ${sizeLabel(most, true)} まで送れます。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d)) {
    throw new AttachError(`「${shortName(name)}」は PDF として読めません。`);
  }
  const data = base64(bytes);
  return {
    id: id(), kind: "pdf", name,
    parts: [{ type: "pdf", name, data }],
    chars: data.length, images: 0, documents: 1, textBytes: 0, size: file.size,
  };
}

/** UTF-8, else UTF-16 with its mark, else Shift_JIS (Windows' Japanese text). */
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try { return new TextDecoder("shift_jis", { fatal: true }).decode(bytes); } catch { return null; }
  }
}

const encoder = new TextEncoder();

async function textFile(file) {
  const name = file.name || "テキスト";
  if (file.size > TEXT_MAX_BYTES * 2) throw new AttachError(`「${shortName(name)}」は大きすぎます（${sizeLabel(file.size)}）。テキストは ${sizeLabel(TEXT_MAX_BYTES, true)} まで送れます。`);
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  // eslint-disable-next-line no-control-regex
  if (text === null || /\u0000/.test(text)) throw new AttachError(`「${shortName(name)}」はテキストとして読めません。`);
  if (!text.trim()) throw new AttachError(`「${shortName(name)}」は空です。`);
  const size = encoder.encode(text).length;
  if (size > TEXT_MAX_BYTES) throw new AttachError(`「${shortName(name)}」は大きすぎます（${sizeLabel(size)}）。テキストは ${sizeLabel(TEXT_MAX_BYTES, true)} まで送れます。`);
  return {
    id: id(), kind: "text", name,
    parts: [{ type: "text", name, text }],
    chars: 0, images: 0, documents: 1, textBytes: size, size: file.size,
  };
}

/**
 * One picked, pasted or dropped file, ready to send, or an AttachError
 * that says why not. `maxChars` is what one request may carry (the relay's
 * status), as base64.
 */
export async function prepare(file, maxChars) {
  switch (kindOf(file)) {
    case "image": return photo(file);
    case "video": return video(file);
    case "pdf": return pdf(file, maxChars);
    case "text": return textFile(file);
    case "office": throw new AttachError(`「${shortName(file.name)}」は送れません。PDF に書き出してから添付してください。`);
    default: throw new AttachError(`「${shortName(file.name)}」は送れない種類のファイルです。写真・動画・PDF・テキストを送れます。`);
  }
}

/** Frees what an attachment holds on the page (a video kept to play). */
export function release(attachment) {
  if (attachment?.play) URL.revokeObjectURL(attachment.play);
}

/** What the chat keeps in the tab's storage: the picture and the name, never the data. */
export function stored(attachment) {
  const { kind, name, thumb, width, height, duration, note, size } = attachment;
  return { kind, name, thumb, width, height, duration, note, size };
}
