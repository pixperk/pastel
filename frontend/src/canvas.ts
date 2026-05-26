import type { ClientMsg, Point, ServerMsg } from "./proto";

// Pastel palette, one per player slot. Deterministic from player id.
const PALETTE = ["#e88b9c", "#f1ac81", "#e8d272", "#86c8a3", "#8aa4e0"];

const BASE_WIDTH = 4.5;
const MIN_WIDTH = 1.5;
const MAX_WIDTH = 7.5;
const VELOCITY_DAMPING = 0.035;
const JITTER_BUFFER_MS = 50;
const BATCH_INTERVAL_MS = 16;
const MAX_DELTA = 127; // i8

interface StrokeRender {
  color: string;
  prevX: number; // last raw input point (control point for next curve)
  prevY: number;
  drawnX: number; // last midpoint actually rendered
  drawnY: number;
  prevT: number;
  width: number;
}

interface LocalStroke {
  strokeId: number;
  originX: number;
  originY: number;
  lastX: number; // last point sent (delta base)
  lastY: number;
  lastT: number;
  pending: Point[]; // unsent points
  render: StrokeRender;
  pointerId: number;
}

interface RemotePointBuffered {
  absX: number;
  absY: number;
  dt: number;
  pressure: number;
  arrivedAt: number;
  finished: boolean;
}

interface RemoteStroke {
  player: number;
  strokeId: number;
  buffered: RemotePointBuffered[];
  render: StrokeRender | null; // null until first point is drained
  finished: boolean;
  origin: [number, number];
  lastAbsX: number;
  lastAbsY: number;
}

export class DrawingSurface {
  private ctx: CanvasRenderingContext2D;
  private nextStrokeId = 1;
  private localStrokes = new Map<number, LocalStroke>(); // by pointerId
  private remoteStrokes = new Map<string, RemoteStroke>(); // key: `${player}/${stroke_id}`
  private youId: number | null = null;
  private sendBatched: ((msg: ClientMsg) => void) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.imageSmoothingEnabled = true;

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerEnd);
    canvas.addEventListener("pointercancel", this.onPointerEnd);
    canvas.addEventListener("pointerleave", this.onPointerEnd);
    canvas.style.touchAction = "none";

    requestAnimationFrame(this.drainJitterBuffer);
  }

  attachSender(send: (msg: ClientMsg) => void): void {
    this.sendBatched = send;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(this.flushPending, BATCH_INTERVAL_MS);
  }

  setYouId(id: number): void {
    this.youId = id;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.remoteStrokes.clear();
  }

  // Apply a remote ServerMsg::Stroke or replay completed strokes from snapshot.
  handleStrokeMessage(player: number, strokeId: number, origin: [number, number], points: Point[], finished: boolean): void {
    // Skip our own echoes; we rendered them locally already.
    if (this.youId !== null && player === this.youId) return;

    const key = `${player}/${strokeId}`;
    let stroke = this.remoteStrokes.get(key);
    if (!stroke) {
      stroke = {
        player,
        strokeId,
        buffered: [],
        render: null,
        finished: false,
        origin,
        lastAbsX: origin[0],
        lastAbsY: origin[1],
      };
      this.remoteStrokes.set(key, stroke);
    }

    const now = performance.now();
    for (const p of points) {
      stroke.lastAbsX += p.dx;
      stroke.lastAbsY += p.dy;
      stroke.buffered.push({
        absX: stroke.lastAbsX,
        absY: stroke.lastAbsY,
        dt: p.dt,
        pressure: p.pressure,
        arrivedAt: now,
        finished: false,
      });
    }
    if (finished) {
      const last = stroke.buffered[stroke.buffered.length - 1];
      if (last) last.finished = true;
      else stroke.finished = true; // empty batch with finished=true (rare)
    }
  }

  // Replay all strokes from a snapshot, instantly (no jitter buffer).
  applySnapshot(msg: ServerMsg & { kind: "Welcome" }): void {
    this.clear();
    for (const s of msg.snapshot.completed) {
      this.drawSnapshotStroke(s.player, s.origin, s.points);
    }
  }

  private drawSnapshotStroke(player: number, origin: [number, number], points: Point[]): void {
    if (points.length === 0) return;
    const render = newRender(colorFor(player), origin[0], origin[1], origin[0], origin[1]);
    let curX = origin[0];
    let curY = origin[1];
    let curT = 0;
    for (const p of points) {
      curX += p.dx;
      curY += p.dy;
      curT += p.dt;
      drawSegment(this.ctx, render, curX, curY, curT);
    }
    // close out the last segment to the actual final point
    lineToFinal(this.ctx, render, curX, curY);
  }

  private drainJitterBuffer = (): void => {
    const now = performance.now();
    for (const [key, stroke] of this.remoteStrokes) {
      while (stroke.buffered.length > 0) {
        const head = stroke.buffered[0];
        if (now - head.arrivedAt < JITTER_BUFFER_MS) break;
        stroke.buffered.shift();
        this.applyRemotePoint(stroke, head);
      }
      if (stroke.finished && stroke.buffered.length === 0) {
        if (stroke.render) lineToFinal(this.ctx, stroke.render, stroke.lastAbsX, stroke.lastAbsY);
        this.remoteStrokes.delete(key);
      }
    }
    requestAnimationFrame(this.drainJitterBuffer);
  };

  private applyRemotePoint(stroke: RemoteStroke, p: RemotePointBuffered): void {
    if (!stroke.render) {
      stroke.render = newRender(colorFor(stroke.player), stroke.origin[0], stroke.origin[1], p.absX, p.absY);
    }
    drawSegment(this.ctx, stroke.render, p.absX, p.absY, stroke.render.prevT + p.dt);
    if (p.finished) {
      stroke.finished = true;
      lineToFinal(this.ctx, stroke.render, p.absX, p.absY);
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!ev.isPrimary) return;
    if (this.localStrokes.has(ev.pointerId)) return;
    this.canvas.setPointerCapture(ev.pointerId);
    const x = ev.offsetX;
    const y = ev.offsetY;
    const t = performance.now();
    const strokeId = this.nextStrokeId++;
    const color = this.youId !== null ? colorFor(this.youId) : PALETTE[0];
    const stroke: LocalStroke = {
      strokeId,
      originX: x,
      originY: y,
      lastX: x,
      lastY: y,
      lastT: t,
      pending: [],
      render: newRender(color, x, y, x, y),
      pointerId: ev.pointerId,
    };
    this.localStrokes.set(ev.pointerId, stroke);
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const stroke = this.localStrokes.get(ev.pointerId);
    if (!stroke) return;

    const events = typeof ev.getCoalescedEvents === "function"
      ? ev.getCoalescedEvents()
      : [ev];
    for (const e of events.length > 0 ? events : [ev]) {
      this.consumeLocalPoint(stroke, e.offsetX, e.offsetY);
    }
  };

  private onPointerEnd = (ev: PointerEvent): void => {
    const stroke = this.localStrokes.get(ev.pointerId);
    if (!stroke) return;
    this.localStrokes.delete(ev.pointerId);

    // Force-flush remaining points with finished=true.
    if (this.sendBatched) {
      this.sendBatched({
        kind: "Stroke",
        stroke_id: stroke.strokeId,
        origin: [stroke.originX, stroke.originY],
        points: stroke.pending,
        finished: true,
      });
      stroke.pending = [];
    }

    lineToFinal(this.ctx, stroke.render, stroke.lastX, stroke.lastY);
  };

  private consumeLocalPoint(stroke: LocalStroke, x: number, y: number): void {
    const t = performance.now();
    let dx = Math.round(x - stroke.lastX);
    let dy = Math.round(y - stroke.lastY);
    let dt = Math.min(255, Math.max(0, Math.round(t - stroke.lastT)));

    // Skip duplicate sub-pixel events.
    if (dx === 0 && dy === 0 && stroke.pending.length > 0) return;

    // Clamp to i8 range, dropping excess delta (rare).
    if (dx > MAX_DELTA) dx = MAX_DELTA;
    else if (dx < -MAX_DELTA - 1) dx = -MAX_DELTA - 1;
    if (dy > MAX_DELTA) dy = MAX_DELTA;
    else if (dy < -MAX_DELTA - 1) dy = -MAX_DELTA - 1;

    const absX = stroke.lastX + dx;
    const absY = stroke.lastY + dy;

    stroke.pending.push({ dx, dy, dt, pressure: 0 });
    drawSegment(this.ctx, stroke.render, absX, absY, stroke.render.prevT + dt);

    stroke.lastX = absX;
    stroke.lastY = absY;
    stroke.lastT = t;
  }

  private flushPending = (): void => {
    if (!this.sendBatched) return;
    for (const stroke of this.localStrokes.values()) {
      if (stroke.pending.length === 0) continue;
      this.sendBatched({
        kind: "Stroke",
        stroke_id: stroke.strokeId,
        origin: [stroke.originX, stroke.originY],
        points: stroke.pending,
        finished: false,
      });
      stroke.pending = [];
    }
  };
}

