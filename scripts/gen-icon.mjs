// 生成 TomatoSQL 应用图标：1024x1024 PNG（纯 Node 实现，无第三方依赖）
// 用法: node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const S = 1024;      // 输出尺寸
const SS = 3;        // 超采样倍数
const W = S * SS;

const buf = new Float32Array(W * W * 4); // 线性 RGBA 0..1（预乘前）

function idx(x, y) { return (y * W + x) * 4; }

function blend(x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= W) return;
  const i = idx(x, y);
  const da = buf[i + 3];
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  buf[i] = (r * a + buf[i] * da * (1 - a)) / oa;
  buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / oa;
  buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / oa;
  buf[i + 3] = oa;
}

// 用 4x4 子采样做抗锯齿
function fillShape(sdf, colorFn) {
  const SUB = 4;
  const x0 = Math.max(0, Math.floor(sdf.minX)), x1 = Math.min(W - 1, Math.ceil(sdf.maxX));
  const y0 = Math.max(0, Math.floor(sdf.minY)), y1 = Math.min(W - 1, Math.ceil(sdf.maxY));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let cov = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB, py = y + (sy + 0.5) / SUB;
          if (sdf.inside(px, py)) cov++;
        }
      }
      if (!cov) continue;
      const c = colorFn(x + 0.5, y + 0.5);
      blend(x, y, c[0], c[1], c[2], (cov / (SUB * SUB)) * (c[3] ?? 1));
    }
  }
}

function roundedRect(x, y, w, h, r) {
  return {
    minX: x, minY: y, maxX: x + w, maxY: y + h,
    inside(px, py) {
      const cx = Math.max(x + r, Math.min(px, x + w - r));
      const cy = Math.max(y + r, Math.min(py, y + h - r));
      const dx = px - cx, dy = py - cy;
      return dx * dx + dy * dy <= r * r;
    },
  };
}

function ellipse(cx, cy, rx, ry) {
  return {
    minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry,
    inside(px, py) {
      const dx = (px - cx) / rx, dy = (py - cy) / ry;
      return dx * dx + dy * dy <= 1;
    },
  };
}

function poly(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
    inside(px, py) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
  };
}

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

// ---------- 底板 ----------
const R = W * 0.225;
fillShape(roundedRect(0, 0, W, W, R), (px, py) => {
  const t = py / W;
  const top = hex("#232a36"), bot = hex("#0f1319");
  const mix = (a, b) => a + (b - a) * t;
  return [mix(top[0], bot[0]), mix(top[1], bot[1]), mix(top[2], bot[2]), 1];
});

// 柔和红光
const glow = ellipse(W * 0.5, W * 0.60, W * 0.40, W * 0.36);
for (let ring = 0; ring < 26; ring++) {
  const k = 1 + (ring / 26) * 0.55;
  const a = 0.030 * (1 - ring / 26);
  fillShape(ellipse(W * 0.5, W * 0.60, W * 0.40 * k, W * 0.36 * k), () => [1, 0.35, 0.28, a]);
}

// ---------- 番茄 ----------
const cx = W * 0.5, cy = W * 0.588, RX = W * 0.288, RY = W * 0.258;
fillShape(ellipse(cx, cy, RX, RY), () => [...hex("#a82a22"), 1]);
fillShape(ellipse(cx, cy - RY * 0.05, RX * 0.965, RY * 0.955), () => [...hex("#c9382b"), 1]);
fillShape(ellipse(cx, cy - RY * 0.12, RX * 0.905, RY * 0.885), () => [...hex("#de3f2e"), 1]);
fillShape(ellipse(cx - RX * 0.26, cy - RY * 0.34, RX * 0.44, RY * 0.34), () => [1, 0.72, 0.66, 0.16]);
fillShape(ellipse(cx - RX * 0.30, cy - RY * 0.40, RX * 0.26, RY * 0.18), () => [1, 0.85, 0.80, 0.18]);
fillShape(ellipse(cx + RX * 0.42, cy + RY * 0.36, RX * 0.38, RY * 0.22), () => [0.45, 0.05, 0.03, 0.30]);

// ---------- 数据库圆柱 ----------
const cylW = RX * 1.02, cylH = RY * 0.30, capR = cylW * 0.5;
const cylCY = cy - RY * 0.02;
function cylinder(offsetY, capColor, bodyColor) {
  const x = cx - cylW / 2;
  const yTop = cylCY + offsetY - cylH * 0.5;
  fillShape(ellipse(cx, yTop, cylW / 2, cylH * 0.30), () => bodyColor);
  // 主体（矩形部分用椭圆裁剪模拟，简化为圆角矩形 + 椭圆）
  fillShape(roundedRect(x, yTop, cylW, cylH * 2.1, cylH * 0.28), () => bodyColor);
  fillShape(ellipse(cx, yTop + cylH * 2.1, cylW / 2, cylH * 0.30), () => bodyColor);
  fillShape(ellipse(cx, yTop, cylW / 2, cylH * 0.30), () => capColor);
}
const white = [1, 1, 1, 0.95];
const white2 = [1, 1, 1, 0.78];
const shadow = [0.62, 0.13, 0.10, 0.35];
cylinder(RY * 0.10, white, white2);
// 上方一条更亮的环带，制造层次
fillShape(ellipse(cx, cylCY + RY * 0.10 - cylH * 0.5, cylW * 0.5, cylH * 0.30), () => white);

// ---------- 茎叶 ----------
const baseY = cy - RY * 0.80;
fillShape(roundedRect(cx - W * 0.016, baseY - W * 0.19, W * 0.032, W * 0.20, W * 0.016), () => [...hex("#4c9a4e"), 1]);
const leafSets = [
  [-170, 0.245, "#57b45c"], [-10, 0.245, "#57b45c"],
  [-120, 0.190, "#3f8b46"], [-60, 0.190, "#3f8b46"],
  [150, 0.165, "#3f8b46"], [30, 0.165, "#3f8b46"],
];
for (const [deg, sz, col] of leafSets) {
  const a = (deg * Math.PI) / 180;
  const ex = cx + Math.cos(a) * W * sz;
  const ey = baseY + Math.sin(a) * W * sz * 0.52;
  const w = W * sz * 0.52;
  fillShape(poly([
    [cx, baseY],
    [cx + Math.cos(a - 0.5) * w, baseY + Math.sin(a - 0.5) * w * 0.6],
    [ex, ey],
    [cx + Math.cos(a + 0.5) * w, baseY + Math.sin(a + 0.5) * w * 0.6],
  ]), () => [...hex(col), 1]);
}

// ---------- 降采样 ----------
const out = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = idx(x * SS + sx, y * SS + sy);
        const pa = buf[i + 3];
        r += buf[i] * pa; g += buf[i + 1] * pa; b += buf[i + 2] * pa; a += pa;
      }
    }
    const n = SS * SS;
    const o = (y * S + x) * 4;
    if (a > 0) {
      out[o] = Math.round(Math.min(1, r / a) * 255);
      out[o + 1] = Math.round(Math.min(1, g / a) * 255);
      out[o + 2] = Math.round(Math.min(1, b / a) * 255);
    }
    out[o + 3] = Math.round(Math.min(1, a / n) * 255);
  }
}

// ---------- PNG 编码 ----------
function crc32(t) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < t.length; n++) {
    c = (crc ^ t[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("scripts", { recursive: true });
writeFileSync("app-icon.png", png);
console.log("app-icon.png written:", png.length, "bytes");
