// The iPhone app's springs (SwiftUI's .spring(duration:bounce:), see
// PocketGemma/Views/ChatMotion.swift) as CSS: each becomes a duration and
// a linear() easing that follows the same curve. Run it and paste the lines
// into the motion tokens at the top of src/styles.css:
//
//   node tools/springs.mjs
//
// SwiftUI's spring: mass 1, stiffness (2π / duration)², damping ratio
// 1 − bounce. `duration` is how long it feels; the curve itself settles
// later, so the CSS duration is the time to come within 0.1 % and stay.

const SPRINGS = {
  // name: [duration, bounce]  — the app's name for it
  send: [0.38, 0.08],        // ChatMotion.send
  "menu-open": [0.44, 0.2],  // ChatMotion.menuOpen
  "menu-close": [0.34, 0.08],// ChatMotion.menuClose
  "sheet-open": [0.46, 0.04],// iOS's own sheet, by eye
  "sheet-close": [0.36, 0],
  "jump-rise": [0.42, 0.18], // ChatMotion.jumpRise
  "jump-sink": [0.38, 0],    // ChatMotion.jumpSink
  resize: [0.22, 0],         // ChatMotion.resize (.smooth)
  settle: [0.4, 0],          // the drawer and the chips (.spring(duration: 0.4, bounce: 0))
  press: [0.3, 0.3],         // a button let go
  "flower-away": [0.42, 0],  // FlowerAway.leave
  "flower-back": [0.65, 0.1],// FlowerAway.arrive
};

function position(t, duration, bounce) {
  const w0 = (2 * Math.PI) / duration;
  const zeta = 1 - bounce;
  if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
}

function settleTime(duration, bounce) {
  let last = 0;
  for (let t = 0; t < 4; t += 0.001) if (Math.abs(1 - position(t, duration, bounce)) > 0.001) last = t;
  return Math.ceil((last + 0.001) * 100) / 100;
}

/** Points where the curve bends most get more stops: a fixed error of 0.25 % from the straight lines between them. */
function stops(duration, bounce, total) {
  const f = (x) => position(x * total, duration, bounce);
  const points = [0];
  let from = 0;
  while (from < 1) {
    let to = Math.min(1, from + 0.2);
    for (; to - from > 0.004; to -= 0.004) {
      let worst = 0;
      for (let i = 1; i < 8; i++) {
        const x = from + ((to - from) * i) / 8;
        worst = Math.max(worst, Math.abs(f(x) - (f(from) + ((f(to) - f(from)) * i) / 8)));
      }
      if (worst < 0.0025) break;
    }
    points.push(to);
    from = to;
  }
  return points.map((x, i) => {
    const value = i === points.length - 1 ? 1 : Math.round(f(x) * 1000) / 1000;
    return i === 0 || i === points.length - 1 ? `${value}` : `${value} ${Math.round(x * 1000) / 10}%`;
  });
}

for (const [name, [duration, bounce]] of Object.entries(SPRINGS)) {
  const total = settleTime(duration, bounce);
  console.log(`  --${name}-ms: ${Math.round(total * 1000)}ms; --${name}: linear(${stops(duration, bounce, total).join(", ")});`);
}
