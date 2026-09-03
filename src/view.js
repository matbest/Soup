import { hashMd, coords } from './soup.js';

// Canvas grid. Colour is a function of the genome hash, so identical genomes share a
// colour and any mutation shows up as a new one. Empty cells are near-black.
export function createView(canvas, getSoup, { onSelect, onHover = () => {}, getActive = () => null, getOverlay = () => null, showText = () => true }) {
  let selected = null;
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function colour(md) {
    if (md === null) return '#101214';
    const h = hashMd(md);
    return `hsl(${h % 360} ${35 + ((h >>> 9) % 20)}% ${70 + ((h >>> 14) % 12)}%)`;
  }

  // Where the cells fall. Pure: hit-testing a pointer must never touch the canvas, because
  // assigning canvas.width clears it and only draw() puts anything back.
  function layout() {
    const soup = getSoup();
    const side = Math.max(1, Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight)));
    const cell = Math.floor(side / Math.max(soup.w, soup.h));
    return { side, cell, ox: Math.floor((side - cell * soup.w) / 2), oy: Math.floor((side - cell * soup.h) / 2) };
  }

  // Rounded to whole device pixels, or a fractional display scale leaves the comparison
  // permanently unequal and the canvas is cleared on every call.
  function resize(side) {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(side * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    return dpr;
  }

  function draw() {
    const soup = getSoup();
    const { side, cell, ox, oy } = layout();
    const dpr = resize(side);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0b0c';
    ctx.fillRect(0, 0, side, side);
    const gap = cell > 6 ? 1 : 0;
    // While a turn plays out the overlay holds the part-finished state, so what is on
    // screen is the edit in progress rather than the soup as it stands.
    const overlay = getOverlay();
    const fontPx = Math.max(3, Math.min(7, Math.floor(cell / 11)));
    const withText = showText() && cell >= 22;
    for (let i = 0; i < soup.cells.length; i++) {
      const [x, y] = coords(soup, i);
      const key = `${x},${y}`;
      const md = overlay?.cells.has(key) ? overlay.cells.get(key) : soup.cells[i].md;
      const px = ox + x * cell, py = oy + y * cell;
      ctx.fillStyle = colour(md);
      ctx.fillRect(px, py, cell - gap, cell - gap);
      if (withText && md !== null) drawText(md, px, py, cell - gap, fontPx);
    }
    if (overlay) {
      // The cell the cursor is in, so the eye can follow it from one to the next.
      ctx.strokeStyle = '#fff6d8';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + overlay.at.x * cell + 1, oy + overlay.at.y * cell + 1, cell - gap - 2, cell - gap - 2);
    }
    if (selected !== null && selected < soup.cells.length) {
      const [x, y] = coords(soup, selected);
      ctx.strokeStyle = '#f2ede4';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + x * cell + 1, oy + y * cell + 1, cell - gap - 2, cell - gap - 2);
    }
    const active = getActive();
    if (active !== null && active < soup.cells.length) {
      const [x, y] = coords(soup, active);
      drawWorking(ox + x * cell + (cell - gap) / 2, oy + y * cell + (cell - gap) / 2, (cell - gap) * 0.28);
    }
  }

  // The cell whose turn is at the model: a turning arc, or a still ring under
  // prefers-reduced-motion.
  function drawWorking(cx, cy, r) {
    ctx.save();
    ctx.strokeStyle = '#f2ede4';
    ctx.lineWidth = Math.max(2, r / 3.5);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (reducedMotion) {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else {
      const t = (performance.now() / 700) * Math.PI * 2;
      ctx.arc(cx, cy, r, t, t + Math.PI * 1.4);
    }
    ctx.stroke();
    ctx.restore();
  }

  // The cell's text, small enough to be texture rather than reading matter: what a lineage
  // looks like, and whether it is growing or being eaten away.
  function drawText(md, px, py, size, fontPx) {
    const pad = 2;
    const lines = md.split('\n');
    const room = Math.floor((size - pad) / (fontPx + 1));
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, size, size);
    ctx.clip();
    ctx.font = `${fontPx}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(10, 11, 12, 0.72)';
    ctx.textBaseline = 'top';
    for (let i = 0; i < Math.min(lines.length, room); i++) {
      ctx.fillText(lines[i], px + pad, py + pad + i * (fontPx + 1));
    }
    ctx.restore();
  }

  // Which cell is under the pointer, or null if the pointer is off the grid.
  function cellAt(e) {
    const soup = getSoup();
    const { cell, ox, oy } = layout();
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - ox) / cell);
    const y = Math.floor((e.clientY - r.top - oy) / cell);
    if (x < 0 || y < 0 || x >= soup.w || y >= soup.h) return null;
    return y * soup.w + x;
  }

  canvas.addEventListener('mousemove', e => onHover(cellAt(e), e.clientX, e.clientY));
  canvas.addEventListener('mouseleave', () => onHover(null));

  canvas.addEventListener('click', e => {
    const i = cellAt(e);
    if (i === null) return;
    selected = i;
    onSelect(selected);
    draw();
  });

  return {
    draw,
    get selected() { return selected; },
    select(i) { selected = i; onSelect(i); draw(); },
    clear() { selected = null; },
  };
}
