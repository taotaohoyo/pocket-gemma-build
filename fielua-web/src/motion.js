// How things come and go. The stylesheet draws every motion (its tokens are
// the iPhone app's springs, tools/springs.mjs); this file only decides when
// an element is really gone: `hidden` and a dialog's close() wait for the
// "leaving" motion the stylesheet gives it, and never wait when it gives
// none or when the person asked for less motion.

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
/** "視差効果を減らす": things appear in their resting state. */
export const still = () => reduce.matches;

const seconds = (list) => list.split(",").map((value) => (value.trim().endsWith("ms") ? parseFloat(value) / 1000 : parseFloat(value) || 0));

const names = (style) => (style.animationName || "none").split(",").map((name) => name.trim()).filter((name) => name !== "none");

/** How long the element's animations run now, in ms. */
function length(style) {
  const durations = seconds(style.animationDuration);
  const delays = seconds(style.animationDelay);
  return Math.max(0, ...durations.map((duration, index) => duration + (delays[index % delays.length] ?? 0))) * 1000;
}

/** Plays the entrance the class `name` gives the element again, from its start. */
export function replay(element, name) {
  element.classList.remove(name);
  if (still()) return;
  void element.offsetWidth;
  element.classList.add(name);
}

/** A token's value (a curve or a length) as the stylesheet has it, for motion made here. */
export const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** element.animate with one of the stylesheet's curves; null when nothing should move. */
export function move(element, frames, { ms = 300, curve = "--ease-out", ...rest } = {}) {
  if (still() || !element.animate) return null;
  const options = { duration: ms, ...rest };
  try { return element.animate(frames, { ...options, easing: token(curve) || "ease-out" }); }
  catch { return element.animate(frames, { ...options, easing: "ease-out" }); }
}

const folds = new WeakMap();
/**
 * Shows or hides an element that takes room, opening or closing that room
 * instead of making what is around it jump. `hidden` goes on once it has
 * closed; shown again meanwhile, it opens from where it is.
 */
export function unfold(element, shown) {
  const running = folds.get(element);
  if (shown) {
    if (!element.hidden && !running) return;
    const from = running ? element.offsetHeight : 0;
    running?.cancel();
    folds.delete(element);
    element.hidden = false;
    const to = element.offsetHeight;
    const opening = move(element, [
      { height: `${from}px`, opacity: from ? 1 : 0, overflow: "hidden", ...(from ? {} : SHUT) },
      { height: `${to}px`, opacity: 1, overflow: "hidden" },
    ], { ms: 330, curve: "--resize" });
    if (opening) { folds.set(element, opening); opening.onfinish = opening.oncancel = () => { if (folds.get(element) === opening) folds.delete(element); }; }
    return;
  }
  if (element.hidden || running?.closing) return;
  const from = element.offsetHeight;
  running?.cancel();
  const closing = move(element, [
    { height: `${from}px`, opacity: 1, overflow: "hidden" },
    { height: "0px", opacity: 0, overflow: "hidden", ...SHUT },
  ], { ms: 260, curve: "--resize", fill: "forwards" });
  if (!closing) { folds.delete(element); element.hidden = true; return; }
  closing.closing = true;
  folds.set(element, closing);
  closing.onfinish = () => { if (folds.get(element) !== closing) return; folds.delete(element); element.hidden = true; closing.cancel(); };
}
const SHUT = { marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" };
/** Closing now (its `hidden` still to come). */
export const isFolding = (element) => !!folds.get(element)?.closing;

const waits = new WeakMap();

function settle(element) {
  const wait = waits.get(element);
  if (!wait) return;
  waits.delete(element);
  clearTimeout(wait.timer);
  element.removeEventListener("animationend", wait.ended);
  element.removeEventListener("animationcancel", wait.ended);
}

/**
 * Runs `done` when the motion the class `name` gives the element is over:
 * the class goes on, the stylesheet animates it, and the end of that
 * animation (or a little after its length, should the browser never say)
 * is the moment. At once when the class brings no animation of its own.
 * A second call replaces the first.
 */
function after(element, name, done) {
  settle(element);
  const before = names(getComputedStyle(element));
  element.classList.add(name);
  const style = getComputedStyle(element);
  const own = names(style).filter((animation) => !before.includes(animation));
  if (still() || !own.length || !length(style)) { element.classList.remove(name); done(); return; }
  const finish = () => { settle(element); element.classList.remove(name); done(); };
  const ended = (event) => { if (event.target === element && own.includes(event.animationName)) finish(); };
  waits.set(element, { timer: setTimeout(finish, length(style) + 120), ended, name });
  element.addEventListener("animationend", ended);
  element.addEventListener("animationcancel", ended);
}

/** Leaving right now (its `hidden` or close() still to come). */
export const isLeaving = (element) => waits.has(element);

/**
 * Shows or hides an element that the `hidden` attribute hides. In: at once
 * (the stylesheet animates what appears). Out: after its `.leaving` motion.
 * Asked to show while it leaves, it stays, as it is.
 */
export function present(element, shown) {
  if (shown) {
    if (waits.has(element)) {
      const { name } = waits.get(element);
      settle(element);
      // Back before it was gone: no second entrance, just there.
      element.classList.remove(name);
      element.classList.add("stayed");
    }
    if (element.hidden) { element.classList.remove("stayed"); element.hidden = false; }
    return;
  }
  if (element.hidden || waits.has(element)) return;
  after(element, "leaving", () => { element.classList.remove("stayed"); element.hidden = true; });
}

/** Shows or hides it with no motion (a whole screen is being drawn anew). */
export function place(element, shown) {
  if (waits.has(element)) { const { name } = waits.get(element); settle(element); element.classList.remove(name); }
  element.classList.remove("stayed");
  element.hidden = !shown;
}

/** Removes an element from the page after its `.leaving` motion. */
export function dismiss(element) {
  if (!element.isConnected || waits.has(element)) return;
  after(element, "leaving", () => element.remove());
}

const watchers = new Set();
/** Calls `listener` whenever a dialog opens, starts to close or has closed. */
export const watchDialogs = (listener) => { watchers.add(listener); };
const tell = () => { for (const listener of watchers) listener(); };

/** Opens a <dialog> as a modal one (the stylesheet brings it in); one that was closing stays. */
export function openDialog(dialog) {
  if (waits.has(dialog)) { settle(dialog); dialog.classList.remove("closing"); }
  if (!dialog.open) dialog.showModal();
  tell();
}

/** Closes a <dialog> after its `.closing` motion. Resolves once it is closed. */
export function closeDialog(dialog) {
  if (!dialog.open) return Promise.resolve();
  if (waits.has(dialog)) return new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  return new Promise((resolve) => {
    after(dialog, "closing", () => { if (dialog.open) dialog.close(); tell(); resolve(); });
    tell();
  });
}

/** Closes it with no motion (the page is going away, or the person is signed out). */
export function closeDialogNow(dialog) {
  settle(dialog);
  dialog.classList.remove("closing");
  if (dialog.open) dialog.close();
  tell();
}
