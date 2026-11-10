// The flower, petal by petal, as the iPhone app moves it (FlowerMark.swift):
// it opens on the sign-in screen (BloomingFlower) and is alive in the empty
// chat (LivingFlower: it breathes, each petal opens and closes a little on
// its own slow beat, and now and then one drifts off while a new one grows).
//
// It is the page's own picture (assets/flower.png) drawn five times, each
// through one petal's outline. The outlines are the app's
// (design/brand/flower.json: centre 0, longest tip at radius 1, y down), so
// the flower at rest is the picture itself, and every turn is about the
// centre the petals share. With "視差効果を減らす" it only ever rests.

import { still } from "./motion.js";

/** The picture's place in the outlines' units: x, y, width, height. */
const BOX = [-0.8737, -1, 1.7462, 1.7134];
const PETALS = [
  "M.0005-.0071C-.0128-.0229-.0061-.0577-.0097-.0784C-.0173-.1232-.0338-.1676-.0566-.2068C-.1394-.3493-.3421-.3979-.3322-.5704C-.3235-.7219-.2399-.8366-.1248-.9293C-.0922-.9556-.0479-.9995-.0036-1.0000C.0481-1.0006 .1544-.9155 .1939-.8806C.3271-.7628 .3756-.5737 .3019-.4100C.2784-.3578 .2425-.3104 .2099-.2638C.1892-.2342 .1701-.2032 .1462-.1761C.1198-.1463 .0345-.0071 .0005-.0071Z",
  "M.0000 .0084C.0314 .0148 .0546 .0470 .0820 .0614C.1137 .0781 .1480 .0930 .1818 .1051C.3075 .1500 .4767 .1194 .5669 .2348C.6473 .3376 .6479 .4784 .6000 .5954C.5871 .6269 .5743 .6709 .5456 .6917C.5243 .7071 .4580 .7100 .4314 .7111C.1776 .7222-.0353 .5490-.0585 .2923C-.0601 .2741-.0554 .2569-.0553 .2389C-.0550 .1910-.0375 .0390 .0000 .0084Z",
  "M.0063 .0000C.0067-.0006 .0880-.0562 .1283-.1099C.2377-.2555 .2816-.4142 .4742-.4735C.5991-.5119 .7260-.4524 .8164-.3692C.8343-.3527 .8607-.3335 .8698-.3102C.8832-.2763 .8435-.1762 .8280-.1426C.7510 .0236 .5852 .1346 .3993 .1264C.3364 .1237 .2736 .1040 .2139 .0854C.1892 .0777 .1637 .0721 .1390 .0643C.1218 .0589 .1067 .0486 .0891 .0435C.0798 .0409 .0694 .0442 .0606 .0404C.0454 .0337 .0108 .0155 .0063 .0000Z",
  "M-.0088 .0036C-.0049 .0199-.0280 .0402-.0357 .0553C-.0555 .0943-.0692 .1348-.0759 .1783C-.0948 .3002-.0400 .4082-.0603 .4920C-.0743 .5496-.1257 .5924-.1711 .6252C-.2515 .6834-.3595 .7041-.4563 .7041C-.4892 .7041-.5447 .7062-.5637 .6738C-.6120 .5914-.6411 .4916-.6325 .3957C-.6135 .1851-.4213 .0201-.2175 .0014C-.1865-.0014-.1557-.0134-.1248-.0149C-.1183-.0152-.1130-.0123-.1070-.0106C-.0807-.0035-.0548-.0089-.0285-.0045C-.0211-.0033-.0149-.0007-.0088 .0036Z",
  "M-.0065-.0036C-.0122-.0020-.1135-.0280-.1355-.0300C-.2064-.0364-.2777-.0201-.3423 .0083C-.3994 .0333-.4501 .0735-.5134 .0830C-.6500 .1035-.7642-.0127-.8200-.1230C-.8415-.1655-.8947-.2829-.8647-.3244C-.8437-.3535-.8153-.3757-.7879-.3981C-.6406-.5183-.4391-.4977-.2888-.3926C-.2284-.3504-.1804-.2920-.1355-.2347C-.1079-.1996-.0021-.0392-.0065-.0036Z",
];
/** Where each petal's tip points from the centre, and its middle (what it turns about in the air). */
const AXES = [[-0.004, -1], [0.622, 0.783], [0.942, -0.335], [-0.628, 0.779], [-0.94, -0.34]];
const MIDDLES = [[0.033, -0.452], [0.255, 0.327], [0.366, -0.095], [-0.207, 0.258], [-0.433, -0.157]];

const SVG = "http://www.w3.org/2000/svg";
let made = 0;

const svg = (name, attributes = {}, ...children) => {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.append(...children);
  return element;
};

