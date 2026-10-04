import type { Outfit } from './outfit'
import { BADGE_CLEARANCE, BADGE_OFFSET, BADGE_RADIUS, clearAccessoryOfBadge } from './blobGeometry'

export interface WardrobeEyeFrame { x: number; y: number; width: number; height: number; rotation: number; visible: boolean }
type Point2 = { x: number; y: number }
type Point3 = [number, number, number]
type ProjectedPoint = Point2 & { z: number; lon?: number; a?: number }
interface OutfitEye { sd: -1 | 1; visible: boolean; x: number; y: number; fx: number; fy: number; w: number; h: number }
interface OutfitHead { R: number; rx: number; ry: number; view: number; yaw: number; pitch: number; phys: { dx: number; dy: number }; eyes: WardrobeEyeFrame[]; presence: number; roll: number }
interface OutfitDrawer { back?: (ctx: CanvasRenderingContext2D, H: OutfitHead) => void; front?: (ctx: CanvasRenderingContext2D, H: OutfitHead, path: Path2D) => void; frontAfterEyes?: boolean; bodyColors?: [string, string] }
interface CrownGeometry { s: number; yb: number; yt: number; n: number; spikeH: number }
interface EvenOddPath extends Path2D { __evenodd?: boolean }
const EXP = 2.7;
const VIEW_TILT = -0.30;
const ACC_PITCH = 0.4;

function ringR(y: number): number { const a = Math.min(1, Math.abs(y)); return Math.pow(1 - Math.pow(a, EXP), 1 / EXP); }
function rot(p: Point3, yaw: number, pitch: number): Point3 {
  let [x, y, z] = p;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  let y2 = y * cp + z1 * sp, z2 = -y * sp + z1 * cp;
  return [x1, y2, z2];
}
function proj(H: OutfitHead, p: Point3): ProjectedPoint {
  const r = rot(p, H.yaw, (H.view || 0) + H.pitch * ACC_PITCH);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}
function surf(y: number, lon: number, s = 1): Point3 { const r = ringR(y) * s; return [r * Math.sin(lon), y, r * Math.cos(lon)]; }

function blobOutfitPath(rx: number, ry: number): Path2D {
  const p = new Path2D(); const n = 96, e = 2 / EXP;
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    const x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), e);
    const y = ry * Math.sign(sa) * Math.pow(Math.abs(sa), e);
    i ? p.lineTo(x, y) : p.moveTo(x, y);
  }
  p.closePath(); return p;
}

