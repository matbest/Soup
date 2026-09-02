import { hashMd, coords } from './soup.js';

// Canvas grid. Colour is a function of the genome hash, so identical genomes share a
// colour and any mutation shows up as a new one. Empty cells are near-black.
export function createView(canvas, getSoup, { onSelect, getActive = () => null }) {
  let selected = null;
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function colour(md) {
    if (md === null) return '#101214';
    const h = hashMd(md);
    return `hsl(${h % 360} ${35 + ((h >>> 9) % 20)}% ${70 + ((h >>> 14) % 12)}%)`;
  }

  function layout() {
    const soup = getSoup();
    const dpr = window.devicePixelRatio || 1;
    const side = Math.max(1, Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight)));
    if (canvas.width !== side * dpr || canvas.height !== side * dpr) {
      canvas.width = side * dpr;
      canvas.height = side * dpr;
    }
    const cell = Math.floor(side / Math.max(soup.w, soup.h));
    return { dpr, side, cell, ox: Math.floor((side - cell * soup.w) / 2), oy: Math.floor((side - cell * soup.h) / 2) };
  }

  function draw() {
    const soup = getSoup();
    const { dpr, side, cell, ox, oy } = layout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0b0c';
    ctx.fillRect(0, 0, side, side);
    const gap = cell > 6 ? 1 : 0;
    for (let i = 0; i < soup.cells.length; i++) {
      const [x, y] = coords(soup, i);
      ctx.fillStyle = colour(soup.cells[i].md);
      ctx.fillRect(ox + x * cell, oy + y * cell, cell - gap, cell - gap);
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

  canvas.addEventListener('click', e => {
    const soup = getSoup();
    const { cell, ox, oy } = layout();
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - ox) / cell);
    const y = Math.floor((e.clientY - r.top - oy) / cell);
    if (x < 0 || y < 0 || x >= soup.w || y >= soup.h) return;
    selected = y * soup.w + x;
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