/** The flower as five petals. `picture` is the address of the whole flower's picture. */
export function flowerMark(className, picture = "assets/flower.png") {
  const id = `flower${++made}`;
  const petal = (index) => svg("g", { class: "petal" },
    svg("image", { href: picture, x: BOX[0], y: BOX[1], width: BOX[2], height: BOX[3], preserveAspectRatio: "none", "clip-path": `url(#${id}-${index})` }));
  const whole = svg("g", {}, ...PETALS.map((_, index) => petal(index)));
  const element = svg("svg", { class: className, viewBox: BOX.join(" "), "aria-hidden": "true", focusable: "false" },
    svg("defs", {}, ...PETALS.map((path, index) => svg("clipPath", { id: `${id}-${index}` }, svg("path", { d: path })))),
    whole);
  element.whole = whole;
  element.petals = [...whole.children];
  element.newPetal = petal;
  return element;
}

const clamp = (x) => Math.min(Math.max(x, 0), 1);
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const smoother = (x) => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const between = (low, high) => low + Math.random() * (high - low);
const n = (value) => Math.round(value * 10000) / 10000;

function pose(element, transform, opacity = 1) {
  if (transform) element.setAttribute("transform", transform); else element.removeAttribute("transform");
  if (opacity < 1) element.setAttribute("opacity", n(opacity)); else element.removeAttribute("opacity");
}

function rest(flower) {
  pose(flower.whole, "");
  for (const petal of flower.petals) pose(petal, "");
}

// MARK: Opening (the sign-in screen)

/** Each petal is born at a quarter of its size, a third of a right angle back, and opens with no overshoot; the bud they come from swells meanwhile. */
const BLOOM = { order: [0, 2, 1, 3, 4], seed: 0.25, turn: -34, stagger: 0.12, span: 1.3, budSeed: 0.45, budSpan: 1.7, hold: 0.15 };

/** Opens the flower once, from the bud. Returns a function that stops it at rest. */
export function bloom(flower) {
  if (still()) { rest(flower); return () => {}; }
  const done = BLOOM.hold + Math.max(BLOOM.stagger * (BLOOM.order.length - 1) + BLOOM.span, BLOOM.budSpan);
  let frame = 0;
  let began = 0;
  const draw = (now) => {
    began ||= now;
    const time = (now - began) / 1000;
    if (time >= done || still()) { rest(flower); frame = 0; return; }
    const bud = BLOOM.budSeed + (1 - BLOOM.budSeed) * smoother((time - BLOOM.hold) / BLOOM.budSpan);
    pose(flower.whole, `scale(${n(bud)})`);
    flower.petals.forEach((petal, index) => {
      const begin = BLOOM.hold + BLOOM.order.indexOf(index) * BLOOM.stagger;
      const growth = smoother((time - begin) / BLOOM.span);
      pose(petal, `rotate(${n(BLOOM.turn * (1 - growth))}) scale(${n(BLOOM.seed + (1 - BLOOM.seed) * growth)})`, smooth((time - begin) / 0.35));
    });
    frame = requestAnimationFrame(draw);
  };
  // The first frame now, so the whole flower is never seen before the bud.
  draw(performance.now());
  return () => { cancelAnimationFrame(frame); rest(flower); };
}

// MARK: Alive (the empty chat)

const LIFE = { breath: 0.04, lean: 1.5, reach: 0.04, open: 3, beats: [[5.3, 9.1], [6.1, 10.3], [6.7, 11.7], [5.7, 8.3], [7.1, 12.9]], fadeIn: 2.5, fadeOut: 1.25 };
const DRIFT = { regrowDelay: 0.9, regrowSpan: 2.6 };

/** One petal's flight: where it goes, how it turns and tips, and how the new one grows in. */
function newDrift(after, start) {
  const others = PETALS.map((_, index) => index).filter((index) => index !== after);
  const petal = others[Math.floor(Math.random() * others.length)];
  const [axisX] = AXES[petal];
  const side = axisX > 0.15 ? 1 : axisX < -0.15 ? -1 : Math.random() < 0.5 ? 1 : -1;
  const span = between(3.2, 3.6);
  return {
    petal, start, span, side,
    reach: between(0.7, 0.95), fall: between(0.45, 0.7),
    sway: between(0.08, 0.15) * (Math.random() < 0.5 ? 1 : -1), phase: between(0, 2 * Math.PI),
    turn: between(40, 75) * side, tip: between(45, 65) * (Math.random() < 0.5 ? 1 : -1),
    total: Math.max(span, DRIFT.regrowDelay + DRIFT.regrowSpan),
  };
}

function leaving(drift, time, dark) {
  const x = clamp(time / drift.span);
  const [axisX, axisY] = AXES[drift.petal];
  const leanX = axisX + drift.side * 0.5;
  const length = Math.max(Math.hypot(leanX, axisY), 0.001);
  const wayX = leanX / length, wayY = axisY / length;
  const loosen = smooth(x / 0.15);
  const along = 0.05 * loosen + drift.reach * (1 - (1 - x) * (1 - x));
  const across = drift.sway * Math.sin(Math.PI * 1.6 * x + drift.phase) * smooth(x / 0.4);
  const down = drift.fall * (axisY < -0.5 ? 0.3 : 1) * x * x;
  return {
    dx: wayX * along - wayY * across, dy: wayY * along + wayX * across + down,
    turn: drift.turn * smooth(x), tip: drift.tip * Math.sin(Math.PI * x), scale: 1 + 0.04 * loosen - 0.18 * x,
    opacity: 1 - (dark ? smooth((x - 0.25) / 0.45) : smooth((x - 0.3) / 0.7)),
  };
}

