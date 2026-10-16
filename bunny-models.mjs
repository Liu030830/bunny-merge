import { getRabbitShape } from './rabbit-shapes.mjs';

// Used by particles and by the load-error fallback, never to recolor photographs.
export const BUNNY_PALETTE = Object.freeze([
  ['#F6E4CD', '#CFAD86'], ['#EBD0AB', '#BA956D'], ['#E1D8F0', '#A398BD'],
  ['#F5D4DC', '#CF9FAA'], ['#FFF5E5', '#DBBEA6'], ['#DADFEA', '#9FAAC0'],
  ['#E6D9C8', '#B19C83'], ['#F5E6C5', '#CDB079'], ['#E5DCF0', '#B19BC9'],
  ['#DCE6D7', '#9EAF91'], ['#F4E4EB', '#D0AABB'], ['#F7E5D6', '#CCA98C'],
].map(([color, accent]) => Object.freeze({ color, accent, shade: accent, highlight: '#FFFDF8', inner: '#E9B5C3', cheek: '#E6A6B8' })));

const SHEETS = ['./assets/rabbits-01.png', './assets/rabbits-02.png', './assets/rabbits-03.png'];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;

function loadSheet(path) {
  const url = new URL(path, import.meta.url).href;
  if (typeof Image === 'undefined') return Promise.resolve([url, null]);
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      resolve([url, value]);
    };
    const timeout = setTimeout(() => finish(null), 30_000);
    image.onload = async () => {
      try {
        if (typeof image.decode === 'function') await image.decode();
        finish(image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null);
      } catch { finish(null); }
    };
    image.onerror = () => finish(null);
    image.decoding = 'async';
    image.src = url;
  });
}

// Initial sprite caches are built only after all three sheets finish decoding.
const sheets = new Map(await Promise.all(SHEETS.map(loadSheet)));
export const assetLoaded = [...sheets.values()].every(Boolean);

function traceCompound(ctx, shape) {
  ctx.beginPath();
  for (const part of shape.parts) {
    const vertices = part.vertices;
    if (!vertices || vertices.length < 3) continue;
    // Consistent winding makes overlapping convex parts a solid union.
    let area = 0;
    for (let i = 0; i < vertices.length; i++) {
      const next = vertices[(i + 1) % vertices.length];
      area += vertices[i].x * next.y - next.x * vertices[i].y;
    }
    for (let i = 0; i < vertices.length; i++) {
      const point = vertices[area < 0 ? vertices.length - 1 - i : i];
      if (i) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
    }
    ctx.closePath();
  }
}

function drawFallback(ctx, shape, palette) {
  traceCompound(ctx, shape);
  ctx.fillStyle = palette.color;
  ctx.fill();
  ctx.clip();
  const b = shape.bounds, width = b.maxX - b.minX, height = b.maxY - b.minY;
  const x = (b.minX + b.maxX) / 2, y = b.minY + height * .53;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * width * .13, y, width * .025, height * .035, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#624B46'; ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + side * width * .13 - width * .006, y - height * .012, width * .008, height * .011, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(x, y + height * .08, width * .023, height * .016, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#CC929F'; ctx.fill();
}

/** Draw the selected user's photograph at its physics body's centre of mass. */
export function drawBunny(ctx, x, y, radius, level, angle = 0, { alpha = 1 } = {}) {
  if (!ctx || !Number.isFinite(radius) || radius <= 0) return;
  const tier = clamp(Math.floor(finite(level)), 0, BUNNY_PALETTE.length - 1);
  const shape = getRabbitShape(tier), source = shape.source;
  const image = source ? sheets.get(new URL(source.sheetURL, import.meta.url).href) : null;
  ctx.save();
  ctx.translate(finite(x), finite(y)); ctx.rotate(finite(angle)); ctx.scale(radius, radius);
  ctx.globalAlpha *= clamp(finite(alpha, 1), 0, 1);
  if (source && image) {
    traceCompound(ctx, shape);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, source.cellX, source.cellY, source.width, source.height,
      -source.centerX * source.scale, -source.centerY * source.scale,
      source.width * source.scale, source.height * source.scale);
  } else {
    drawFallback(ctx, shape, BUNNY_PALETTE[tier]);
  }
  ctx.restore();
}

/** Fit actual bounds, including long ears and props, without changing proportions. */
export function drawTinyBunny(canvas, level) {
  if (!canvas) return;
  const width = clamp(canvas.clientWidth || finite(canvas.width, 48) || 48, 16, 512);
  const height = clamp(canvas.clientHeight || finite(canvas.height, width) || width, 16, 512);
  const dpr = clamp(finite(globalThis.devicePixelRatio, 1), 1, 2);
  const targetWidth = Math.round(width * dpr), targetHeight = Math.round(height * dpr);
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const bounds = getRabbitShape(level).bounds;
  const padding = Math.min(width, height) * .06;
  const radius = Math.min((width - padding * 2) / Math.max(.01, bounds.maxX - bounds.minX),
    (height - padding * 2) / Math.max(.01, bounds.maxY - bounds.minY));
  const x = width / 2 - (bounds.minX + bounds.maxX) / 2 * radius;
  const y = height / 2 - (bounds.minY + bounds.maxY) / 2 * radius;
  drawBunny(ctx, x, y, radius, level);
}
