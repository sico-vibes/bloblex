// robot-heads 0.3.0 (MIT, Copyright (c) 2026 Fayaz Ahmed), vendored by Bloblex.
// Bloblex changes, both for cost: (1) the shared loop draws at most ~30 times a
// second instead of at the display's refresh rate; (2) avatars of 80px or less
// draw at up to 1.5x instead of 2x and update at ~15 fps. Nothing else is modified.
import { jsx as Kt } from "react/jsx-runtime";
import { forwardRef as xn, useRef as J, useImperativeHandle as vn, useId as Cn, useEffect as Rn } from "react";
const O = {
  /* radius of the rolled edge round the front and the back */
  bevel: 0.075,
  /* the shell's rim round the screen, then the rubber gasket */
  margin: 0.045,
  gasket: 0.022,
  /* how far the glass sits behind the face */
  recess: 0.03,
  earY: 0.03,
  /* the antenna: the stem's length and the ball's radius */
  stem: 0.2,
  ball: 0.052
}, q = {
  plate: O.bevel,
  hole: O.bevel + O.margin,
  glass: O.bevel + O.margin + O.gasket
};
function Vt(n, t, s) {
  const e = Math.cos(n), o = Math.sin(n), i = Math.cos(t), a = Math.sin(t), r = Math.cos(s), l = Math.sin(s), h = [e, o * a, o * i, 0, i, -a, -o, e * a, e * i];
  return [
    r * h[0] - l * h[3],
    r * h[1] - l * h[4],
    r * h[2] - l * h[5],
    l * h[0] + r * h[3],
    l * h[1] + r * h[4],
    l * h[2] + r * h[5],
    h[6],
    h[7],
    h[8]
  ];
}
function at(n, t, s, e) {
  return [n[0] * t + n[1] * s + n[2] * e, n[3] * t + n[4] * s + n[5] * e, n[6] * t + n[7] * s + n[8] * e];
}
const dn = (n, t, s) => {
  const e = Math.hypot(n, t, s) || 1;
  return [n / e, t / e, s / e];
}, Mt = Math.PI * 2;
function bt(n, t, s, e, o, i) {
  const a = t.map(([u, v]) => ({ x: u, y: v, t: Math.atan2(v, u) })).sort((u, v) => u.t - v.t), r = a.length, l = [];
  for (let u = 0; u < r; u++) {
    const v = a[u], A = a[(u + 1) % r];
    l.push(Math.atan2(-(A.x - v.x), A.y - v.y));
  }
  const h = a.map((u, v) => {
    if (r === 1) return { x: u.x, y: u.y, a0: -Math.PI, a1: Math.PI };
    let A = l[(v - 1 + r) % r], P = l[v];
    for (; P < A; ) P += Mt;
    return { x: u.x, y: u.y, a0: A, a1: P };
  }), c = (u, v) => {
    if (r === 1) return Math.hypot(u - a[0].x, v - a[0].y);
    let A = 1 / 0, P = !0;
    for (let T = 0; T < r; T++) {
      const L = a[T], C = a[(T + 1) % r], S = C.x - L.x, $ = C.y - L.y, V = u - L.x, D = v - L.y, W = Math.max(0, Math.min(1, (V * S + D * $) / (S * S + $ * $)));
      A = Math.min(A, Math.hypot(V - S * W, D - $ * W)), S * D - $ * V < 0 && (P = !1);
    }
    return P ? -A : A;
  }, f = (u, v, A) => c(u, v) - (s - A), p = (u, v) => {
    const A = Math.max(5e-4, s - v);
    h.forEach((P, T) => {
      T === 0 && u.moveTo(P.x + A * Math.cos(P.a0), P.y + A * Math.sin(P.a0)), u.arc(P.x, P.y, A, P.a0, P.a1);
    }), u.closePath();
  };
  let M = 0, b = 0;
  for (const u of a)
    M = Math.max(M, Math.abs(u.x) + s), b = Math.max(b, Math.abs(u.y) + s);
  let w = 0, k = M + 0.1;
  for (let u = 0; u < 40; u++) {
    const v = (w + k) / 2;
    f(v, O.earY, 0) < 0 ? w = v : k = v;
  }
  const d = (u, v) => u.map((A, P) => {
    const T = A * Math.PI / 180, L = h.find((C) => [T, T + Mt, T - Mt].some((S) => S >= C.a0 - 1e-6 && S <= C.a1 + 1e-6)) ?? h[0];
    return [L.x + Math.cos(T) * (s - v), L.y + Math.sin(T) * (s - v), 0.5 + P * 0.9];
  }), x = 2 * (M - q.glass), m = 2 * (b - q.glass), I = Math.min(In * x / 14, 0.65 * m / 10);
  return {
    name: n,
    r: s,
    depth: e,
    corners: h,
    hx: M,
    hy: b,
    pitch: I,
    earX: w - 8e-3,
    /* on the face: halfway between the lip round the hole and the rolled edge */
    screws: d(o, (q.hole - 0.018 + q.plate) / 2),
    /* on the back: inside the panel line */
    backScrews: d(i, q.plate + 0.07),
    sd: f,
    path: p
  };
}
const An = (n) => [0, 60, 120, 180, 240, 300].map((t) => [n * Math.cos(t * Math.PI / 180), n * Math.sin(t * Math.PI / 180)]), In = 0.6, Lt = [45, 135], Ht = [-135, -45, 45, 135], Wt = {
  rectangle: () => bt("rectangle", [[-0.29, -0.17], [0.29, -0.17], [0.29, 0.17], [-0.29, 0.17]], 0.21, 0.6, Lt, Ht),
  square: () => bt("square", [[-0.22, -0.22], [0.22, -0.22], [0.22, 0.22], [-0.22, 0.22]], 0.2, 0.6, Lt, Ht),
  circle: () => bt("circle", [[0, 0]], 0.46, 0.56, Lt, Ht),
  hexagon: () => bt("hexagon", An(0.35), 0.16, 0.58, [60, 120], [-120, -60, 60, 120])
}, Ut = /* @__PURE__ */ new Map();
function Jt(n) {
  let t = Ut.get(n);
  return t || (t = (Wt[n] ?? Wt.rectangle)(), Ut.set(n, t)), t;
}
function fn(n, t, s) {
  const e = new Float32Array(t.length / 4 * 3);
  for (let o = 0; o < t.length / 4; o++) {
    let i = 0, a = 0, r = 0;
    for (let l = 0; l < 4; l++) {
      const h = t[o * 4 + l] * 3;
      i += s[h], a += s[h + 1], r += s[h + 2];
    }
    e.set(dn(i, a, r), o * 3);
  }
  return { pos: new Float32Array(n), quads: new Uint16Array(t), normals: e };
}
function un(n, t, s = !0) {
  const e = [], o = s ? t : t - 1;
  for (let i = 0; i < n - 1; i++)
    for (let a = 0; a < o; a++) {
      const r = (a + 1) % t;
      e.push(i * t + a, i * t + r, (i + 1) * t + r, (i + 1) * t + a);
    }
  return e;
}
function Pn(n, t = 10) {
  const s = n.r, e = O.bevel, o = n.depth / 2, i = [];
  for (const h of n.corners) {
    const c = h.a1 - h.a0, f = Math.max(2, Math.ceil(c / (Math.PI / 2) * 14)), p = c >= Mt - 1e-6 ? f - 1 : f;
    for (let M = 0; M <= p; M++) {
      const b = h.a0 + M / f * c;
      i.push([h.x, h.y, Math.cos(b), Math.sin(b)]);
    }
  }
  const a = [];
  for (let h = t; h >= 0; h--) {
    const c = h / t * (Math.PI / 2);
    a.push([-o + e - e * Math.sin(c), e * (1 - Math.cos(c)), -c]);
  }
  for (let h = 0; h <= t; h++) {
    const c = h / t * (Math.PI / 2);
    a.push([o - e + e * Math.sin(c), e * (1 - Math.cos(c)), c]);
  }
  const r = [], l = [];
  for (const [h, c, f] of a)
    for (const [p, M, b, w] of i)
      r.push(p + (s - c) * b, M + (s - c) * w, h), l.push(b * Math.cos(f), w * Math.cos(f), Math.sin(f));
  return fn(r, un(a.length, i.length), l);
}
function Tt(n, t, s, e = 36) {
  const o = Math.abs(s[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], i = dn(s[1] * o[2] - s[2] * o[1], s[2] * o[0] - s[0] * o[2], s[0] * o[1] - s[1] * o[0]), a = [], r = [];
  for (let l = 0; l < n.length; l++) {
    const [h, c] = n[l], f = n[Math.max(0, l - 1)], p = n[Math.min(n.length - 1, l + 1)], M = p[0] - f[0], b = p[1] - f[1], w = Math.hypot(M, b) || 1, k = b / w, d = -M / w;
    for (let x = 0; x < e; x++) {
      const m = x / e * Mt, I = Math.cos(m) * o[0] + Math.sin(m) * i[0], u = Math.cos(m) * o[1] + Math.sin(m) * i[1], v = Math.cos(m) * o[2] + Math.sin(m) * i[2];
      a.push(t[0] + s[0] * c + h * I, t[1] + s[1] * c + h * u, t[2] + s[2] * c + h * v), r.push(I * k + s[0] * d, u * k + s[1] * d, v * k + s[2] * d);
    }
  }
  return fn(a, un(n.length, e), r);
}
const zt = [
  [0.06, -0.012],
  [0.068, 0],
  [0.074, 6e-3],
  [0.08, 0.018],
  [0.084, 0.032],
  [0.084, 0.048],
  [0.079, 0.06],
  [0.068, 0.07],
  [0.052, 0.077],
  [0.032, 0.081],
  [0.014, 0.083],
  [0, 0.0835]
], En = [
  [0.05, -0.012],
  [0.052, 6e-3],
  [0.05, 0.016],
  [0.042, 0.024],
  [0.026, 0.029],
  [0.014, 0.031],
  [0, 0.032]
], Qt = /* @__PURE__ */ new Map();
function Ln(n) {
  let t = Qt.get(n.name);
  return t || (t = {
    body: Pn(n),
    earL: Tt(zt, [-n.earX, O.earY, 0], [-1, 0, 0]),
    earR: Tt(zt, [n.earX, O.earY, 0], [1, 0, 0]),
    collar: Tt(En, [0, -n.hy, 0], [0, -1, 0], 16)
  }, Qt.set(n.name, t)), t;
}
class it {
  constructor(t = 0) {
    this.x = 0, this.v = 0, this.x = t;
  }
  step(t, s, e, o) {
    const i = e * Math.PI * 2;
    this.v += (i * i * (t - this.x) - 2 * o * i * this.v) * s, this.x += this.v * s;
  }
}
function Hn(n) {
  let t = Math.floor(n * 4294967295) >>> 0 || 1;
  return () => {
    t = t + 1831565813 >>> 0;
    let s = t;
    return s = Math.imul(s ^ s >>> 15, s | 1), s ^= s + Math.imul(s ^ s >>> 7, s | 61), ((s ^ s >>> 14) >>> 0) / 4294967296;
  };
}
const z = (n, t, s) => Math.min(s, Math.max(t, n)), Tn = (n) => n < 0.5 ? 4 * n * n * n : 1 - Math.pow(-2 * n + 2, 3) / 2, $t = 0.11;
class $n {
  constructor(t, s) {
    this.switched = 10, this.age = 0, this.time = 0, this.since = 0, this.pose = { yaw: 0, pitch: 0, roll: 0, x: 0, lift: 0, sx: 1, sy: 1, antennaX: 0, antennaZ: 0 }, this.pointer = null, this.yaw = new it(), this.pitch = new it(), this.roll = new it(), this.sway = new it(), this.squash = new it(), this.antX = new it(), this.antZ = new it(), this.lastV = { roll: 0, pitch: 0, sway: 0 }, this.jump = null, this.lookAt = { yaw: 0, pitch: 0, x: 0, y: 0 }, this.nextLook = 0.6, this.nextBlink = 1.5, this.blinkAge = -1, this.nextHop = 8, this.nextSide = 4, this.reactUntil = -1, this.nextNod = 2.5, this.random = Hn(t), this.state = this.shown = this.previous = s, this.face = { lookX: 0, lookY: 0, blink: 0, time: 0, side: 1, seed: t }, this.nextBlink = 1 + this.random() * 3, this.nextHop = 6 + this.random() * 6;
  }
  setState(t) {
    t !== this.state && (this.state = t, this.since = 0, this.nextLook = 0, this.nextHop = this.time + (t === "happy" ? 0.2 : 3 + this.random() * 4), t === "happy" && this.hop(0.22, 1));
  }
  /** A click: a hop with a full turn and a happy face. */
  poke() {
    this.hop(0.24, this.random() < 0.5 ? 1 : -1), this.reactUntil = this.time + 1.6;
  }
  hop(t, s) {
    this.jump || (this.jump = { age: 0, height: t, spin: s, lean: (this.random() - 0.5) * 0.3, air: 0.42 + t * 0.45, landed: !1 });
  }
  update(t) {
    if (!(t > 0)) return;
    const s = Math.max(1, Math.ceil(t / (1 / 120)));
    for (let e = 0; e < s; e++) this.step(t / s);
  }
  step(t) {
    this.time += t, this.since += t, this.age += t, this.switched += t;
    const s = this.time, e = this.random, o = s < this.reactUntil ? "happy" : this.state;
    o !== this.shown && (this.previous = this.shown, this.shown = o, this.switched = 0);
    let i = 0, a = 0, r = 0, l = 0, h = Math.sin(s * 1.9) * 8e-3, c = 0, f = 0, p = 1.3, M = 0.62, b = 0;
    const w = this.pointer, k = w && (this.state === "idle" || this.state === "listening" || this.state === "happy" || this.state === "speaking");
    switch (s > this.nextLook && (this.lookAt = {
      yaw: (e() - 0.5) * 0.75,
      pitch: (e() - 0.5) * 0.24,
      x: 0,
      y: 0
    }, this.lookAt.x = z(Math.round(this.lookAt.yaw * 5), -2, 2), this.lookAt.y = e() < 0.3 ? -1 : e() < 0.2 ? 1 : 0, this.nextLook = s + 1.4 + e() * 2.6), this.state) {
      case "idle":
        i = this.lookAt.yaw, a = this.lookAt.pitch, r = -this.lookAt.yaw * 0.16, c = this.lookAt.x, f = this.lookAt.y, s > this.nextHop && (this.hop(0.15 + e() * 0.07, e() < 0.35 ? e() < 0.5 ? 1 : -1 : 0), this.nextHop = s + 7 + e() * 7);
        break;
      case "thinking": {
        s > this.nextSide && (this.face.side = -this.face.side, this.nextSide = s + 3 + e() * 2);
        const S = this.face.side;
        i = 0.24 * S + Math.sin(s * 0.9) * 0.05, a = 0.17 + Math.sin(s * 1.3) * 0.03, r = -0.13 * S, p = 0.9;
        break;
      }
      case "searching": {
        const S = s * 1.6;
        i = Math.sin(S) * 0.55, a = -0.04 + Math.sin(S * 2) * 0.04, r = Math.sin(S) * -0.06, c = z(Math.sin(S + 0.4) * 3, -3, 3), p = 2.2, M = 0.8;
        break;
      }
      case "listening": {
        i = -0.14, a = 0.02, r = 0.17, s > this.nextNod && (this.pitch.v -= 0.9, this.nextNod = s + 2 + e() * 2.5);
        break;
      }
      case "speaking":
        i = Math.sin(s * 0.7) * 0.12, a = 0.03 + Math.sin(s * 6.3) * 0.025 * (0.5 + 0.5 * Math.sin(s * 2.1)), r = Math.sin(s * 0.9) * 0.05, h += Math.abs(Math.sin(s * 6.3)) * 0.01, p = 1.8;
        break;
      case "working":
        i = Math.sin(s * 0.8) * 0.08, a = -0.16, r = Math.sin(s * 0.5) * 0.04, h += Math.abs(Math.sin(s * 7)) * 0.012, s > this.nextHop && (this.hop(0.2, e() < 0.5 ? 1 : -1), this.nextHop = s + 5 + e() * 3);
        break;
      case "happy":
        i = Math.sin(s * 2.2) * 0.18, r = Math.sin(s * 4.4) * 0.12, a = 0.08, s > this.nextHop && (this.hop(0.17, e() < 0.34 ? e() < 0.5 ? 1 : -1 : 0), this.nextHop = s + 1.05 + e() * 0.4);
        break;
      case "error": {
        const S = s % 2.4 / 0.7;
        b = S < 1 ? Math.sin(S * Math.PI * 7) * 0.22 * (1 - S) : 0, a = -0.06, r = -0.05, p = 1.6;
        break;
      }
      case "sleeping":
        a = -0.34, r = 0.13, i = 0.06, h = Math.sin(s * 1.15) * 0.016, p = 0.55, M = 0.9, s > this.nextNod && (this.pitch.v -= 0.5, this.nextNod = s + 5 + e() * 4);
        break;
    }
    k && w && (i = z(w.x / 260, -1, 1) * 0.55, a = -z(w.y / 260, -1, 1) * 0.32, r = -i * 0.12 + (this.state === "listening" ? 0.12 : 0), c = z(w.x / 120, -2.4, 2.4), f = z(w.y / 160, -1.4, 1.4)), this.yaw.step(i, t, p, M), this.pitch.step(a, t, p, M), this.roll.step(r, t, p, M), this.sway.step(l, t, 1.2, 0.7);
    let d = 0, x = 0, m = 0, I = 0;
    const u = this.jump;
    if (u)
      if (u.age += t, u.age < $t)
        I = 0.14;
      else {
        const S = (u.age - $t) / u.air;
        S < 1 ? (S < 0.06 && this.squash.x > 0.05 && (this.squash.v = -2.6, this.antZ.v -= 3), d = 4 * u.height * S * (1 - S), x = u.spin * Math.PI * 2 * Tn(z(S * 1.08, 0, 1)), m = u.lean * Math.sin(S * Math.PI), I = S < 0.5 ? -0.05 : 0) : u.landed ? u.age - $t - u.air > 0.35 && (this.jump = null) : (u.landed = !0, this.squash.v += 3.2, this.antX.v += (e() < 0.5 ? -1 : 1) * (2.5 + e() * 2), this.antZ.v += 3.5);
      }
    this.squash.step(I, t, 3.2, 0.32), s > this.nextBlink && (this.blinkAge = 0, this.nextBlink = s + 2.2 + e() * 3.5, e() < 0.2 && (this.nextBlink = s + 0.35));
    let v = 0;
    this.blinkAge >= 0 && (this.blinkAge += t, v = Math.sin(z(this.blinkAge / 0.17, 0, 1) * Math.PI), this.blinkAge > 0.17 && (this.blinkAge = -1));
    const A = (this.roll.v - this.lastV.roll) / t, P = (this.pitch.v - this.lastV.pitch) / t, T = (this.sway.v - this.lastV.sway) / t;
    this.lastV = { roll: this.roll.v, pitch: this.pitch.v, sway: this.sway.v };
    const L = 2.3;
    this.antX.v -= (A * 0.05 + T * 0.3) * t * 6, this.antZ.v -= P * 0.05 * t * 6, this.antX.step(0, t, L, 0.09), this.antZ.step(0, t, L, 0.09), this.antX.x = z(this.antX.x, -0.7, 0.7), this.antZ.x = z(this.antZ.x, -0.7, 0.7);
    const C = this.squash.x;
    this.pose = {
      yaw: this.yaw.x + x + b,
      pitch: this.pitch.x,
      roll: this.roll.x + m,
      x: this.sway.x,
      lift: d + h,
      sx: 1 + C * 0.55,
      sy: 1 - C,
      antennaX: this.antX.x,
      antennaZ: this.antZ.x
    }, this.face.lookX = c, this.face.lookY = f, this.face.blink = this.state === "sleeping" ? 0 : v, this.face.time = this.since;
  }
}
function Xn(n) {
  const t = { yaw: 0, pitch: 0, roll: 0, x: 0, lift: 0, sx: 1, sy: 1, antennaX: 0, antennaZ: 0 };
  switch (n) {
    case "thinking":
      return { ...t, yaw: 0.24, pitch: 0.17, roll: -0.13 };
    case "searching":
      return { ...t, yaw: 0.3, roll: -0.04 };
    case "listening":
      return { ...t, yaw: -0.14, pitch: 0.02, roll: 0.17 };
    case "working":
      return { ...t, pitch: -0.16 };
    case "happy":
      return { ...t, pitch: 0.08, roll: 0.06 };
    case "error":
      return { ...t, pitch: -0.06, roll: -0.05 };
    case "sleeping":
      return { ...t, pitch: -0.34, roll: 0.13, yaw: 0.06 };
    default:
      return { ...t, yaw: -0.18, pitch: 0.04, roll: 0.03 };
  }
}
const st = 22, et = 14;
function wt(n, t) {
  const s = st + 2 * Math.max(0, Math.ceil((n - st) / 2)), e = et + 2 * Math.max(0, Math.ceil((t - et) / 2));
  return { v: new Float32Array(s * e), cols: s, rows: e, ox: (s - st) / 2, oy: (e - et) / 2 };
}
const K = (n, t, s, e) => {
  const o = t + n.ox, i = s + n.oy;
  if (o < 0 || i < 0 || o >= n.cols || i >= n.rows) return;
  const a = i * n.cols + o;
  e > n.v[a] && (n.v[a] = e);
}, ut = (n, t, s, e, o, i) => {
  for (let a = s; a < s + o; a++) for (let r = t; r < t + e; r++) K(n, r, a, i);
}, ct = (n, t, s, e, o) => {
  e.forEach((i, a) => {
    for (let r = 0; r < i.length; r++)
      i[r] === "#" ? K(n, t + r, s + a, o) : i[r] === "+" && K(n, t + r, s + a, o * 0.5);
  });
}, St = 6, xt = 13, Bt = 5;
function dt(n, t, s = 4, e = 1, o = 0, i = 0) {
  const a = Math.round(t.lookX), r = Math.round(t.lookY) + o, l = Math.max(1, Math.round(s - (s - 1) * t.blink)), h = Bt + Math.floor((4 - s) / 2) + r + Math.floor((s - l) / 2);
  for (const c of [St, xt])
    i > 0 && l > 1 ? (ut(n, c + a, h, 3, 1, e * (1 - i)), ut(n, c + a, h + 1, 3, l - 1, e)) : ut(n, c + a, h, 3, l, e);
}
const Ft = (n) => 0.5 + 0.25 * Math.sin(n * 1.7) + 0.15 * Math.sin(n * 3.1 + 1.3) + 0.1 * Math.sin(n * 5.3 + 4.1), tn = ["..#..", ".#.#.", "#...#"], nn = ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"], On = ["####", "..#.", ".#..", "####"], jn = ["###", ".#.", "###"], Xt = {
  idle(n, t) {
    dt(n, t);
  },
  thinking(n, t) {
    dt(n, { ...t, lookX: t.lookX + t.side * 1.4, lookY: t.lookY - 1.2 }, 3, 1, 0, 0.45);
    for (let s = 0; s < 3; s++) {
      const e = (t.time * 1.6 - s * 0.22) % 1, o = e < 0.35 ? Math.sin(e / 0.35 * Math.PI) : 0;
      ut(n, 6 + s * 4, 11 - (o > 0.5 ? 1 : 0), 2, 2, 0.28 + 0.72 * o);
    }
  },
  searching(n, t) {
    dt(n, t);
    const s = -n.ox, e = st - 1 + n.ox, o = s + (Math.sin(t.time * 1.6 + 0.4) * 0.5 + 0.5) * (e - s), i = Math.cos(t.time * 1.6 + 0.4) > 0 ? -1 : 1;
    for (let a = 0; a < 5; a++) {
      const r = Math.round(o + i * a), l = 0.32 * (1 - a / 5);
      for (let h = -n.oy; h < et + n.oy; h++) K(n, r, h, l);
    }
  },
  listening(n, t) {
    dt(n, t, 4, 1, -1);
    for (let s = 0; s < 12; s++) {
      const e = 1 - Math.abs(s - 5.5) / 7, o = Ft(t.time * 7 + s * 1.9 + t.seed * 10) * e, i = Math.max(1, Math.round(o * 4));
      for (let a = 0; a < i; a++) K(n, 5 + s, 12 - a, 0.75 - a * 0.12);
    }
  },
  speaking(n, t) {
    dt(n, t, 4, 1, -1);
    const s = Math.max(0, Math.sin(t.time * 2.1) * 0.5 + Math.sin(t.time * 3.7 + 1) * 0.5);
    for (let e = 0; e < 8; e++) {
      const o = 1 - Math.abs(e - 3.5) / 5, i = Ft(t.time * 11 + e * 0.9) * o * (0.35 + s), a = i > 0.55 ? 3 : i > 0.28 ? 2 : 1, r = a === 3 ? 10 : 11, l = a === 3 ? 3 : a === 2 ? 2 : 1;
      ut(n, 7 + e, r, 1, l, 1);
    }
  },
  working(n, t) {
    dt(n, { ...t, lookY: t.lookY + 1 }, 2, 1, 0);
    const s = t.time / 2.6 % 1, e = Math.round(s * 12);
    for (let o = 0; o < 12; o++) K(n, 5 + o, 11, o < e ? 0.95 : 0.16);
    K(n, 4, 11, 0.4), K(n, 17, 11, 0.4);
  },
  happy(n, t) {
    const s = Math.round(Math.max(0, Math.sin(t.time * 5.6)) * -1);
    ct(n, St - 1, Bt + s, tn, 1), ct(n, xt - 1, Bt + s, tn, 1), ct(n, 7, 10 + s, ["#......#", ".######."], 0.9);
  },
  error(n, t) {
    const s = Math.sin(t.time * 7) > -0.6 ? 1 : 0.55;
    ct(n, St - 1, 4, nn, s), ct(n, xt - 1, 4, nn, s);
    for (let e = 0; e < 8; e++) K(n, 7 + e, e % 2 ? 11 : 12, 0.8);
  },
  sleeping(n, t) {
    for (const s of [St, xt])
      K(n, s - 1, 7, 0.32), ut(n, s, 8, 3, 1, 0.42), K(n, s + 3, 7, 0.32);
    for (const [s, e] of [[0, !0], [1.1, !1]]) {
      const o = (t.time + s) / 2.2 % 1, i = Math.sin(o * Math.PI) * 0.6, a = Math.round(5 - o * 5), r = 16 + Math.round(o * 2);
      ct(n, r, a, e ? On : jn, i);
    }
  }
}, sn = (n) => () => n, Ot = {
  idle: { screen: null, ball: [255, 250, 240], pulse: (n) => 0.75 + 0.1 * Math.sin(n * 1.4) },
  thinking: { screen: null, ball: [255, 184, 64], pulse: (n) => 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(n * 4.2)) },
  searching: { screen: null, ball: [90, 220, 255], pulse: (n) => n * 2.4 % 1 < 0.18 ? 1 : 0.25 },
  listening: { screen: null, ball: [96, 255, 150], pulse: sn(0.95) },
  speaking: { screen: null, ball: [255, 250, 240], pulse: (n) => 0.55 + 0.45 * Ft(n * 11) },
  working: { screen: null, ball: [110, 160, 255], pulse: (n) => n * 1.7 % 1 < 0.5 ? 1 : 0.35 },
  happy: { screen: null, ball: [255, 130, 200], pulse: (n) => 0.8 + 0.2 * Math.sin(n * 8) },
  error: { screen: [255, 70, 64], ball: [255, 60, 50], pulse: (n) => n * 3 % 1 < 0.5 ? 1 : 0.15 },
  sleeping: { screen: null, ball: [255, 250, 240], pulse: sn(0) }
}, It = (n, t, s) => {
  const e = Math.hypot(n, t, s);
  return [n / e, t / e, s / e];
}, j = It(-0.5, -0.78, 0.62), jt = It(0.85, 0.15, 0.5), Nt = It(0.55, -0.55, -0.62), qt = It(j[0], j[1], j[2] + 1), rt = (n, t, s) => {
  const e = Math.min(1, Math.max(0, (s - n) / (t - n)));
  return e * e * (3 - 2 * e);
};
function Nn(n, t, s) {
  const e = -t, o = 0.05 + 0.12 * rt(-0.25, 0.3, e), i = 1.1 * rt(0.42, 0.78, e) * rt(-0.9, -0.2, s - 0.6 * Math.abs(n)), a = 2.6 * rt(0.86, 0.97, n * j[0] + t * j[1] + s * j[2]), r = 0.5 * rt(0.6, 0.85, -n) * rt(-0.35, 0.05, e) * (1 - rt(0.2, 0.5, e));
  return o + i + a + r;
}
const Gt = (n) => Math.pow(n / 255, 2.2);
function en(n) {
  return [Gt(n[0]), Gt(n[1]), Gt(n[2])];
}
function ft(n) {
  const t = n * (2.51 * n + 0.03) / (n * (2.43 * n + 0.59) + 0.14);
  return Math.round(255 * Math.pow(Math.min(1, Math.max(0, t)), 1 / 2.2));
}
function pn(n, t, s, e, o = [0, 0, 0]) {
  const i = t * j[0] + s * j[1] + e * j[2], a = Math.max(0, (i + 0.12) / 1.12), r = Math.max(0, t * jt[0] + s * jt[1] + e * jt[2]), l = 0.5 - 0.5 * s, h = Math.max(0, e), c = n.f0 + (1 - n.f0) * Math.pow(1 - h, 5), f = 2 * h * t, p = 2 * h * s, M = 2 * h * e - 1, b = Nn(f, p, M) * c, w = n.spec * Math.pow(Math.max(0, t * qt[0] + s * qt[1] + e * qt[2]), n.shininess), k = Math.max(0, t * Nt[0] + s * Nt[1] + e * Nt[2]), d = n.rim * k * k * Math.pow(1 - h, 1.6), x = 0.05 + 0.1 * l + 1.25 * a + 0.16 * r;
  for (let m = 0; m < 3; m++) {
    const I = n.albedo[m], u = 1 - n.metal + n.metal * I * 2.2, v = m === 0 ? 0.62 : m === 1 ? 0.78 : 1;
    o[m] = I * x * (1 - c * 0.6) + (b + w) * u + d * v * (0.35 + I);
  }
  return o;
}
function Mn(n, t = 1) {
  return t >= 1 ? `rgb(${ft(n[0])},${ft(n[1])},${ft(n[2])})` : `rgba(${ft(n[0])},${ft(n[1])},${ft(n[2])},${t})`;
}
function on(n, t, s, e) {
  return Mn(pn(n, t, s, e));
}
const nt = (n, t) => {
  const s = document.createElement("canvas");
  return s.width = Math.max(1, Math.ceil(n)), s.height = Math.max(1, Math.ceil(t)), s;
}, Ct = (n, t, s) => {
  const e = Math.min(1, Math.max(0, (s - n) / (t - n)));
  return e * e * (3 - 2 * e);
}, Rt = (n, t) => {
  let s = Math.imul(n, 374761393) + Math.imul(t, 668265263);
  return s = Math.imul(s ^ s >>> 13, 1274126177), ((s ^ s >>> 16) >>> 0) / 4294967296;
}, kt = (() => {
  const n = Math.hypot(j[0], j[1], j[2] + 1);
  return [j[0] / n, j[1] / n, (j[2] + 1) / n];
})(), Q = { antenna: 0.028 + O.stem + O.ball * 1.8, knob: 0.035, ear: 0.105, glow: 0.18, hop: 0.3, overshoot: 0.13, shadow: 0.22, side: 0.12 }, qn = 0.05;
function Gn(n, t, s) {
  const e = t ? Q.antenna : Q.knob, o = 2 * n.hy + e, i = 2 * (n.earX + Q.ear), a = s * (1 - 2 * qn), r = Math.min(a / o, a / i), l = (s - o * r) / 2, h = l + (n.hy + e) * r, c = (t ? Q.glow + Q.hop : Q.hop + Q.overshoot) * r, f = h + (n.hy + Q.shadow) * r, p = s / 2 + (n.earX + Q.ear + Q.side) * r, M = Math.ceil(Math.max(0, c - l) + 1), b = Math.ceil(Math.max(0, f - s) + 1), w = Math.ceil(Math.max(0, p - s) + 1);
  return { box: s, padTop: M, padBottom: b, padSide: w, unit: r, cx: w + s / 2, cy: M + h };
}
const an = 0.035, Zt = (n) => ({ hx: n.hx - q.glass, hy: n.hy - q.glass });
function _t(n) {
  const t = Zt(n);
  return {
    hx: Math.max(t.hx, st / 2 * n.pitch) + an,
    hy: Math.max(t.hy, et / 2 * n.pitch) + an
  };
}
const gn = (n) => ({ hx: n.hx - q.plate, hy: n.hy - q.plate });
function yn(n, t, s) {
  const e = gn(n), o = Math.ceil(e.hx * 2 * t), i = Math.ceil(e.hy * 2 * t), a = nt(o, i), r = a.getContext("2d"), l = r.createImageData(a.width, a.height), h = l.data, c = e.hx * 2 / a.width;
  for (let f = 0; f < a.height; f++) {
    const p = -e.hy + (f + 0.5) * c;
    for (let M = 0; M < a.width; M++) {
      const b = -e.hx + (M + 0.5) * c, w = n.sd(b, p, q.plate), k = Math.min(1, Math.max(0, 0.5 - w / c));
      if (k <= 0) continue;
      const d = s(b, p, c, M, f), x = (f * a.width + M) * 4, m = Math.min(1, Math.abs(d)) * k, I = d > 0 ? 255 : 0;
      h[x] = h[x + 1] = h[x + 2] = I, h[x + 3] = Math.round(m * 255);
    }
  }
  return r.putImageData(l, 0, 0), a;
}
function gt(n, t, s, e = 0.55, o = 36) {
  const i = Math.hypot(n, t, s);
  n /= i, t /= i, s /= i;
  const a = (n * j[0] + t * j[1] + s * j[2] - j[2]) * 0.95, r = e * Math.pow(Math.max(0, n * kt[0] + t * kt[1] + s * kt[2]), o);
  return a + r - e * Math.pow(kt[2], o);
}
function At(n, t, s) {
  const o = n(t + 15e-4, s) - n(t - 15e-4, s), i = n(t, s + 15e-4) - n(t, s - 15e-4), a = Math.hypot(o, i) || 1;
  return [o / a, i / a];
}
function mn(n, t, s, e, o) {
  const a = n - s, r = t - e, l = Math.hypot(a, r);
  if (l > 0.013 + 6e-3) return null;
  if (l > 0.013) return -0.5 * (1 - (l - 0.013) / 6e-3);
  const h = Math.sqrt(Math.max(0, 1 - (l / 0.013) ** 2)) + 0.6;
  let c = gt(a / 0.013, r / 0.013, h, 0.9, 30) * 1.3 + 0.08;
  const f = Math.cos(o), p = Math.sin(o);
  return Math.abs(a * -p + r * f) < 26e-4 && l < 0.013 * 0.8 && (c = -0.65), c;
}
function Yn(n, t) {
  const e = (a, r) => n.sd(a, r, q.hole), o = (a, r) => n.sd(a, r, q.glass), i = n.screws;
  return yn(n, t, (a, r, l, h, c) => {
    const f = (Rt(h, c) - 0.5) * 0.07;
    for (const [k, d, x] of i) {
      const m = mn(a, r, k, d, x);
      if (m !== null) return m;
    }
    const p = e(a, r);
    if (p >= 0) {
      if (p < 0.018) {
        const [k, d] = At(e, a, r), x = 1 - p / 0.018, m = x * x * 1.25;
        return gt(-k * Math.sin(m), -d * Math.sin(m), Math.cos(m)) + f;
      }
      return f;
    }
    const M = o(a, r);
    if (M >= 0) {
      const k = M / O.gasket, [d, x] = At(o, a, r), m = (k - 0.45) * 2.2;
      return gt(d * Math.sin(m), x * Math.sin(m), Math.cos(m), 0.22, 14) * 0.7 + f * 0.4;
    }
    const b = 0.05;
    return -(0.5 * Ct(-0.012, 0.012, o(a - j[0] * b, r - j[1] * b)) + 0.32 * Math.exp(M / 0.014));
  });
}
function Bn(n, t) {
  const s = [-0.12, -0.065, -0.01, 0.045, 0.1], e = (i, a) => n.sd(i, a, q.plate + 0.04), o = n.backScrews;
  return yn(n, t, (i, a, r, l, h) => {
    const c = (Rt(l, h) - 0.5) * 0.07;
    for (const [p, M, b] of o) {
      const w = mn(i, a, p, M, b);
      if (w !== null) return w;
    }
    const f = e(i, a);
    if (Math.abs(f) < 6e-3) {
      const [p, M] = At(e, i, a), b = f / 6e-3 * 1.1;
      return gt(-p * Math.sin(b), -M * Math.sin(b), Math.cos(b)) * 0.9 - 0.18;
    }
    for (const p of s) {
      const M = (w, k) => Math.hypot(Math.max(0, Math.abs(w) - 0.196), k - p) - 0.014, b = M(i, a);
      if (b < 0)
        return -0.72 - 0.15 * Ct(-0.014, 0, -(a - p));
      if (b < 0.01) {
        const [w, k] = At(M, i, a), d = (1 - b / 0.01) ** 2 * 1.2;
        return gt(-w * Math.sin(d), -k * Math.sin(d), Math.cos(d)) + c;
      }
    }
    return c;
  });
}
function Fn(n, t, s, e, o, i) {
  const a = nt(n, t), r = a.getContext("2d"), l = r.createRadialGradient(n * 0.5, t * 0.45, 0, n * 0.5, t * 0.5, Math.max(n, t) * 0.65);
  l.addColorStop(0, "#111417"), l.addColorStop(1, "#050607"), r.fillStyle = l, r.fillRect(0, 0, n, t);
  const h = s * 0.8, c = (s - h) / 2, f = `rgba(${Math.round(60 + i[0] * 0.12)},${Math.round(64 + i[1] * 0.12)},${Math.round(70 + i[2] * 0.12)},0.34)`, p = -Math.ceil(e / s), M = Math.ceil((n - e) / s), b = -Math.ceil(o / s), w = Math.ceil((t - o) / s);
  r.fillStyle = f;
  for (let k = b; k < w; k++) for (let d = p; d < M; d++) r.fillRect(e + d * s + c, o + k * s + c, h, h);
  r.fillStyle = "rgba(255,255,255,0.05)";
  for (let k = b; k < w; k++) for (let d = p; d < M; d++) r.fillRect(e + d * s + c, o + k * s + c, h, Math.max(1, h * 0.16));
  return a;
}
function Zn(n, t) {
  const s = nt(n, t), e = s.getContext("2d"), o = e.createRadialGradient(n / 2, t / 2, Math.min(n, t) * 0.3, n / 2, t / 2, Math.hypot(n, t) * 0.55);
  o.addColorStop(0, "rgba(0,0,0,0)"), o.addColorStop(1, "rgba(0,0,0,0.5)"), e.fillStyle = o, e.fillRect(0, 0, n, t);
  const i = e.createLinearGradient(0, 0, 0, t);
  i.addColorStop(0, "rgba(190,210,255,0.09)"), i.addColorStop(0.42, "rgba(190,210,255,0.015)"), i.addColorStop(0.43, "rgba(190,210,255,0)"), e.fillStyle = i, e.fillRect(0, 0, n, t), e.save(), e.translate(n * 0.3, t * 0.2), e.scale(1, 0.45);
  const a = e.createRadialGradient(0, 0, 0, 0, 0, n * 0.35);
  return a.addColorStop(0, "rgba(255,255,255,0.07)"), a.addColorStop(1, "rgba(255,255,255,0)"), e.fillStyle = a, e.fillRect(-n, -t * 3, n * 2, t * 6), e.restore(), s;
}
function _n(n) {
  const t = nt(128, 128), s = t.getContext("2d"), e = s.createImageData(128, 128);
  for (let o = 0; o < 128 * 128; o++) {
    const a = Rt(o, 7) > 0.5 ? 255 : 0;
    e.data[o * 4] = e.data[o * 4 + 1] = e.data[o * 4 + 2] = a, e.data[o * 4 + 3] = Math.round(Rt(o, 13) * 9);
  }
  return s.putImageData(e, 0, 0), n.createPattern(t, "repeat");
}
const rn = /* @__PURE__ */ new Map();
function Dn(n, t) {
  const s = `${n.name}:${Math.round(t)}`;
  let e = rn.get(s);
  if (!e) {
    const o = _t(n);
    e = { front: Yn(n, t), back: Bn(n, t), glass: Zn(o.hx * 2 * t, o.hy * 2 * t) }, rn.set(s, e);
  }
  return e;
}
const tt = (n, t, s) => [n[0] + (t[0] - n[0]) * s, n[1] + (t[1] - n[1]) * s, n[2] + (t[2] - n[2]) * s];
class Kn {
  constructor() {
    this.shape = null, this.meshes = null, this.unit = 0, this.ledKey = "", this.front = null, this.back = null, this.screen = null, this.screenBase = null, this.glass = null, this.layer = null, this.tiny = nt(st, et), this.tinyHalf = nt(st / 2, et / 2), this.tinyImg = null, this.grain = null, this.grid = wt(st, et), this.gridPrev = wt(st, et), this.proj = new Float32Array(2048 * 3), this.screenGeo = { pitch: 0, x0: 0, y0: 0 };
  }
  prepare(t, s, e) {
    if (Math.abs(s - this.unit) > 0.5 || t !== this.shape) {
      this.unit = s, this.shape = t, this.meshes = Ln(t);
      const i = Dn(t, s);
      this.front = i.front, this.back = i.back, this.glass = i.glass;
      const a = _t(t);
      this.screen = nt(a.hx * 2 * s, a.hy * 2 * s), this.ledKey = "";
      const r = Zt(t);
      this.grid = wt(Math.ceil(r.hx * 2 / t.pitch), Math.ceil(r.hy * 2 / t.pitch)), this.gridPrev = wt(this.grid.cols, this.grid.rows), this.tiny = nt(this.grid.cols, this.grid.rows), this.tinyHalf = nt(Math.ceil(this.grid.cols / 2), Math.ceil(this.grid.rows / 2)), this.tinyImg = null;
      const l = t.pitch * s;
      this.screenGeo = {
        pitch: l,
        x0: (this.screen.width - l * this.grid.cols) / 2,
        y0: (this.screen.height - l * this.grid.rows) / 2
      };
    }
    const o = e.join(",");
    if (o !== this.ledKey && this.screen) {
      this.ledKey = o;
      const { pitch: i, x0: a, y0: r } = this.screenGeo;
      this.screenBase = Fn(this.screen.width, this.screen.height, i, a, r, e);
    }
  }
  /* the LED matrix for this frame */
  compose(t, s) {
    const e = this.grid, o = e.v, { cols: i, rows: a } = e;
    if (o.fill(0), !t)
      return Xt[s](e, { lookX: 0, lookY: 0, blink: 0, time: 0.4, side: 1, seed: 0 }), e;
    if (Xt[t.shown](e, t.face), t.switched < 0.3) {
      const r = this.gridPrev;
      r.v.fill(0), Xt[t.previous](r, { ...t.face, time: t.face.time + 10 });
      const l = t.switched / 0.3;
      for (let h = 0; h < o.length; h++) o[h] = o[h] * l + r.v[h] * (1 - l);
      if (t.switched < 0.13) {
        const h = Math.floor(t.time * 30);
        for (let c = 0; c < a; c++) {
          const f = Math.floor((Math.sin(h * 12.9 + c * 78.2) * 0.5 + 0.5) * 3) - 1;
          if (!f) continue;
          const p = o.slice(c * i, (c + 1) * i);
          for (let M = 0; M < i; M++) o[c * i + M] = p[(M - f + i) % i];
        }
        for (let c = 0; c < o.length; c++) Math.sin(c * 91.7 + h * 3.1) > 0.93 && (o[c] = Math.max(o[c], 0.3));
      }
    }
    if (t.age < 0.55) {
      const r = Ct(0.08, 0.5, t.age) * (a / 2 + 0.5);
      for (let l = 0; l < a; l++) {
        const h = Math.abs(l - (a - 1) / 2);
        for (let c = 0; c < i; c++) {
          const f = l * i + c;
          h > r ? o[f] = 0 : h > r - 1.2 && (o[f] = Math.max(o[f], 0.85 * (1 - t.age / 0.55)));
        }
      }
    }
    return e;
  }
  drawScreen(t, s) {
    const o = this.screen.getContext("2d"), { cols: i, rows: a, v: r } = t;
    o.globalCompositeOperation = "source-over", o.globalAlpha = 1, o.drawImage(this.screenBase, 0, 0);
    const { pitch: l, x0: h, y0: c } = this.screenGeo, p = `rgb(${tt(s, [255, 255, 255], 0.6).map(Math.round).join(",")})`, M = `rgb(${s.map(Math.round).join(",")})`, b = l * 0.8, w = (l - b) / 2;
    for (let m = 0; m < a; m++)
      for (let I = 0; I < i; I++) {
        const u = r[m * i + I];
        u < 0.01 || (o.globalAlpha = Math.min(1, u * 0.4), o.fillStyle = M, o.fillRect(h + I * l + w * 0.4, c + m * l + w * 0.4, l - w * 0.8, l - w * 0.8), o.globalAlpha = Math.min(1, u), o.fillStyle = p, o.fillRect(h + I * l + w, c + m * l + w, b, b));
      }
    const k = this.tiny.getContext("2d");
    this.tinyImg || (this.tinyImg = k.createImageData(i, a));
    const d = this.tinyImg.data;
    for (let m = 0; m < i * a; m++)
      d[m * 4] = s[0], d[m * 4 + 1] = s[1], d[m * 4 + 2] = s[2], d[m * 4 + 3] = Math.round(Math.min(1, r[m]) * 255);
    k.putImageData(this.tinyImg, 0, 0);
    const x = this.tinyHalf.getContext("2d");
    x.clearRect(0, 0, this.tinyHalf.width, this.tinyHalf.height), x.imageSmoothingEnabled = !0, x.drawImage(this.tiny, 0, 0, this.tinyHalf.width, this.tinyHalf.height), o.imageSmoothingEnabled = !0, o.globalCompositeOperation = "lighter", o.globalAlpha = 0.7, o.drawImage(this.tiny, h, c, i * l, a * l), o.globalAlpha = 0.65, o.drawImage(this.tinyHalf, h - l, c - l, (i + 2) * l, (a + 2) * l), o.globalCompositeOperation = "source-over", o.globalAlpha = 1, o.drawImage(this.glass, 0, 0);
  }
  /** Draw a frame; `frame` is in CSS px, the canvas in device px (`dpr` per CSS px). */
  draw(t, s, e, o, i, a, r, l, h) {
    const c = s.unit * e, f = gn(r), p = Zt(r), M = _t(r), b = i ? i.shown : a, w = Ot[b];
    let k = w.screen ?? l.led;
    if (i && i.switched < 0.3) {
      const y = Ot[i.previous].screen ?? l.led;
      k = tt(y, k, i.switched / 0.3).map(Math.round);
    }
    this.prepare(r, c, k), (!this.layer || this.layer.width !== t.canvas.width || this.layer.height !== t.canvas.height) && (this.layer = nt(t.canvas.width, t.canvas.height), this.grain = _n(t));
    const d = this.layer.getContext("2d"), x = Vt(o.yaw, o.pitch, o.roll), m = s.cx * e + o.x * c, I = s.cy * e, u = I - o.lift * c, v = u + r.hy * c, A = (y, g, X) => {
      const R = at(x, y, g, X);
      return [m + R[0] * c * o.sx, v + (u + R[1] * c - v) * o.sy, R[2]];
    }, P = (y, g, X) => {
      const R = A(0, 0, g), E = A(X ? -1 : 1, 0, g), Y = A(0, 1, g);
      y.setTransform(E[0] - R[0], E[1] - R[1], Y[0] - R[0], Y[1] - R[1], R[0], R[1]);
    };
    if (t.setTransform(1, 0, 0, 1, 0, 0), t.clearRect(0, 0, t.canvas.width, t.canvas.height), h.floorShadow) {
      const y = Math.max(0, o.lift), g = I + (r.hy + 0.11) * c, X = c * r.hx * (1 - y * 0.9) * o.sx;
      t.save(), t.translate(s.cx * e + o.x * c, g), t.scale(1, 0.16);
      const R = t.createRadialGradient(0, 0, 0, 0, 0, X), E = 0.55 * Math.max(0, 1 - y * 1.6);
      R.addColorStop(0, `rgba(0,0,0,${E})`), R.addColorStop(0.55, `rgba(0,0,0,${E * 0.45})`), R.addColorStop(1, "rgba(0,0,0,0)"), t.fillStyle = R, t.beginPath(), t.arc(0, 0, X, 0, Math.PI * 2), t.fill(), t.restore();
    }
    const { body: T, earL: L, earR: C, collar: S } = this.meshes, $ = at(x, -r.earX - 0.05, O.earY, 0)[2], V = at(x, r.earX + 0.05, O.earY, 0)[2], W = at(x, 0, -r.hy, 0)[2] < -0.012, U = (y, g, X) => {
      const R = g.pos.length / 3, E = this.proj;
      for (let H = 0; H < R; H++) {
        const ot = A(g.pos[H * 3], g.pos[H * 3 + 1], g.pos[H * 3 + 2]);
        E[H * 3] = ot[0], E[H * 3 + 1] = ot[1], E[H * 3 + 2] = ot[2];
      }
      const Y = [], N = g.quads, F = g.normals;
      for (let H = 0; H < N.length / 4; H++) {
        if (x[6] * F[H * 3] + x[7] * F[H * 3 + 1] + x[8] * F[H * 3 + 2] < -0.03) continue;
        const Pt = E[N[H * 4] * 3 + 2] + E[N[H * 4 + 1] * 3 + 2] + E[N[H * 4 + 2] * 3 + 2] + E[N[H * 4 + 3] * 3 + 2];
        Y.push([Pt, H]);
      }
      Y.sort((H, ot) => H[0] - ot[0]), y.lineWidth = Math.max(0.6, c / 260), y.lineJoin = "round";
      for (const [, H] of Y) {
        const ot = F[H * 3], Pt = F[H * 3 + 1], Sn = F[H * 3 + 2], Et = at(x, ot, Pt, Sn), Dt = on(X, Et[0], Et[1], Et[2]);
        y.beginPath();
        for (let yt = 0; yt < 4; yt++) {
          const mt = N[H * 4 + yt] * 3;
          yt ? y.lineTo(E[mt], E[mt + 1]) : y.moveTo(E[mt], E[mt + 1]);
        }
        y.closePath(), y.fillStyle = Dt, y.strokeStyle = Dt, y.fill(), y.stroke();
      }
    }, G = () => this.drawAntenna(t, A, c, o, l, i, b, w, S, h.antenna);
    W && G(), $ < 0 && U(t, L, l.trim), V < 0 && U(t, C, l.trim), d.setTransform(1, 0, 0, 1, 0, 0), d.globalCompositeOperation = "source-over", d.clearRect(0, 0, this.layer.width, this.layer.height), U(d, T, l.shell);
    const Z = x[8], _ = r.depth / 2, B = Math.abs(Z) > 5e-3 ? Z > 0 ? 1 : -1 : 0;
    if (B) {
      P(d, B * _, B < 0);
      const g = (E, Y) => {
        const N = at(x, E * (B < 0 ? -1 : 1), Y, B), F = Math.hypot(N[0], N[1], N[2]);
        return Mn(pn(l.shell, N[0] / F, N[1] / F, N[2] / F));
      };
      d.beginPath(), r.path(d, q.plate - 2e-3);
      const X = d.createLinearGradient(0, -f.hy, 0, f.hy);
      X.addColorStop(0, g(0, -0.17)), X.addColorStop(0.5, g(0, 0)), X.addColorStop(1, g(0, 0.17)), d.fillStyle = X, d.fill();
      const R = d.createLinearGradient(-f.hx, 0, f.hx, 0);
      R.addColorStop(0, g(-0.17, 0)), R.addColorStop(0.5, g(0, 0)), R.addColorStop(1, g(0.17, 0)), d.globalAlpha = 0.5, d.fillStyle = R, d.fill(), d.globalAlpha = 1;
    }
    if (this.grain) {
      d.setTransform(1, 0, 0, 1, 0, 0), d.globalCompositeOperation = "source-atop";
      const y = typeof DOMMatrix == "function" ? new DOMMatrix().translate(m, u) : null;
      y && "setTransform" in this.grain && this.grain.setTransform(y), d.fillStyle = this.grain, d.fillRect(0, 0, this.layer.width, this.layer.height), d.globalCompositeOperation = "source-over";
    }
    if (t.drawImage(this.layer, 0, 0), B > 0) {
      t.save(), P(t, _, !1), t.beginPath(), r.path(t, q.hole), t.fillStyle = "#060709", t.fill(), t.save(), t.beginPath(), r.path(t, q.glass), t.clip(), this.drawScreen(this.compose(i, a), k), P(t, _ - O.recess, !1), t.drawImage(this.screen, -M.hx, -M.hy, M.hx * 2, M.hy * 2), P(t, _, !1);
      const y = -0.05 - o.yaw * 0.9 + o.pitch * 0.5, g = t.createLinearGradient(-0.55 + y, -0.35, 0.15 + y, 0.35);
      g.addColorStop(0, "rgba(255,255,255,0)"), g.addColorStop(0.36, "rgba(255,255,255,0)"), g.addColorStop(0.43, "rgba(220,232,255,0.075)"), g.addColorStop(0.5, "rgba(255,255,255,0)"), g.addColorStop(0.58, "rgba(255,255,255,0)"), g.addColorStop(0.61, "rgba(220,232,255,0.04)"), g.addColorStop(0.65, "rgba(255,255,255,0)"), t.fillStyle = g, t.fillRect(-p.hx, -p.hy, p.hx * 2, p.hy * 2), t.restore(), t.drawImage(this.front, -f.hx, -f.hy, f.hx * 2, f.hy * 2), t.restore();
    } else B < 0 && (t.save(), P(t, -_, !0), t.drawImage(this.back, -f.hx, -f.hy, f.hx * 2, f.hy * 2), t.restore());
    $ >= 0 && U(t, L, l.trim), V >= 0 && U(t, C, l.trim), W || G(), t.setTransform(1, 0, 0, 1, 0, 0);
  }
  drawAntenna(t, s, e, o, i, a, r, l, h, c) {
    const f = Vt(o.yaw, o.pitch, o.roll), p = this.proj, M = h.pos.length / 3;
    for (let y = 0; y < M; y++) {
      const g = s(h.pos[y * 3], h.pos[y * 3 + 1], h.pos[y * 3 + 2]);
      p[y * 3] = g[0], p[y * 3 + 1] = g[1], p[y * 3 + 2] = g[2];
    }
    const b = h.quads, w = h.normals;
    t.lineWidth = Math.max(0.6, e / 260);
    for (let y = 0; y < b.length / 4; y++) {
      const g = at(f, w[y * 3], w[y * 3 + 1], w[y * 3 + 2]);
      if (g[2] < -0.03) continue;
      const X = on(i.trim, g[0], g[1], g[2]);
      t.beginPath();
      for (let R = 0; R < 4; R++) {
        const E = b[y * 4 + R] * 3;
        R ? t.lineTo(p[E], p[E + 1]) : t.moveTo(p[E], p[E + 1]);
      }
      t.closePath(), t.fillStyle = X, t.strokeStyle = X, t.fill(), t.stroke();
    }
    if (!c) return;
    const k = -this.shape.hy - 0.028, d = O.stem, x = o.antennaX, m = o.antennaZ, I = [Math.sin(x), -Math.cos(x) * Math.cos(m), Math.sin(m)], u = s(0, k, 0), v = s(0, k - d * 0.55, 0), A = s(I[0] * d, k + I[1] * d, I[2] * d), P = s(I[0] * (d + O.ball * 0.8), k + I[1] * (d + O.ball * 0.8), I[2] * (d + O.ball * 0.8));
    t.lineCap = "round", t.beginPath(), t.moveTo(u[0], u[1]), t.quadraticCurveTo(v[0], v[1], A[0], A[1]), t.lineWidth = e * 0.02, t.strokeStyle = "#4a5260", t.stroke(), t.lineWidth = e * 9e-3, t.strokeStyle = "#9aa3b1", t.stroke(), t.save(), t.translate(-e * 4e-3, 0), t.lineWidth = e * 4e-3, t.strokeStyle = "rgba(255,255,255,0.75)", t.stroke(), t.restore();
    let T = l.ball, L = l.pulse(a ? a.face.time : 0.3);
    if (a && a.switched < 0.3) {
      const y = Ot[a.previous], g = a.switched / 0.3;
      T = tt(y.ball, T, g), L = y.pulse(a.face.time + 10) * (1 - g) + L * g;
    }
    a && a.age < 0.55 && (L *= Ct(0.1, 0.5, a.age));
    const C = O.ball * e * o.sx, [S, $] = P, D = tt([168, 174, 186], tt(T, [255, 255, 255], 0.35), L), W = tt([150, 158, 172], T, 0.5), U = tt(D, W, 0.48), G = tt([70, 76, 88], tt(T, [90, 96, 108], 0.5), L * 0.55), Z = t.createRadialGradient(S - C * 0.18, $ - C * 0.22, C * 0.05, S, $, C);
    if (Z.addColorStop(0, `rgb(${tt(D, [255, 255, 255], 0.6 + L * 0.3).map(Math.round).join(",")})`), Z.addColorStop(0.38, `rgb(${D.map(Math.round).join(",")})`), Z.addColorStop(0.78, `rgb(${U.map(Math.round).join(",")})`), Z.addColorStop(1, `rgb(${G.map(Math.round).join(",")})`), L > 0.01) {
      t.globalCompositeOperation = "lighter";
      const y = t.createRadialGradient(S, $, C * 0.6, S, $, C * 4.2), g = T.map(Math.round).join(",");
      y.addColorStop(0, `rgba(${g},${0.5 * L})`), y.addColorStop(0.35, `rgba(${g},${0.14 * L})`), y.addColorStop(1, `rgba(${g},0)`), t.fillStyle = y, t.beginPath(), t.arc(S, $, C * 4.2, 0, Math.PI * 2), t.fill(), t.globalCompositeOperation = "source-over";
    }
    const _ = t.createRadialGradient(S, $ + C * 0.9, 0, S, $ + C * 0.9, C * 0.7);
    _.addColorStop(0, "rgba(20,24,32,0.28)"), _.addColorStop(1, "rgba(20,24,32,0)"), t.fillStyle = _, t.beginPath(), t.arc(S, $ + C * 0.9, C * 0.7, 0, Math.PI * 2), t.fill(), t.beginPath(), t.arc(S, $, C, 0, Math.PI * 2), t.fillStyle = Z, t.fill(), t.lineWidth = Math.max(0.75, C * 0.07), t.strokeStyle = "rgba(28,32,42,0.28)", t.stroke();
    const B = t.createRadialGradient(S - C * 0.38, $ - C * 0.42, 0, S - C * 0.38, $ - C * 0.42, C * 0.38);
    B.addColorStop(0, "rgba(255,255,255,0.95)"), B.addColorStop(1, "rgba(255,255,255,0)"), t.fillStyle = B, t.fill();
  }
}
function Yt(n) {
  const t = n.trim(), s = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (s) {
    const o = s[1].length === 3 ? s[1].replace(/./g, (a) => a + a) : s[1], i = parseInt(o, 16);
    return [i >> 16 & 255, i >> 8 & 255, i & 255];
  }
  const e = t.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return e ? [Number(e[1]), Number(e[2]), Number(e[3])] : null;
}
const ht = { x: NaN, y: NaN }, pt = /* @__PURE__ */ new Set();
let lt = 0, vt = 0, hn = !1;
const BLOBLEX_FRAME_MS = 1000 / 30;
function bn(n) {
  lt = 0;
  if (vt && n - vt < BLOBLEX_FRAME_MS - 2) {
    pt.size && (lt = requestAnimationFrame(bn));
    return;
  }
  const t = vt ? Math.min(0.1, (n - vt) / 1e3) : 0;
  vt = n, pt.forEach((s) => s(t)), pt.size && (lt = requestAnimationFrame(bn));
}
function wn() {
  lt || typeof document > "u" || document.hidden || (vt = 0, lt = requestAnimationFrame(bn));
}
function kn() {
  lt && cancelAnimationFrame(lt), lt = 0;
}
function Vn() {
  if (hn || typeof document > "u") return;
  hn = !0;
  const n = () => {
    ht.x = NaN, ht.y = NaN;
  };
  document.addEventListener("pointermove", (t) => {
    ht.x = t.clientX, ht.y = t.clientY;
  }, { passive: !0 }), document.addEventListener("pointerleave", n), window.addEventListener("blur", n), document.addEventListener("visibilitychange", () => {
    document.hidden ? kn() : pt.size && wn();
  });
}
function Wn(n) {
  return Vn(), pt.add(n), wn(), () => {
    pt.delete(n), pt.size || kn();
  };
}
const Un = ["rectangle", "square", "circle", "hexagon"], ns = ["idle", "thinking", "searching", "listening", "speaking", "working", "happy", "error", "sleeping"], ln = {
  idle: "idle",
  thinking: "thinking",
  searching: "searching",
  listening: "listening",
  speaking: "speaking",
  working: "working",
  happy: "happy",
  error: "error",
  sleeping: "sleeping"
};
function Jn(n) {
  let t = 2166136261;
  for (let s = 0; s < n.length; s++) t = Math.imul(t ^ n.charCodeAt(s), 16777619);
  return (t >>> 0) % 1e3 / 1e3;
}
const zn = () => typeof matchMedia == "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function cn(n, t, s) {
  const e = Yt(n) ?? [48, 80, 172], o = Yt(t) ?? [150, 168, 200], i = Yt(s) ?? [232, 242, 255];
  return {
    shell: { albedo: en(e), f0: 0.05, metal: 0.15, spec: 0.55, shininess: 70, rim: 0.9 },
    trim: { albedo: en(o), f0: 0.2, metal: 0.65, spec: 0.8, shininess: 45, rim: 0.7 },
    led: i
  };
}
const ss = xn(function({
  model: t = "tv",
  shape: s = "rectangle",
  state: e = "idle",
  size: o = 160,
  color: i = "#2b49a3",
  trimColor: a = "#93a6c8",
  screenColor: r = "#e8f2ff",
  speed: l = 1,
  paused: h = !1,
  interactive: c = !0,
  floorShadow: f = !0,
  antenna: p = !0,
  seed: M,
  className: b,
  style: w,
  onClick: k,
  "aria-label": d,
  ...x
}, m) {
  const I = J(null), u = J(null);
  vn(m, () => u.current);
  const v = Cn(), A = e in ln ? e : "idle", P = Un.includes(s) ? s : "rectangle", T = Math.min(1, Math.max(0, M ?? Jn(v))), L = h || !(l > 0), C = J(null), S = J(null), $ = J(cn(i, a, r));
  $.current = cn(i, a, r);
  const V = J(l);
  V.current = l;
  const D = J(c);
  D.current = c;
  const W = J(f);
  W.current = f;
  const U = J(p);
  U.current = p, C.current || (C.current = new $n(T, A)), C.current.setState(A);
  const G = Gn(Jt(P), p, o), Z = J(G);
  Z.current = G;
  const _ = (y) => {
    const g = u.current;
    if (!g) return;
    const R = Z.current, X = Math.min(R.box <= 80 ? 1.5 : 2, typeof devicePixelRatio == "number" && devicePixelRatio || 1), E = Math.round((R.box + 2 * R.padSide) * X), Y = Math.round((R.box + R.padTop + R.padBottom) * X);
    (g.width !== E || g.height !== Y) && (g.width = E, g.height = Y);
    const N = g.getContext("2d");
    if (!N) return;
    S.current || (S.current = new Kn());
    const F = C.current;
    S.current.draw(N, R, X, y ? F.pose : Xn(A), y ? F : null, A, Jt(P), $.current, { floorShadow: W.current, antenna: U.current });
  };
  Rn(() => {
    if (L || zn()) {
      _(!1);
      return;
    }
    let acc = 0;
    return Wn((y) => {
      // Bloblex: avatars of 80px or less update at ~15 fps; their motion is small.
      acc += y;
      if (Z.current.box <= 80 && acc < 1 / 15 - 0.004) return;
      y = acc, acc = 0;
      const g = C.current, X = I.current;
      if (X && D.current && Number.isFinite(ht.x)) {
        const R = X.getBoundingClientRect(), E = Z.current, Y = ht.x - (R.left + R.width / 2), N = ht.y - (R.top + E.cy - E.padTop);
        g.pointer = Math.hypot(Y, N) < 700 ? { x: Y, y: N } : null;
      } else g.pointer = null;
      g.update(y * V.current), _(!0);
    });
  }, [L, o, A, P, i, a, r, f, p]);
  const B = (y) => {
    var g;
    c && !L && ((g = C.current) == null || g.poke()), k == null || k(y);
  };
  return /* @__PURE__ */ Kt(
    "span",
    {
      ref: I,
      role: "img",
      "aria-label": d ?? `Robot, ${ln[A]}`,
      className: b,
      onClick: B,
      style: { position: "relative", display: "block", flex: "none", width: o, height: o, cursor: c ? "pointer" : void 0, ...w },
      ...x,
      children: /* @__PURE__ */ Kt(
        "canvas",
        {
          ref: u,
          "aria-hidden": !0,
          style: {
            position: "absolute",
            left: -G.padSide,
            top: -G.padTop,
            width: G.box + 2 * G.padSide,
            height: G.box + G.padTop + G.padBottom,
            display: "block",
            pointerEvents: "none"
          }
        }
      )
    }
  );
});
export {
  ss as RobotHead,
  Un as robotHeadShapes,
  ns as robotHeadStates
};
