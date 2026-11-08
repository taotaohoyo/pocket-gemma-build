// A reply that a dropped connection doesn't end, for Fielua for the web.
// Safari stops a page's connections when the iPhone puts it in the
// background, and with /v1/messages the reply, Claude's thinking with it,
// ends there. A reply asked at /v1/replies runs in a Durable Object of its
// own (index.ts, Reply) instead: it goes on asking Anthropic when the
// page's connection drops, and it keeps what came, in memory only, so the
// page can read the reply again from its first byte and take what it
// missed.
//
// Nothing is written to storage or to a log. What a reply holds goes when
// the page says it has the whole reply, or stops it (DELETE), and at the
// latest LINGER_MS after the reply ended, or MAX_AGE_MS after it began.
// The page names each reply itself (REPLY_KEY) before it asks, so even a
// reply whose answer never reached the page can be stopped or read.
//
// As in meter.ts, no code of the relay's touches the reply's pieces (that
// would cost CPU for each one, more than the free plan gives): the runtime
// splits the stream (tee). One copy goes to the page as it comes, one is
// gathered whole, and one is left unread, to be split again when the page
// comes back for the reply: it holds everything from the first byte.

import { gather } from "./meter";

/** How long a reply nobody has said they have whole is kept after it ended. */
export const LINGER_MS = 10 * 60 * 1000;
/** The longest a reply is kept at all, from when it began (Anthropic's 64,000 tokens take less). */
export const MAX_AGE_MS = 30 * 60 * 1000;
/**
 * How often a kept reply's object sets itself a new timer: Cloudflare keeps
 * an object in memory for each pending operation up to 15 minutes from its
 * start, and Anthropic's request is one operation, begun with the reply.
 */
export const KEEP_ALIVE_MS = 5 * 60 * 1000;
/**
 * A reply's key: chosen by the page before it asks (32 hexadecimal
 * characters, random), so it can stop or read again a reply whose answer
 * never reached it. The object is found by the person's id and the key
 * together (index.ts), so a key means nothing to anyone else.
 */
export const REPLY_KEY = /^[0-9a-f]{32}$/;

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Run {
  owner: string;
  key: string;
  stop: AbortController;
  /** The copy nobody reads: split again for each return. Null once the reply ended (then `whole` has it). */
  tail: ReadableStream<Uint8Array> | null;
  /** The whole reply, once it ended (or broke off, or was stopped): as far as it came. */
  whole: Uint8Array | null;
  headers: Record<string, string>;
  /** Set once the reply ended: when it goes. */
  lingerUntil: number | null;
  startedAt: number;
  timer: unknown;
}

/** What `again` finds: the reply from its first byte, one not begun to stream yet, or none. */
export type Again = { body: ReadableStream<Uint8Array> | Uint8Array; headers: Record<string, string> } | "not_ready" | null;

/** One reply's keeper: there is one in each reply's Durable Object. */
export class ReplyKeeper {
  private run: Run | null = null;
  /** Who stopped a reply before it began here (the page's DELETE overtook its POST): it never begins. */
  private stoppedEarly: string | null = null;

  constructor(
    private readonly timers: Timers = realTimers,
    private readonly now: () => number = Date.now,
    private readonly lingerMs = LINGER_MS,
    private readonly maxAgeMs = MAX_AGE_MS,
    private readonly keepAliveMs = KEEP_ALIVE_MS,
  ) {}

  /**
   * For the reply about to be asked: its own stop, which no dropped
   * connection pulls, only the page's DELETE or the reply's age. Null when
   * the page stopped it already: then nothing is asked.
   */
  begin(owner: string, key: string): AbortSignal | null {
    if (this.stoppedEarly === owner) return null;
    this.forget();
    const run: Run = { owner, key, stop: new AbortController(), tail: null, whole: null, headers: {}, lingerUntil: null, startedAt: this.now(), timer: null };
    this.run = run;
    this.tick(run);
    return run.stop.signal;
  }

  /** The reply's stream, kept: the copy to send to the page now. */
  hold(stream: ReadableStream<Uint8Array>, headers: Record<string, string>): ReadableStream<Uint8Array> {
    const run = this.run;
    if (!run) return stream;
    run.headers = { ...headers, "X-Fielua-Reply": run.key };
    const [live, rest] = stream.tee();
    const [copy, tail] = rest.tee();
    run.tail = tail;
    // Gathered by the runtime; it ends when Anthropic's stream does, however it ends.
    void gather(copy).then((bytes) => {
      if (this.run !== run) return;
      run.whole = bytes;
      const unread = run.tail;
      run.tail = null;
      unread?.cancel().catch(() => {});
      run.lingerUntil = this.now() + this.lingerMs;
      this.tick(run);
    });
    // Sent as it is: a broken connection to the page cancels only this copy. (Not through
    // an IdentityTransformStream after meter.ts's: in workerd that copy then stalls.)
    return live;
  }

  /**
   * The reply again, from its first byte, as it was sent: what is still
   * coming follows. "not_ready" while Anthropic hasn't begun to answer;
   * null when there is none for this person (it went, it never was, or it
   * is someone else's).
   */
  again(owner: string): Again {
    const run = this.run;
    if (!run || run.owner !== owner) return null;
    if (run.whole) return { body: run.whole, headers: { ...run.headers } };
    if (!run.tail) return "not_ready";
    const [give, keep] = run.tail.tee();
    run.tail = keep;
    return { body: give, headers: { ...run.headers } };
  }

  /**
   * Stopped (if it is still being written) and forgotten. False when there
   * was none for this person; then one that begins later for them is never
   * asked (the stop overtook the request).
   */
  end(owner: string): boolean {
    if (!this.run || this.run.owner !== owner) {
      this.stoppedEarly = owner;
      return false;
    }
    this.forget();
    return true;
  }

  /** Stopped and forgotten, whoever's it is: its own object failed to answer for it. */
  abandon(): void {
    this.forget();
  }

  /** Whether a reply is kept now (for the tests). */
  get holding(): boolean {
    return this.run !== null;
  }

  /**
   * The run's next timer: when it lingered long enough, or grew too old,
   * it goes; until then a new timer at least every KEEP_ALIVE_MS keeps the
   * object in memory (each one is an operation of its own to Cloudflare).
   */
  private tick(run: Run): void {
    this.timers.clear(run.timer);
    const now = this.now();
    const ends = Math.min(run.startedAt + this.maxAgeMs, run.lingerUntil ?? Infinity);
    if (now >= ends) { this.forget(); return; }
    run.timer = this.timers.set(() => { if (this.run === run) this.tick(run); }, Math.min(ends - now, this.keepAliveMs));
  }

  private forget(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.timers.clear(run.timer);
    // Anthropic stops writing it; whatever was kept goes with the run.
    run.stop.abort();
    run.tail?.cancel().catch(() => {});
    run.tail = null;
    run.whole = null;
  }
}