function lin(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, c]) => g.addColorStop(o, c)); return g;
}
function rad(ctx: CanvasRenderingContext2D, x: number, y: number, r0: number, r1: number, stops: [number, string][]): CanvasGradient {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([o, c]) => g.addColorStop(o, c)); return g;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function ringPoints(H: OutfitHead, y: number, s: number, n = 72): ProjectedPoint[] {
  const pts: ProjectedPoint[] = [];
  for (let i = 0; i <= n; i++) { const lon = -Math.PI + i / n * 2 * Math.PI; pts.push({ lon, ...proj(H, surf(y, lon, s)) }); }
  return pts;
}
function frontArc(H: OutfitHead, y: number, s: number): ProjectedPoint[] {
  const pts = ringPoints(H, y, s, 120).filter(p => p.z >= -0.02);
  pts.sort((a, b) => a.x - b.x); return pts;
}
function capClip(H: OutfitHead, y: number, s: number, extraTop = 3): Path2D {
  const arc = frontArc(H, y, s);
  const p = new Path2D();
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  p.lineTo(arc[arc.length - 1].x + H.rx, arc[arc.length - 1].y);
  p.lineTo(H.rx * 2, -H.ry * extraTop); p.lineTo(-H.rx * 2, -H.ry * extraTop); p.closePath();
  return p;
}
function frontRun(ring: ProjectedPoint[]): ProjectedPoint[] {
  const n = ring.length - 1; let start = -1;
  for (let i = 0; i < n; i++) if (ring[i].z >= 0 && ring[(i - 1 + n) % n].z < 0) { start = i; break; }
  if (start < 0) { // whole ring visible (seen from above): use its lower half
    const my = ring.reduce((s, q) => s + q.y, 0) / ring.length;
    return ring.filter(q => q.y >= my).sort((a, b) => a.x - b.x);
  }
  const out = []; for (let k = 0; k < n; k++) { const q = ring[(start + k) % n]; if (q.z < 0) break; out.push(q); }
  if (out.length > 1 && out[0].x > out[out.length - 1].x) out.reverse();
  return out;
}
function strokeArc(ctx: CanvasRenderingContext2D, arc: ProjectedPoint[]): void { ctx.beginPath(); arc.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); }
function pompom(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, base = '#FFFFFF', shade = '#D5D9E2'): void {
  ctx.save(); ctx.translate(x, y);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78, by = Math.sin(a) * r * 0.78;
    ctx.fillStyle = rad(ctx, bx - br * 0.4, by - br * 0.5, 0, br * 1.3, [[0, base], [1, shade]]);
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = rad(ctx, -r * 0.3, -r * 0.35, 0, r * 1.05, [[0, base], [0.7, base], [1, shade]]);
  ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function fuzzyBand(ctx: CanvasRenderingContext2D, arc: ProjectedPoint[], thick: number, base = '#FFFFFF', shade = '#DADDE4'): void {
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  strokeArc(ctx, arc); ctx.strokeStyle = shade; ctx.lineWidth = thick; ctx.stroke();
  strokeArc(ctx, arc); ctx.strokeStyle = base; ctx.lineWidth = thick * 0.78; ctx.stroke();
  const step = Math.max(2, Math.floor(arc.length / 16));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i]; const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    ctx.fillStyle = rad(ctx, q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, 0, r * 1.2, [[0, base], [1, shade]]);
    ctx.beginPath(); ctx.arc(q.x, q.y - thick * 0.32, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
export function qb(p0: Point2, p1: Point2, p2: Point2, t: number): Point2 { const u = 1 - t; return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y }; }
export function qbd(p0: Point2, p1: Point2, p2: Point2, t: number): Point2 { const u = 1 - t; return { x: 2 * u * (p1.x - p0.x) + 2 * t * (p2.x - p1.x), y: 2 * u * (p1.y - p0.y) + 2 * t * (p2.y - p1.y) }; }

const OUTFIT_DRAWERS: Record<string, OutfitDrawer> = {};
OUTFIT_DRAWERS.beanie = {
  front(ctx, H, path) {
    const s = 1.035, yEdge = 0.42, yCuff = 0.58;
    const head = blobOutfitPath(H.rx * s, H.ry * s);
    ctx.save(); ctx.clip(path); ctx.clip(capClip(H, yEdge - 0.12, 1));
    ctx.fillStyle = 'rgba(30,40,70,0.10)'; ctx.fill(path); ctx.restore();
    ctx.save(); ctx.clip(capClip(H, yCuff, s));
    ctx.fillStyle = lin(ctx, H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2, [[0, '#7DB6FF'], [1, '#2F6FE0']]);
    ctx.fill(head);
    ctx.clip(head);
    for (let k = -6; k <= 6; k++) {
      const lon = k * 0.24; const pts = [];
      for (let i = 0; i <= 16; i++) { const y = yCuff + (1.05 - yCuff) * i / 16; const q = proj(H, surf(y, lon, s)); if (q.z > 0) pts.push(q); }
      if (pts.length < 2) continue;
      ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
      ctx.strokeStyle = 'rgba(20,50,140,0.16)'; ctx.lineWidth = H.R * 0.045; ctx.stroke();
    }
    ctx.restore();
    ctx.save(); ctx.clip(capClip(H, yEdge, s * 1.04)); ctx.clip(invert(capClip(H, yCuff, s * 1.04), H));
    const cuffHead = blobOutfitPath(H.rx * s * 1.04, H.ry * s * 1.04);
    ctx.fillStyle = lin(ctx, 0, -H.ry * 0.6, 0, -H.ry * 0.2, [[0, '#3C7BEA'], [1, '#2257C4']]);
    ctx.fill(cuffHead);
    ctx.clip(cuffHead);
    for (let k = -14; k <= 14; k++) {
      const lon = k * 0.115; const a = proj(H, surf(yEdge, lon, s * 1.04)), b = proj(H, surf(yCuff, lon, s * 1.04));
      if (a.z < 0) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = 'rgba(10,30,100,0.22)'; ctx.lineWidth = H.R * 0.035; ctx.stroke();
    }
    ctx.restore();
    ctx.save(); ctx.clip(capClip(H, yCuff, s)); ctx.clip(head);
    ctx.fillStyle = rad(ctx, H.rx * 0.3, -H.ry * 0.85, 0, H.R * 0.45, [[0, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
    ctx.fill(head); ctx.restore();
    const top = proj(H, [0, 1.08 * s, 0]);
    pompom(ctx, top.x + H.phys.dx * H.rx * 0.25, top.y - H.R * 0.12 + H.phys.dy * H.ry * 0.15, H.R * 0.24);
  }
};
function invert(p: Path2D, H: OutfitHead): EvenOddPath {
  const q = new Path2D() as EvenOddPath; q.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8); q.addPath(p); q.__evenodd = true; return q;
}
OUTFIT_DRAWERS.santaHat = {
  front(ctx, H, path) {
    const s = 1.05, yEdge = 0.52;
    const arc = frontArc(H, yEdge, s);
    const L = arc[0], Rt = arc[arc.length - 1];
    const crown = proj(H, [0, 1.05, 0]);
    const side = 1;
    const tip = { x: crown.x + side * H.rx * (0.95 + H.phys.dx * 0.35), y: crown.y + H.ry * (0.05 + H.phys.dy * 0.2) };
    const peak = { x: crown.x + side * H.rx * 0.25, y: crown.y - H.ry * 0.62 };
    const bag = new Path2D();
    bag.moveTo(L.x, L.y);
    bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
    bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
    bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
    bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
    for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
    bag.closePath();
    ctx.save(); ctx.clip(path); ctx.clip(capClip(H, yEdge - 0.14, 1)); ctx.fillStyle = 'rgba(120,10,10,0.10)'; ctx.fill(path); ctx.restore();
    ctx.fillStyle = lin(ctx, -H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3, [[0, '#FF6B6B'], [0.55, '#E53935'], [1, '#B71C1C']]);
    ctx.fill(bag);
    ctx.save(); ctx.clip(bag);
    ctx.lineCap = 'round';
    for (const [a, b, w] of [[0.15, 0.55, 0.10], [0.45, 0.85, 0.08]]) {
      ctx.beginPath();
      ctx.moveTo(peak.x - H.rx * 0.1 + (Rt.x - L.x) * a * 0.3, peak.y + H.ry * 0.15);
      ctx.quadraticCurveTo(peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3), tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12);
      ctx.strokeStyle = 'rgba(90,0,0,0.20)'; ctx.lineWidth = H.R * w; ctx.stroke();
    }
    ctx.fillStyle = rad(ctx, peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, 0, H.R * 0.5, [[0, 'rgba(255,255,255,0.32)'], [1, 'rgba(255,255,255,0)']]);
    ctx.fill(bag);
    ctx.restore();
    fuzzyBand(ctx, arc, H.R * 0.3);
    pompom(ctx, tip.x, tip.y + H.R * 0.04, H.R * 0.22);
  }
};
OUTFIT_DRAWERS.partyHat = {
  front(ctx, H, _path) {
    const baseY = 0.82, baseR = 0.42, lean = -0.24 + H.phys.dx * 0.12;
    const c = proj(H, [0.16, baseY + 0.06, 0]);
    const ring = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; ring.push(proj(H, [0.16 + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)])); }
    let left = ring.reduce((m, q) => q.x < m.x ? q : m), right = ring.reduce((m, q) => q.x > m.x ? q : m);
    const h = H.ry * 1.6;
    const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
    const front = frontRun(ring);
    const cone = new Path2D();
    cone.moveTo(left.x, left.y);
    cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
    cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
    cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
    for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
    cone.closePath();
        ctx.fillStyle = lin(ctx, left.x, apex.y, right.x, left.y, [[0, '#FF9BD0'], [0.5, '#F15BAE'], [1, '#C2187A']]);
    ctx.fill(cone);
    ctx.save(); ctx.clip(cone);
    const dots = [[0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28], [0.8, -0.3], [0.45, 0.6], [0.48, -0.65]];
    for (const [t, u] of dots) {
      const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
      const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
      const x = bx + (apex.x - bx) * (1 - t) * 0.0 + (apex.x - bx) * (1 - t);
      const y = by + (apex.y - by) * (1 - t);
      const r = H.R * 0.075 * (0.6 + t * 0.5);
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.9, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
    }
    ctx.fillStyle = lin(ctx, left.x, 0, right.x, 0, [[0, 'rgba(255,255,255,0.28)'], [0.35, 'rgba(255,255,255,0)'], [1, 'rgba(80,0,40,0.18)']]);
    ctx.fill(cone);
    ctx.restore();
    ctx.beginPath(); front.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
    ctx.strokeStyle = '#FFD84D'; ctx.lineWidth = H.R * 0.07; ctx.lineCap = 'round'; ctx.stroke();
    pompom(ctx, apex.x, apex.y - H.R * 0.04, H.R * 0.16, '#FFE27A', '#F2B705');
  }
};
function crownGeom(_H: OutfitHead): CrownGeometry {
  const s = 1.06, yb = 0.46, yt = 0.66, n = 8;
  return { s, yb, yt, n, spikeH: 0.42 };
}
function crownPart(ctx: CanvasRenderingContext2D, H: OutfitHead, side: number): void { // side: -1 back half, +1 front half
  const { s, yb, yt, n, spikeH } = crownGeom(H);
  const N = 120; const seg = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + i / N * 2 * Math.PI;
    const b = proj(H, surf(yb, lon, s)), t = proj(H, surf(yt, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n; const f = phase - Math.floor(phase);
    const spike = Math.pow(Math.max(0, 1 - Math.abs(f - 0.5) * 2), 1.6); // 0..1 peak at middle
    const topY = yt + spikeH * spike;
    const tt = proj(H, [surf(yt, lon, s)[0] * (1 - 0.08 * spike), topY, surf(yt, lon, s)[2] * (1 - 0.08 * spike)]);
    seg.push({ lon, b, t, tt, z: b.z, spike });
  }
  const keep = seg.filter(q => side > 0 ? q.z >= 0 : q.z < 0.02);
  if (keep.length < 2) return;
  keep.sort((a, b) => a.b.x - b.b.x);
  const shape = new Path2D();
  keep.forEach((q, i) => i ? shape.lineTo(q.tt.x, q.tt.y) : shape.moveTo(q.tt.x, q.tt.y));
  for (let i = keep.length - 1; i >= 0; i--) shape.lineTo(keep[i].b.x, keep[i].b.y);
  shape.closePath();
  const dark = side < 0;
  ctx.fillStyle = lin(ctx, 0, -H.ry * 1.05, 0, -H.ry * 0.45, dark ? [[0, '#C98A12'], [1, '#8A5A06']] : [[0, '#FFE58A'], [0.5, '#FBBF24'], [1, '#D08A0B']]);
  ctx.fill(shape);
  if (!dark) {
    ctx.save(); ctx.clip(shape);
    ctx.fillStyle = lin(ctx, -H.rx, 0, H.rx, 0, [[0, 'rgba(120,70,0,0.25)'], [0.45, 'rgba(255,255,255,0.0)'], [0.62, 'rgba(255,255,255,0.35)'], [1, 'rgba(120,70,0,0.25)']]);
    ctx.fill(shape); ctx.restore();
    const gems = ['#EF4444', '#3B82F6', '#22C55E', '#A855F7'];
    for (let k = 0; k < n; k++) {
      const lon = -Math.PI + (k + 0.5) / n * 2 * Math.PI;
      const sp = surf(yt, lon, s);
      const tipP = proj(H, [sp[0] * 0.92, yt + spikeH, sp[2] * 0.92]);
      const mid = proj(H, surf((yb + yt) / 2, lon, s * 1.01));
      if (mid.z <= 0.12) continue;
      const r = H.R * 0.055;
      ctx.beginPath(); ctx.arc(tipP.x, tipP.y - r * 0.5, r, 0, Math.PI * 2);
      ctx.fillStyle = rad(ctx, tipP.x - r * 0.3, tipP.y - r, 0, r * 1.2, [[0, '#FFF6CC'], [1, '#E0A21A']]); ctx.fill();
      const gr = H.R * 0.075;
      ctx.beginPath(); ctx.ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr, 0, 0, Math.PI * 2);
      ctx.fillStyle = gems[k % gems.length]; ctx.fill();
      ctx.beginPath(); ctx.arc(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
    }
  }
}
OUTFIT_DRAWERS.crown = {
  back(ctx, H) { crownPart(ctx, H, -1); },
  front(ctx, H, path) {
    ctx.save(); ctx.clip(path); ctx.clip(capClip(H, crownGeom(H).yb - 0.1, 1)); ctx.clip(invert(capClip(H, crownGeom(H).yb, 1), H));
    ctx.fillStyle = 'rgba(80,50,0,0.12)'; ctx.fill(path); ctx.restore();
    crownPart(ctx, H, 1);
  }
};
function witchBrimPts(H: OutfitHead): ProjectedPoint[] {
  const y = 0.70, rr = 1.42, pts: ProjectedPoint[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = -Math.PI + i / 120 * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.10 * Math.pow(Math.abs(Math.sin(a)), 2); // brim edges droop a little
    pts.push({ a, ...proj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]) });
  }
  return pts;
}
OUTFIT_DRAWERS.witchHat = {
  back(ctx, H) {
    const ell = new Path2D(); witchBrimPts(H).forEach((q, i) => i ? ell.lineTo(q.x, q.y) : ell.moveTo(q.x, q.y)); ell.closePath();
    ctx.fillStyle = lin(ctx, 0, -H.ry * 1.0, 0, -H.ry * 0.4, [[0, '#2A0A4F'], [1, '#3B0F6B']]);
    ctx.fill(ell); // whole brim behind the head; front part is redrawn in front()
  },
  front(ctx, H, path) {
    const all = witchBrimPts(H);
    const brim = new Path2D(); all.forEach((q, i) => i ? brim.lineTo(q.x, q.y) : brim.moveTo(q.x, q.y)); brim.closePath();
    const fr = all.filter(p => p.z >= 0).sort((a, b) => a.x - b.x);
    ctx.save(); ctx.clip(path); ctx.clip(capClip(H, 0.50, 1)); ctx.fillStyle = 'rgba(40,0,70,0.10)'; ctx.fill(path); ctx.restore();
    ctx.fillStyle = lin(ctx, 0, -H.ry * 0.9, 0, -H.ry * 0.3, [[0, '#5B21B6'], [1, '#3B0764']]);
    ctx.fill(brim);
    ctx.beginPath(); fr.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
    ctx.strokeStyle = 'rgba(190,150,255,0.35)'; ctx.lineWidth = H.R * 0.035; ctx.stroke();
    const baseR = 0.62, by = 0.74;
    const bl = proj(H, [-baseR, by, 0]), br = proj(H, [baseR, by, 0]);
    const c = proj(H, [0, by, 0]);
    const lean = 0.10 + H.phys.dx * 0.15;
    const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
    const tip = { x: top.x + H.rx * (0.45 + H.phys.dx * 0.25), y: top.y + H.ry * (0.22 + H.phys.dy * 0.1) };
    const cone = new Path2D();
    cone.moveTo(bl.x, bl.y);
    cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25, top.x - H.rx * 0.02, top.y - H.ry * 0.02);
    cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
    cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
    cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
    const capFront = frontArc(H, by, baseR / ringR(by)).filter(q => q.x >= bl.x - 1 && q.x <= br.x + 1);
    for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y + H.ry * 0.0);
    cone.closePath();
    ctx.fillStyle = lin(ctx, bl.x, top.y, br.x, bl.y, [[0, '#7C3AED'], [0.55, '#4C1D95'], [1, '#2E1065']]);
    ctx.fill(cone);
    ctx.save(); ctx.clip(cone);
    ctx.fillStyle = lin(ctx, bl.x, 0, br.x, 0, [[0, 'rgba(255,255,255,0.22)'], [0.4, 'rgba(255,255,255,0)'], [1, 'rgba(0,0,0,0.15)']]);
    ctx.fill(cone);
    ctx.beginPath(); ctx.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05); ctx.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
    ctx.strokeStyle = 'rgba(20,0,40,0.35)'; ctx.lineWidth = H.R * 0.05; ctx.lineCap = 'round'; ctx.stroke();
    const fc = proj(H, [0, by, baseR]);
    const lift = H.ry * 0.11;
    ctx.beginPath();
    ctx.moveTo(bl.x - 2, bl.y - lift);
    ctx.quadraticCurveTo(fc.x, 2 * (fc.y - lift) - (bl.y + br.y) / 2 + lift * 0.0, br.x + 2, br.y - lift);
    ctx.strokeStyle = '#F97316'; ctx.lineWidth = H.ry * 0.17; ctx.lineCap = 'butt'; ctx.stroke();
    ctx.restore();
    const bk0 = proj(H, [0, by, baseR]); const bk = { x: bk0.x, y: bk0.y - H.ry * 0.11 };
    const bw = H.R * 0.2, bh = H.R * 0.16;
    ctx.save(); ctx.translate(bk.x, bk.y - H.ry * 0.0);
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh * 0.25); ctx.fillStyle = '#FCD34D'; ctx.fill();
    roundRect(ctx, -bw / 2 + bw * 0.24, -bh / 2 + bh * 0.28, bw * 0.52, bh * 0.44, bh * 0.1); ctx.fillStyle = '#C2410C'; ctx.fill();
    ctx.restore();
  }
};
function lens(ctx: CanvasRenderingContext2D, e: OutfitEye, w: number, h: number, r: number): void { ctx.save(); ctx.translate(e.x, e.y); ctx.scale(e.fx, e.fy); roundRect(ctx, -w / 2, -h / 2, w, h, r); ctx.restore(); }
OUTFIT_DRAWERS.sunglasses = {
  frontAfterEyes: true,
  front(ctx, H, path) {
    const eyes = eyeFrames(H);
    const w = H.R * 0.62, h = H.R * 0.46;
    ctx.save(); ctx.clip(path);
    const [l, r] = eyes;
    if (l.visible && r.visible) {
      ctx.beginPath(); ctx.moveTo(l.x + w / 2 * l.fx * 0.9, l.y - h * 0.18); ctx.quadraticCurveTo((l.x + r.x) / 2, (l.y + r.y) / 2 - h * 0.42, r.x - w / 2 * r.fx * 0.9, r.y - h * 0.18);
      ctx.strokeStyle = '#111317'; ctx.lineWidth = H.R * 0.07; ctx.stroke();
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      const ox = e.x + e.sd * w / 2 * e.fx;
      ctx.beginPath(); ctx.moveTo(ox, e.y - h * 0.2); ctx.lineTo(e.sd * H.rx * 1.05, e.y - h * 0.35);
      ctx.strokeStyle = '#111317'; ctx.lineWidth = H.R * 0.06; ctx.stroke();
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      lens(ctx, e, w, h, h * 0.42); ctx.fillStyle = 'rgba(17,19,23,0.82)'; ctx.fill();
      ctx.lineWidth = H.R * 0.05; ctx.strokeStyle = '#0B0C0F'; ctx.stroke();
      ctx.save(); ctx.translate(e.x, e.y); ctx.scale(e.fx, e.fy);
      ctx.beginPath(); ctx.moveTo(-w * 0.28, -h * 0.05); ctx.lineTo(-w * 0.05, -h * 0.3);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = H.R * 0.05; ctx.lineCap = 'round'; ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
};
OUTFIT_DRAWERS.roundGlasses = {
  front(ctx, H, path) {
    const eyes = eyeFrames(H); const d = H.R * 0.56;
    ctx.save(); ctx.clip(path);
    const [l, r] = eyes;
    if (l.visible && r.visible) {
      ctx.beginPath(); ctx.moveTo(l.x + d / 2 * l.fx, l.y - d * 0.08); ctx.quadraticCurveTo((l.x + r.x) / 2, (l.y + r.y) / 2 - d * 0.3, r.x - d / 2 * r.fx, r.y - d * 0.08);
      ctx.strokeStyle = '#8A4B12'; ctx.lineWidth = H.R * 0.055; ctx.stroke();
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      ctx.beginPath(); ctx.moveTo(e.x + e.sd * d / 2 * e.fx, e.y - d * 0.1); ctx.lineTo(e.sd * H.rx * 1.05, e.y - d * 0.25);
      ctx.strokeStyle = '#8A4B12'; ctx.lineWidth = H.R * 0.05; ctx.stroke();
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      ctx.save(); ctx.translate(e.x, e.y); ctx.scale(e.fx, e.fy);
      ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(190,225,255,0.18)'; ctx.fill();
      ctx.lineWidth = H.R * 0.065; ctx.strokeStyle = '#9A5A1A'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = H.R * 0.03; ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
};
OUTFIT_DRAWERS.scarf = {
  front(ctx, H, _path) {
    const s = 1.05, y0 = -0.34, y1 = -0.66;
    const top = frontArc(H, y0, s), bot = frontArc(H, y1, s);
    const band = new Path2D();
    top.forEach((q, i) => i ? band.lineTo(q.x, q.y) : band.moveTo(q.x, q.y));
    for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
    band.closePath();
    ctx.save(); ctx.clip(blobOutfitPath(H.rx * s, H.ry * s));
    ctx.fillStyle = lin(ctx, 0, -H.ry * 0.2, 0, H.ry * 0.7, [[0, '#F87171'], [1, '#B91C1C']]); ctx.fill(band);
    ctx.clip(band);
    for (const lon of [-1.0, -0.45, 0.1, 0.65, 1.2]) {
      const a = proj(H, surf(y0, lon + H.yaw * 0, s)), b = proj(H, surf(y1, lon, s));
      if (a.z < 0) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y - 4); ctx.lineTo(b.x, b.y + 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = H.R * 0.09 * Math.max(0.3, a.z); ctx.stroke();
    }
    ctx.fillStyle = lin(ctx, 0, -H.ry * 0.5, 0, H.ry * 0.3, [[0, 'rgba(255,255,255,0.18)'], [1, 'rgba(0,0,0,0.1)']]); ctx.fill(band);
    ctx.restore();
    const k = proj(H, surf((y0 + y1) / 2, -0.55, s * 1.03));
    if (k.z > 0) {
      const sw = H.phys.dx * H.rx * 0.12;
      const end = new Path2D();
      end.moveTo(k.x - H.R * 0.16, k.y);
      end.quadraticCurveTo(k.x - H.R * 0.24 + sw, k.y + H.ry * 0.35, k.x - H.R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
      end.lineTo(k.x + H.R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
      end.quadraticCurveTo(k.x + H.R * 0.02 + sw, k.y + H.ry * 0.3, k.x + H.R * 0.12, k.y);
      end.closePath();
      ctx.fillStyle = lin(ctx, 0, k.y, 0, k.y + H.ry * 0.6, [[0, '#EF4444'], [1, '#B91C1C']]); ctx.fill(end);
      ctx.save(); ctx.clip(end);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const t of [0.35, 0.7]) ctx.fillRect(k.x - H.R * 0.4 + sw, k.y + H.ry * 0.62 * t, H.R * 0.8, H.R * 0.07);
      ctx.restore();
      for (let i = 0; i < 4; i++) {
        const fx = k.x - H.R * 0.17 + sw * 1.4 + i * H.R * 0.075;
        ctx.beginPath(); ctx.moveTo(fx, k.y + H.ry * 0.6); ctx.lineTo(fx, k.y + H.ry * 0.72);
        ctx.strokeStyle = '#DC2626'; ctx.lineWidth = H.R * 0.035; ctx.lineCap = 'round'; ctx.stroke();
      }
      ctx.beginPath(); ctx.ellipse(k.x, k.y, H.R * 0.17, H.R * 0.14, 0.2, 0, Math.PI * 2);
      ctx.fillStyle = rad(ctx, k.x - H.R * 0.05, k.y - H.R * 0.05, 0, H.R * 0.2, [[0, '#F87171'], [1, '#B91C1C']]); ctx.fill();
    }
  }
};
OUTFIT_DRAWERS.pumpkin = {
  bodyColors: ['#FFA94D', '#E8590C'],
  front(ctx, H, path) {
    ctx.save(); ctx.clip(path);
    for (const lon of [-1.15, -0.55, 0.0, 0.55, 1.15]) {
      const pts = [];
      for (let i = 0; i <= 30; i++) { const y = -0.98 + 1.96 * i / 30; const q = proj(H, surf(y, lon, 1)); if (q.z > 0) pts.push(q); }
      if (pts.length < 2) continue;
      ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
      const zz = pts[Math.floor(pts.length / 2)].z;
      ctx.strokeStyle = `rgba(150,50,0,${0.22 * zz})`; ctx.lineWidth = H.R * 0.12; ctx.lineCap = 'round'; ctx.stroke();
      ctx.strokeStyle = `rgba(255,220,170,${0.18 * zz})`; ctx.lineWidth = H.R * 0.04; ctx.save(); ctx.translate(H.R * 0.07, 0); ctx.stroke(); ctx.restore();
    }
    ctx.restore();
    const t = proj(H, [0.02, 1.0, 0]);
    ctx.beginPath(); ctx.moveTo(t.x - H.R * 0.09, t.y + H.R * 0.04);
    ctx.quadraticCurveTo(t.x - H.R * 0.08, t.y - H.R * 0.22, t.x + H.R * 0.08, t.y - H.R * 0.3);
    ctx.lineTo(t.x + H.R * 0.13, t.y - H.R * 0.22);
    ctx.quadraticCurveTo(t.x + H.R * 0.04, t.y - H.R * 0.15, t.x + H.R * 0.08, t.y + H.R * 0.04); ctx.closePath();
    ctx.fillStyle = lin(ctx, t.x - H.R * 0.1, 0, t.x + H.R * 0.1, 0, [[0, '#65A30D'], [1, '#3F6212']]); ctx.fill();
    ctx.save(); ctx.translate(t.x - H.R * 0.06, t.y - H.R * 0.02); ctx.rotate(-0.5);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-H.R * 0.18, -H.R * 0.2, -H.R * 0.38, -H.R * 0.02); ctx.quadraticCurveTo(-H.R * 0.18, H.R * 0.1, 0, 0);
    ctx.fillStyle = lin(ctx, 0, -H.R * 0.15, -H.R * 0.3, 0, [[0, '#84CC16'], [1, '#4D7C0F']]); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-H.R * 0.02, -H.R * 0.01); ctx.quadraticCurveTo(-H.R * 0.18, -H.R * 0.08, -H.R * 0.32, -H.R * 0.03); ctx.strokeStyle = 'rgba(30,60,0,0.4)'; ctx.lineWidth = H.R * 0.02; ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.moveTo(t.x + H.R * 0.1, t.y - H.R * 0.12);
    ctx.bezierCurveTo(t.x + H.R * 0.3, t.y - H.R * 0.25, t.x + H.R * 0.35, t.y - H.R * 0.02, t.x + H.R * 0.22, t.y - H.R * 0.06);
    ctx.strokeStyle = '#4D7C0F'; ctx.lineWidth = H.R * 0.03; ctx.lineCap = 'round'; ctx.stroke();
  }
};
OUTFIT_DRAWERS.bow = {
  front(ctx, H, _path) {
    const a = proj(H, surf(0.86, 0.55, 1.02));
    if (a.z < -0.2) return;
    const s = H.R * 0.26, sq = Math.max(0.45, Math.cos(0.55 + H.yaw));
    ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(0.35 + H.yaw * 0.3); ctx.scale(sq, 1);
    for (const sd of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
      ctx.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
      ctx.fillStyle = lin(ctx, 0, -s, 0, s, [[0, '#FF8CC6'], [1, '#DB2777']]); ctx.fill();
      ctx.beginPath(); ctx.moveTo(sd * s * 0.25, -s * 0.05); ctx.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
      ctx.strokeStyle = 'rgba(140,10,70,0.35)'; ctx.lineWidth = s * 0.08; ctx.lineCap = 'round'; ctx.stroke();
    }
    ctx.beginPath(); ctx.ellipse(0, 0, s * 0.24, s * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = rad(ctx, -s * 0.06, -s * 0.1, 0, s * 0.35, [[0, '#FFB3D9'], [1, '#C2185B']]); ctx.fill();
    ctx.restore();
  }
};


function eyeFrames(H: OutfitHead): OutfitEye[] {
  return H.eyes.map((eye, index) => ({
    sd: index === 0 ? -1 : 1,
    visible: eye.visible,
    x: eye.x * 1.14,
    y: eye.y * 0.88,
    fx: eye.width / (H.R * 0.25),
    fy: eye.height / (H.R * 0.27),
    w: H.R * 0.25,
    h: H.R * 0.27,
  }))
}

function circleBodyPath(H: OutfitHead): Path2D {
  const path = new Path2D()
  path.ellipse(0, 0, H.rx, H.ry, 0, 0, Math.PI * 2)
  return path
}


/** Maps the reference 1.14R x 0.88R body box onto Bloblex's radius-R circle. */
export function mapBodyBoxToCircle(ctx: CanvasRenderingContext2D, H: OutfitHead, draw: () => void): void {
  ctx.save()
  ctx.scale(H.R / H.rx, H.R / H.ry)
  try { draw() } finally { ctx.restore() }
}

function makeHead(R: number, eyes: WardrobeEyeFrame[], lagX: number, lagY: number, yaw: number, pitch: number): OutfitHead {
  return { R, rx: R * 1.14, ry: R * 0.88, view: VIEW_TILT, yaw, pitch, phys: { dx: lagX, dy: lagY }, eyes, presence: 1, roll: 0 }
}

function easeBack(t: number): number {
  const c1 = 1.7, c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function withPresencePose(ctx: CanvasRenderingContext2D, H: OutfitHead, outfit: Outfit, behind: boolean, draw: () => void): void {
  const p = H.presence
  const posP = easeBack(p)
  const hatScale = 0.85 + 0.15 * posP
  const hat = ['beanie', 'santa-hat', 'party-hat', 'crown', 'witch-hat'].includes(outfit)
  ctx.save()
  if (hat && Math.abs(H.roll) > 0.01) {
    const u = Math.min(1, Math.abs(H.roll) / (2 * Math.PI))
    ctx.translate(H.phys.dx * H.rx * 0.2 * Math.sin(u * Math.PI), -H.ry * 0.45 * Math.sin(u * Math.PI))
    ctx.rotate(Math.sin(2 * Math.PI * u) * 0.35)
  } else if (hat || (behind && outfit === 'bunny-ears')) {
    ctx.translate(0, -(1 - posP) * H.ry)
    ctx.scale(hatScale, hatScale)
  } else if (outfit === 'sunglasses' || outfit === 'round-glasses') {
    ctx.translate(0, (1 - p) * 0.25 * H.ry)
  } else if (outfit === 'scarf') {
    ctx.translate(0, (1 - p) * 0.3 * H.ry)
  } else if (outfit === 'bow') {
    ctx.scale(Math.max(0.001, posP), Math.max(0.001, posP))
  }
  try { draw() } finally { ctx.restore() }
}

function withEvenOddClips(ctx: CanvasRenderingContext2D, draw: () => void): void {
  const nativeClip = ctx.clip.bind(ctx) as ((path: Path2D, rule?: CanvasFillRule) => void) & ((rule?: CanvasFillRule) => void)
  ctx.clip = ((path?: Path2D | CanvasFillRule, rule?: CanvasFillRule) => {
    if (path instanceof Path2D) {
      return (path as EvenOddPath).__evenodd ? nativeClip(path, 'evenodd') : nativeClip(path, rule)
    }
    return nativeClip(typeof path === 'string' ? path : rule)
  }) as CanvasRenderingContext2D['clip']
  try { draw() } finally { ctx.clip = nativeClip }
}

function withBadgeClearance(ctx: CanvasRenderingContext2D, H: OutfitHead, draw: () => void): void {
  const clip = new Path2D() as EvenOddPath
  clip.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8)
  const x = BADGE_OFFSET.x * H.R * 1.14
  const y = BADGE_OFFSET.y * H.R * 0.88
  const radius = (BADGE_RADIUS + BADGE_CLEARANCE) * H.R
  clip.ellipse(x, y, radius * 1.14, radius * 0.88, 0, 0, Math.PI * 2)
  clip.__evenodd = true
  withEvenOddClips(ctx, () => { ctx.clip(clip); draw() })
}

function drawBunnyEarsBack(ctx: CanvasRenderingContext2D, H: OutfitHead, rollProgress = 0): void {
  const R = H.R
  const roots = [-1, 1].map((sd) => proj(H, [sd * 0.45, 0.92, 0]))
  const bounds = clearAccessoryOfBadge({ x: (roots[0].x + roots[1].x) / 2, y: Math.min(...roots.map((p) => p.y)) - R * 0.22, halfWidth: R * 0.55, halfHeight: R * 0.48 }, R)
  const shift = bounds.x - (roots[0].x + roots[1].x) / 2
  for (const sd of [-1, 1]) {
    const root = proj(H, [sd * 0.45, 0.92, 0])
    const rootL = proj(H, [sd * 0.23, 0.92, 0])
    const rootR = proj(H, [sd * 0.67, 0.92, 0])
    const halfWidth = Math.max(R * 0.04, Math.abs(rootR.x - rootL.x) / 2)
    const flatten = Math.sin(rollProgress * Math.PI)
    const earHeight = R * 0.85 * (1 - 0.8 * flatten)
    const centerX = root.x + shift
    const centerY = root.y - earHeight * 0.15
    ctx.save(); ctx.translate(centerX, centerY); ctx.rotate(sd * 0.6 * flatten)
    ctx.fillStyle = '#F9F0F0'; ctx.strokeStyle = 'rgba(0,0,0,0.06)'; ctx.lineWidth = Math.max(0.8, R * 0.012)
    ctx.beginPath(); ctx.ellipse(0, -earHeight * 0.35, halfWidth, earHeight / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(252,165,165,0.70)'
    ctx.beginPath(); ctx.ellipse(0, -earHeight * 0.35, halfWidth * 0.5, earHeight * 0.325, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}

function drawOutfitBehind(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, eyes: WardrobeEyeFrame[], lagX: number, lagY: number, yaw: number, pitch: number, roll = 0, presence = 1): void {
  if (outfit === 'auto' || outfit === 'none' || R < 2) return
  const H = makeHead(R, eyes, lagX, lagY, yaw, pitch)
  H.presence = presence; H.roll = roll
  mapBodyBoxToCircle(ctx, H, () => withBadgeClearance(ctx, H, () => {
    withPresencePose(ctx, H, outfit, true, () => {
      if (outfit === 'bunny-ears') {
        const rollProgress = Math.min(1, Math.abs(roll) / (2 * Math.PI))
        drawBunnyEarsBack(ctx, H, rollProgress)
      } else OUTFIT_DRAWERS[toReferenceId(outfit)]?.back?.(ctx, H)
    })
  }))
}

function drawOutfitFront(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, eyes: WardrobeEyeFrame[], lagX: number, lagY: number, yaw: number, pitch: number, presence = 1, roll = 0): void {
  if (outfit === 'auto' || outfit === 'none' || R < 2) return
  const H = makeHead(R, eyes, lagX, lagY, yaw, pitch)
  H.presence = presence; H.roll = roll
  const path = circleBodyPath(H)
  mapBodyBoxToCircle(ctx, H, () => withBadgeClearance(ctx, H, () => {
    const front = OUTFIT_DRAWERS[toReferenceId(outfit)]?.front
    if (front) withPresencePose(ctx, H, outfit, false, () => front(ctx, H, path))
  }))
}

function toReferenceId(outfit: Outfit): string {
  return outfit.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

export function drawWardrobeBehind(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, eyes: WardrobeEyeFrame[], lagX = 0, lagY = 0, yaw = 0, pitch = 0, roll = 0, presence = 1) {
  drawOutfitBehind(ctx, outfit, R, eyes, lagX, lagY, yaw, pitch, roll, presence)
}

export function drawWardrobe(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, eyes: WardrobeEyeFrame[], blink: number, lagX = 0, lagY = 0, yaw = 0, pitch = 0, presence = 1, roll = 0) {
  void blink
  drawOutfitFront(ctx, outfit, R, eyes, lagX, lagY, yaw, pitch, presence, roll)
}

export function bodyColorsForOutfit(outfit: Outfit): [string, string] | null {
  return OUTFIT_DRAWERS[toReferenceId(outfit)]?.bodyColors ?? null
}