function newRender(color: string, originX: number, originY: number, prevX: number, prevY: number): StrokeRender {
  return {
    color,
    prevX,
    prevY,
    drawnX: originX,
    drawnY: originY,
    prevT: 0,
    width: BASE_WIDTH,
  };
}

function drawSegment(ctx: CanvasRenderingContext2D, render: StrokeRender, x: number, y: number, t: number): void {
  const dt = Math.max(1, t - render.prevT);
  const dist = Math.hypot(x - render.prevX, y - render.prevY);
  const speed = dist / dt; // px per ms
  const target = clamp(BASE_WIDTH / (1 + speed * (1 / VELOCITY_DAMPING) * 0.04), MIN_WIDTH, MAX_WIDTH);
  // smooth width changes
  render.width = render.width * 0.6 + target * 0.4;

  const midX = (render.prevX + x) / 2;
  const midY = (render.prevY + y) / 2;

  ctx.beginPath();
  ctx.moveTo(render.drawnX, render.drawnY);
  ctx.quadraticCurveTo(render.prevX, render.prevY, midX, midY);
  ctx.lineWidth = render.width;
  ctx.strokeStyle = render.color;
  ctx.stroke();

  render.drawnX = midX;
  render.drawnY = midY;
  render.prevX = x;
  render.prevY = y;
  render.prevT = t;
}

function lineToFinal(ctx: CanvasRenderingContext2D, render: StrokeRender, x: number, y: number): void {
  if (render.drawnX === x && render.drawnY === y) return;
  ctx.beginPath();
  ctx.moveTo(render.drawnX, render.drawnY);
  ctx.lineTo(x, y);
  ctx.lineWidth = render.width;
  ctx.strokeStyle = render.color;
  ctx.stroke();
  render.drawnX = x;
  render.drawnY = y;
}

function colorFor(playerId: number): string {
  return PALETTE[playerId % PALETTE.length];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