function regrowth(time) {
  const begin = time - DRIFT.regrowDelay;
  const growth = smoother(begin / DRIFT.regrowSpan);
  return { scale: 0.2 + 0.8 * growth, turn: BLOOM.turn * 0.5 * (1 - growth), opacity: smooth(begin / 0.5) };
}

const darkScheme = matchMedia("(prefers-color-scheme: dark)");

/**
 * Keeps a flower alive while `wanted()` says so. Call `check()` whenever that
 * may have changed: the motion comes in over two and a half seconds and goes
 * out over one and a quarter, and once it is out (and no petal is in the air)
 * nothing is drawn at all.
 */
export function alive(flower, wanted) {
  const starts = Array.from({ length: 14 }, () => between(0, 2 * Math.PI));
  const beats = [...LIFE.beats].sort(() => Math.random() - 0.5);
  const wave = (seconds, beat, start) => Math.sin((2 * Math.PI * seconds) / beat + starts[start]);
  const swell = { from: 0, to: 0, since: -Infinity };
  const level = (now) => {
    const span = (swell.to > swell.from ? LIFE.fadeIn : LIFE.fadeOut) * Math.max(Math.abs(swell.to - swell.from), 0.2);
    return swell.from + (swell.to - swell.from) * smooth((now - swell.since) / span);
  };
  const origin = performance.now() / 1000;
  let frame = 0, last = 0, drift = null, lastPetal = null, nextDrift = Infinity, spare = null;

  const settle = () => {
    frame = 0;
    drift = null;
    spare?.remove();
    spare = null;
    rest(flower);
  };

  const draw = (stamp) => {
    const now = stamp / 1000;
    const moving = !still() && wanted();
    const target = moving ? 1 : 0;
    if (target !== swell.to) {
      swell.from = level(now); swell.to = target; swell.since = now;
      // Six to ten seconds after it starts to move, the first petal goes.
      nextDrift = moving ? now + between(6, 10) : Infinity;
    }
    const amount = level(now);
    if (still() || (!moving && amount === 0 && !drift)) { settle(); return; }
    frame = requestAnimationFrame(draw);
    // Thirty frames a second while it only breathes; every frame while a petal is in the air.
    if (!drift && stamp - last < 30) return;
    last = stamp;
    if (!drift && now >= nextDrift) {
      drift = newDrift(lastPetal, now);
      lastPetal = drift.petal;
      spare = flower.newPetal(drift.petal);
      flower.whole.append(spare);
    }
    if (drift && now - drift.start >= drift.total) {
      drift = null;
      spare.remove();
      spare = null;
      nextDrift = moving ? now + between(10, 18) : Infinity;
    }
    const seconds = now - origin;
    const breath = 0.75 * wave(seconds, 7.5, 0) + 0.25 * wave(seconds, 12.7, 1);
    const lean = 0.7 * wave(seconds, 17.3, 2) + 0.3 * wave(seconds, 23.9, 3);
    pose(flower.whole, `rotate(${n(LIFE.lean * lean * amount)}) scale(${n(1 + LIFE.breath * breath * amount)})`);
    flower.petals.forEach((petal, index) => {
      const [fast, slow] = beats[index];
      const open = (0.65 * wave(seconds, fast, 4 + index) + 0.35 * wave(seconds, slow, 9 + index)) * amount;
      const sway = `rotate(${n(LIFE.open * open)}) scale(${n(1 + LIFE.reach * open)})`;
      if (!drift || index !== drift.petal) { pose(petal, sway); return; }
      // The petal in its place is the new one growing in; the spare is the one in the air.
      const since = now - drift.start;
      const grow = regrowth(since);
      pose(petal, `rotate(${n(grow.turn + LIFE.open * open)}) scale(${n(grow.scale * (1 + LIFE.reach * open))})`, grow.opacity);
      const away = leaving(drift, since, darkScheme.matches);
      const [middleX, middleY] = MIDDLES[index];
      const axis = (Math.atan2(AXES[index][1], AXES[index][0]) * 180) / Math.PI;
      // Tipping over about its own length, as a petal turns in the air: seen flat, it narrows.
      pose(spare, `translate(${n(away.dx + middleX)} ${n(away.dy + middleY)}) scale(${n(away.scale)}) rotate(${n(away.turn + axis)}) scale(1 ${n(Math.cos((away.tip * Math.PI) / 180))}) rotate(${n(-axis)}) translate(${-middleX} ${-middleY}) ${sway}`, away.opacity);
    });
  };

  const check = () => {
    if (frame || still() || !wanted()) return;
    frame = requestAnimationFrame(draw);
  };
  document.addEventListener("visibilitychange", check);
  return { check };
}
