import { useState, useRef, useEffect, useCallback } from "react";
import Icon from "@/components/ui/icon";

// ─── Types ────────────────────────────────────────────────────────────────────
interface GCodeLine {
  lineNum: number;
  raw: string;
  command: string;
  params: Record<string, number>;
  type: "rapid" | "cut" | "arc" | "probe" | "comment" | "other";
  x?: number; y?: number; z?: number;
}

interface ToolPath {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  type: "rapid" | "cut" | "arc" | "probe";
  lineNum: number;
  feedrate?: number;
  // arc-specific
  arcCx?: number; arcCy?: number; arcR?: number;
  arcStartAngle?: number; arcEndAngle?: number; arcCCW?: boolean;
}

interface ParseResult {
  lines: GCodeLine[];
  paths: ToolPath[];
  stats: {
    totalLines: number;
    rapidMoves: number;
    cutMoves: number;
    arcs: number;
    estimatedTime: number;
    totalDistance: number;
    cuttingDistance: number;
    rapidDistance: number;
    maxDepth: number;
    boundingBox: { minX: number; maxX: number; minY: number; maxY: number };
    feedrates: number[];
    dialect: string;
    // extracted from code
    spindleSpeeds: number[];
    tools: number[];
    plungeFeed: number | null;
    cuttingFeed: number | null;
    rapidFeed: number | null;
  };
}

// ─── G-Code Parser ────────────────────────────────────────────────────────────
function detectDialect(code: string): string {
  if (/ArtCAM/i.test(code) || /G71/.test(code) && /N\d+G\d+/.test(code)) return "ArtCAM";
  if (/HAAS/i.test(code)) return "Haas CNC";
  if (/FANUC/i.test(code) || /\(FANUC/i.test(code)) return "Fanuc";
  if (/;MACH3/i.test(code) || /\(Mach3/i.test(code)) return "Mach3";
  if (/GRBL/i.test(code) || /\$H/i.test(code)) return "GRBL";
  if (/LinuxCNC/i.test(code)) return "LinuxCNC";
  if (/Marlin/i.test(code) || /M104/i.test(code)) return "Marlin 3D";
  // Detect N-numbered lines (Fanuc-style or ArtCAM)
  if (/^N\d+/m.test(code)) return "Fanuc / ArtCAM";
  return "G-code (Generic)";
}

function parseGCode(code: string): ParseResult {
  const rawLines = code.split("\n");
  const lines: GCodeLine[] = [];
  const paths: ToolPath[] = [];

  let pos = { x: 0, y: 0, z: 0 };
  const modal = { motion: "G0", coords: "G90", arcCCW: false };
  let feedrate = 300;
  const feedrates: number[] = [];
  const spindleSpeeds: number[] = [];
  const tools: number[] = [];
  let rapidDist = 0, cutDist = 0;
  let maxDepth = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let rapidMoves = 0, cutMoves = 0, arcs = 0;
  let firstPlungeFeed: number | null = null;
  let maxCuttingFeed: number | null = null;

  const dist3 = (a: typeof pos, b: typeof pos) =>
    Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);

  for (let i = 0; i < rawLines.length; i++) {
    let raw = rawLines[i].trim();
    if (!raw) continue;

    // Strip inline comments: (text) and ;text
    raw = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").trim();
    if (!raw) continue;

    // Strip line numbers: N0, N10, N100 etc (at start of line)
    const stripped = raw.replace(/^N\d+\s*/i, "");

    const isComment = /^[;(%]/.test(raw);

    // Parse ALL word-address params from the stripped line
    const params: Record<string, number> = {};
    const paramPattern = /([A-Za-z])([+-]?\d+\.?\d*)/g;
    let m;
    while ((m = paramPattern.exec(stripped)) !== null) {
      const letter = m[1].toUpperCase();
      // Skip N (line numbers) and already-used letters
      if (letter === "N") continue;
      params[letter] = parseFloat(m[2]);
    }

    // Find ALL G-codes on this line (ArtCAM puts multiple: N0G00 G21 G17 G90)
    const gcodes: string[] = [];
    const gcodePattern = /G(\d+\.?\d*)/gi;
    let gm;
    while ((gm = gcodePattern.exec(stripped)) !== null) {
      gcodes.push("G" + parseInt(gm[1]).toString().padStart(2, "0").replace(/^G0(\d)$/, "G0$1"));
    }
    // Normalize: G00→G0, G01→G1, etc but keep as canonical string
    const normalizeG = (g: string) => {
      const n = parseInt(g.slice(1));
      return "G" + n;
    };
    const gcodeNorm = gcodes.map(normalizeG);

    // Find M-codes
    const mcodes: string[] = [];
    const mcodePattern = /M(\d+)/gi;
    while ((gm = mcodePattern.exec(stripped)) !== null) {
      mcodes.push("M" + parseInt(gm[1]));
    }

    // Update modal state from all G-codes on this line
    for (const g of gcodeNorm) {
      if (g === "G0") modal.motion = "G0";
      else if (g === "G1") modal.motion = "G1";
      else if (g === "G2") { modal.motion = "G2"; modal.arcCCW = false; }
      else if (g === "G3") { modal.motion = "G3"; modal.arcCCW = true; }
      else if (g === "G90") modal.coords = "G90";
      else if (g === "G91") modal.coords = "G91";
      // G71 = metric (same as G21), G70 = inch (same as G20)
    }

    // Update feedrate, spindle, tool
    if (params.F) {
      feedrate = params.F;
      if (!feedrates.includes(feedrate)) feedrates.push(feedrate);
      if (params.Z !== undefined && params.Z < pos.z && firstPlungeFeed === null) firstPlungeFeed = feedrate;
      if (params.X !== undefined || params.Y !== undefined) {
        if (maxCuttingFeed === null || feedrate > maxCuttingFeed) maxCuttingFeed = feedrate;
      }
    }
    if (params.S && params.S > 0 && !spindleSpeeds.includes(params.S)) spindleSpeeds.push(params.S);
    if (params.T && params.T > 0 && !tools.includes(params.T)) tools.push(params.T);

    const newPos = {
      x: params.X !== undefined ? (modal.coords === "G90" ? params.X : pos.x + params.X) : pos.x,
      y: params.Y !== undefined ? (modal.coords === "G90" ? params.Y : pos.y + params.Y) : pos.y,
      z: params.Z !== undefined ? (modal.coords === "G90" ? params.Z : pos.z + params.Z) : pos.z,
    };

    let type: GCodeLine["type"] = "other";
    const hasMotion = params.X !== undefined || params.Y !== undefined || params.Z !== undefined;

    // Determine move type:
    // Priority: explicit G on this line > modal
    const hasG0 = gcodeNorm.includes("G0");
    const hasG1 = gcodeNorm.includes("G1");
    const hasG2 = gcodeNorm.includes("G2");
    const hasG3 = gcodeNorm.includes("G3");

    if (isComment) {
      type = "comment";
    } else if (hasG2 || hasG3 || modal.motion === "G2" || modal.motion === "G3") {
      // Arc — only if there's actual motion params
      if (hasMotion || params.I !== undefined || params.J !== undefined) {
        type = "arc";
        const isCCW = hasG3 || (!hasG2 && modal.motion === "G3");
        const arcCx = pos.x + (params.I ?? 0);
        const arcCy = pos.y + (params.J ?? 0);
        const arcR = Math.sqrt((pos.x - arcCx) ** 2 + (pos.y - arcCy) ** 2);
        const startAngle = Math.atan2(pos.y - arcCy, pos.x - arcCx);
        const endAngle = Math.atan2(newPos.y - arcCy, newPos.x - arcCx);
        let dAngle = isCCW ? endAngle - startAngle : startAngle - endAngle;
        if (dAngle <= 0) dAngle += Math.PI * 2;
        if (params.X === undefined && params.Y === undefined) dAngle = Math.PI * 2;
        cutDist += arcR * dAngle;
        arcs++;
        paths.push({
          from: { ...pos }, to: { ...newPos }, type: "arc", lineNum: i + 1, feedrate,
          arcCx, arcCy, arcR, arcStartAngle: startAngle, arcEndAngle: endAngle, arcCCW: isCCW,
        });
      }
    } else if (hasG1 || (!hasG0 && !hasG2 && !hasG3 && modal.motion === "G1" && hasMotion)) {
      // Linear cut
      type = "cut";
      if (hasMotion) {
        cutDist += dist3(pos, newPos);
        cutMoves++;
        paths.push({ from: { ...pos }, to: { ...newPos }, type: "cut", lineNum: i + 1, feedrate });
      }
    } else if (hasG0 || (!hasG1 && !hasG2 && !hasG3 && modal.motion === "G0" && hasMotion)) {
      // Rapid
      type = "rapid";
      if (hasMotion) {
        rapidDist += dist3(pos, newPos);
        rapidMoves++;
        paths.push({ from: { ...pos }, to: { ...newPos }, type: "rapid", lineNum: i + 1, feedrate });
      }
    } else if (stripped.match(/^G38/i)) {
      type = "probe";
    }

    if (hasMotion) {
      if (newPos.z < maxDepth) maxDepth = newPos.z;
      if (type !== "comment" && type !== "other") {
        minX = Math.min(minX, newPos.x); maxX = Math.max(maxX, newPos.x);
        minY = Math.min(minY, newPos.y); maxY = Math.max(maxY, newPos.y);
      }
      pos = newPos;
    }

    // Determine display command label
    const displayCmd = gcodeNorm[0] || mcodes[0] || "";
    lines.push({ lineNum: i + 1, raw: rawLines[i].trim(), command: displayCmd, params, type });
  }

  const totalDist = rapidDist + cutDist;
  const avgFeed = feedrates.length ? feedrates.reduce((a, b) => a + b, 0) / feedrates.length : 300;
  const rapidSpeed = 3000;
  const estimatedTime = (cutDist / Math.max(1, avgFeed)) + (rapidDist / rapidSpeed);

  return {
    lines,
    paths,
    stats: {
      totalLines: rawLines.length,
      rapidMoves, cutMoves, arcs,
      estimatedTime,
      totalDistance: totalDist,
      cuttingDistance: cutDist,
      rapidDistance: rapidDist,
      maxDepth,
      boundingBox: {
        minX: isFinite(minX) ? minX : 0, maxX: isFinite(maxX) ? maxX : 100,
        minY: isFinite(minY) ? minY : 0, maxY: isFinite(maxY) ? maxY : 100,
      },
      feedrates: feedrates.sort((a, b) => a - b),
      dialect: detectDialect(code),
      spindleSpeeds: spindleSpeeds.sort((a, b) => a - b),
      tools: tools.sort((a, b) => a - b),
      plungeFeed: firstPlungeFeed,
      cuttingFeed: maxCuttingFeed,
      rapidFeed: 3000,
    },
  };
}

// ─── Demo G-code ─────────────────────────────────────────────────────────────
const DEMO_GCODE = `N0G00 G21 G17 G90
N10G00 G40 G49 G80
N20G71
N30T8M6
N40G43Z50.000H1M8
S18000M03
X0.000Y0.000
N70G00X10.000Y10.000Z50.000
N80G01Z-2.000F800.0
N90G01Y90.000F5000.0
N100X90.000
N110G01Y10.000
N120X10.000
N130G00Z50.000
N140G00X50.000Y50.000
N150G01Z-3.000F800.0
N160G02X50.000Y50.000I20.000J0.000F4000.0
N170G01Z-5.000F500.0
N180G02X50.000Y50.000I10.000J0.000F3000.0
N190G00Z50.000
N200G00X30.000Y30.000
N210G01Z-1.000F800.0
N220G01X70.000Y70.000F5000.0
N230G00Z50.000
N240G00X70.000Y30.000
N250G01Z-1.000F800.0
N260G01X30.000Y70.000F5000.0
N270G00Z50.000
N280G00X0.000Y0.000
N290M09
N300M30`;

// ─── Canvas Visualizer ────────────────────────────────────────────────────────
interface VisualizerProps {
  paths: ToolPath[];
  stats: ParseResult["stats"] | null;
  activeLine: number | null;
}

function Visualizer({ paths, stats, activeLine }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showRapid, setShowRapid] = useState(true);
  const [showCut, setShowCut] = useState(true);
  const [showArcs, setShowArcs] = useState(true);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#070a0f";
    ctx.fillRect(0, 0, W, H);

    const gridStep = 20 * zoom;
    const offsetX = (pan.x % gridStep + gridStep) % gridStep;
    const offsetY = (pan.y % gridStep + gridStep) % gridStep;

    ctx.strokeStyle = "rgba(0,229,160,0.05)";
    ctx.lineWidth = 0.5;
    for (let x = offsetX; x < W; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = offsetY; y < H; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const majorStep = 100 * zoom;
    const mOffX = (pan.x % majorStep + majorStep) % majorStep;
    const mOffY = (pan.y % majorStep + majorStep) % majorStep;
    ctx.strokeStyle = "rgba(0,229,160,0.1)";
    for (let x = mOffX; x < W; x += majorStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = mOffY; y < H; y += majorStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    if (!paths.length || !stats) return;

    const { minX, maxX, minY, maxY } = stats.boundingBox;
    const rangeX = (maxX - minX) || 100;
    const rangeY = (maxY - minY) || 100;
    const padding = 60;
    const scaleBase = Math.min((W - padding * 2) / rangeX, (H - padding * 2) / rangeY);
    const scale = scaleBase * zoom;
    const cx = W / 2 + pan.x - ((minX + maxX) / 2) * scale;
    const cy = H / 2 + pan.y + ((minY + maxY) / 2) * scale;

    const toScreen = (wx: number, wy: number) => ({
      sx: cx + wx * scale,
      sy: cy - wy * scale,
    });

    // Origin
    const origin = toScreen(0, 0);
    ctx.strokeStyle = "rgba(0,229,160,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(origin.sx - 18, origin.sy); ctx.lineTo(origin.sx + 18, origin.sy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(origin.sx, origin.sy - 18); ctx.lineTo(origin.sx, origin.sy + 18); ctx.stroke();
    ctx.setLineDash([]);

    paths.forEach((path, idx) => {
      if (!showRapid && path.type === "rapid") return;
      if (!showCut && path.type === "cut") return;
      if (!showArcs && path.type === "arc") return;

      const isActive = activeLine !== null && Math.abs(path.lineNum - activeLine) < 3;
      const from = toScreen(path.from.x, path.from.y);
      const to = toScreen(path.to.x, path.to.y);

      if (path.type === "arc") {
        ctx.strokeStyle = isActive ? "#80d8ff" : "rgba(79,195,247,0.8)";
        ctx.lineWidth = isActive ? 2.5 : 1.5;
        if (path.arcCx !== undefined && path.arcCy !== undefined && path.arcR !== undefined && path.arcR > 0) {
          const screenCx = cx + path.arcCx * scale;
          const screenCy = cy - path.arcCy * scale;
          const screenR = path.arcR * scale;
          const startA = path.arcStartAngle ?? 0;
          const endA = path.arcEndAngle ?? 0;
          const isCCW = path.arcCCW ?? false;
          const isFullCircle =
            Math.abs(path.from.x - path.to.x) < 0.001 &&
            Math.abs(path.from.y - path.to.y) < 0.001;
          ctx.beginPath();
          if (isFullCircle) {
            ctx.arc(screenCx, screenCy, screenR, 0, Math.PI * 2);
          } else {
            ctx.arc(screenCx, screenCy, screenR, -startA, -endA, isCCW);
          }
        } else {
          const midX = (from.sx + to.sx) / 2 + (to.sy - from.sy) * 0.3;
          const midY = (from.sy + to.sy) / 2 - (to.sx - from.sx) * 0.3;
          ctx.beginPath();
          ctx.moveTo(from.sx, from.sy);
          ctx.quadraticCurveTo(midX, midY, to.sx, to.sy);
        }
      } else if (path.type === "rapid") {
        ctx.beginPath();
        ctx.moveTo(from.sx, from.sy);
        ctx.lineTo(to.sx, to.sy);
        ctx.strokeStyle = isActive ? "#ffd740" : "rgba(255,179,0,0.5)";
        ctx.lineWidth = isActive ? 2 : 0.8;
        ctx.setLineDash([5, 4]);
      } else if (path.type === "cut") {
        ctx.beginPath();
        ctx.moveTo(from.sx, from.sy);
        ctx.lineTo(to.sx, to.sy);
        ctx.strokeStyle = isActive ? "#69ffca" : "rgba(0,229,160,0.9)";
        ctx.lineWidth = isActive ? 2.5 : 1.5;
      } else {
        ctx.beginPath();
        ctx.moveTo(from.sx, from.sy);
        ctx.lineTo(to.sx, to.sy);
        ctx.strokeStyle = "rgba(206,147,216,0.7)";
        ctx.lineWidth = 1;
      }

      ctx.stroke();
      ctx.setLineDash([]);

      if (path.type === "cut" && idx % 4 === 0) {
        const angle = Math.atan2(to.sy - from.sy, to.sx - from.sx);
        const mx = (from.sx + to.sx) / 2, my = (from.sy + to.sy) / 2;
        const al = 5;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - al * Math.cos(angle - 0.4), my - al * Math.sin(angle - 0.4));
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - al * Math.cos(angle + 0.4), my - al * Math.sin(angle + 0.4));
        ctx.strokeStyle = "rgba(0,229,160,0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    if (paths.length) {
      const start = toScreen(paths[0].from.x, paths[0].from.y);
      ctx.beginPath(); ctx.arc(start.sx, start.sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#00e5a0"; ctx.shadowColor = "#00e5a0"; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;

      const last = paths[paths.length - 1];
      const end = toScreen(last.to.x, last.to.y);
      ctx.beginPath(); ctx.arc(end.sx, end.sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ff4444"; ctx.shadowColor = "#ff4444"; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
    }

    const bb1 = toScreen(minX, minY), bb2 = toScreen(maxX, maxY);
    ctx.strokeStyle = "rgba(0,229,160,0.12)";
    ctx.lineWidth = 1; ctx.setLineDash([6, 3]);
    ctx.strokeRect(bb1.sx, bb2.sy, bb2.sx - bb1.sx, bb1.sy - bb2.sy);
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(0,229,160,0.45)";
    ctx.font = '10px "JetBrains Mono"';
    ctx.fillText(`${(maxX - minX).toFixed(1)}mm`, bb1.sx + 4, bb2.sy - 4);
    ctx.save(); ctx.translate(bb2.sx + 4, bb1.sy); ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${(maxY - minY).toFixed(1)}mm`, 4, 8); ctx.restore();
  }, [paths, stats, zoom, pan, showRapid, showCut, showArcs, activeLine]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleResize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(canvas);
    handleResize();
    return () => ro.disconnect();
  }, [draw]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.max(0.1, Math.min(20, z * (e.deltaY > 0 ? 0.85 : 1.15))));
  };

  return (
    <div className="relative w-full h-full bg-[#070a0f]">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ cursor: isDragging ? "grabbing" : "crosshair" }}
        onWheel={handleWheel}
        onMouseDown={e => { setIsDragging(true); setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y }); }}
        onMouseMove={e => { if (isDragging) setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }); }}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
      />

      <div className="absolute top-3 left-3 flex flex-col gap-1">
        {[
          { key: "rapid", label: "RAPID G00", color: "amber", show: showRapid, toggle: () => setShowRapid(v => !v) },
          { key: "cut", label: "CUT G01", color: "emerald", show: showCut, toggle: () => setShowCut(v => !v) },
          { key: "arcs", label: "ARC G02/03", color: "sky", show: showArcs, toggle: () => setShowArcs(v => !v) },
        ].map(item => (
          <button key={item.key} onClick={item.toggle}
            className={`flex items-center gap-2 px-2 py-1 text-[10px] font-mono border transition-all
              ${item.show
                ? `border-${item.color}-500/40 text-${item.color}-400 bg-${item.color}-500/5`
                : "border-white/8 text-white/25 bg-transparent"}`}>
            <span className="w-4 h-px inline-block" style={{
              background: item.show
                ? item.color === "amber" ? "#ffb300" : item.color === "emerald" ? "#00e5a0" : "#4fc3f7"
                : "#333"
            }}></span>
            {item.label}
          </button>
        ))}
      </div>

      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <button onClick={() => setZoom(z => Math.min(20, z * 1.3))} className="w-7 h-7 flex items-center justify-center border border-white/10 text-white/50 hover:text-emerald-400 hover:border-emerald-500/40 font-mono text-xs transition-all bg-black/60">+</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="w-7 h-7 flex items-center justify-center border border-white/10 text-white/50 hover:text-emerald-400 hover:border-emerald-500/40 font-mono text-[8px] transition-all bg-black/60">FIT</button>
        <button onClick={() => setZoom(z => Math.max(0.1, z * 0.77))} className="w-7 h-7 flex items-center justify-center border border-white/10 text-white/50 hover:text-emerald-400 hover:border-emerald-500/40 font-mono text-xs transition-all bg-black/60">−</button>
      </div>

      <div className="absolute bottom-3 left-3 text-[10px] font-mono text-white/25">
        {(zoom * 100).toFixed(0)}% · перетащи · колесо: зум
      </div>

      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <div className="flex items-center gap-2 text-[10px] font-mono text-emerald-400/60">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span>START
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-red-400/60">
          <span className="w-2 h-2 rounded-full bg-red-400 inline-block"></span>END
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTime(minutes: number): string {
  if (minutes < 1) return `${(minutes * 60).toFixed(0)}с`;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  const s = Math.round((minutes * 60) % 60);
  if (h > 0) return `${h}ч ${m}м ${s}с`;
  return `${m}м ${s}с`;
}

function formatDist(mm: number): string {
  if (mm > 1000) return `${(mm / 1000).toFixed(2)} м`;
  return `${mm.toFixed(1)} мм`;
}

function getLineColor(type: GCodeLine["type"]): string {
  switch (type) {
    case "rapid": return "text-amber-400";
    case "cut": return "text-emerald-400";
    case "arc": return "text-sky-400";
    case "probe": return "text-purple-400";
    case "comment": return "text-white/22";
    default: return "text-white/55";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
type Tab = "visual" | "control" | "params" | "analysis";

export default function Index() {
  const [activeTab, setActiveTab] = useState<Tab>("visual");
  const [gcode, setGCode] = useState(DEMO_GCODE);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setParsed(parseGCode(DEMO_GCODE));
  }, []);

  const handleParse = () => {
    const result = parseGCode(gcode);
    setParsed(result);
    setActiveTab("visual");
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      setGCode(text);
      setParsed(parseGCode(text));
      setActiveTab("visual");
    };
    reader.readAsText(file);
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "visual", label: "Визуализация", icon: "Crosshair" },
    { id: "control", label: "Управление", icon: "Sliders" },
    { id: "params", label: "Параметры", icon: "Settings2" },
    { id: "analysis", label: "Анализ", icon: "BarChart3" },
  ];

  const s = parsed?.stats;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#070a0f] overflow-hidden font-sans">

      {/* Header */}
      <header className="flex-none flex items-center justify-between px-4 h-10 border-b border-white/[0.07] bg-[#060910]">
        <div className="flex items-center gap-3">
          <div className="flex gap-1 items-center">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 cnc-pulse"></div>
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400/50"></div>
            <div className="w-1.5 h-1.5 rounded-full bg-red-400/35"></div>
          </div>
          <span className="font-display text-sm font-semibold tracking-[0.22em] text-white uppercase">
            G<span className="text-emerald-400">SIM</span>
          </span>
          <span className="text-[9px] font-mono text-white/18 hidden sm:block">CNC Simulator v1.0</span>
        </div>

        <div className="flex items-center gap-4">
          {s && (
            <div className="hidden md:flex items-center gap-4 text-[10px] font-mono">
              <span className="text-emerald-400/75">{s.dialect}</span>
              <span className="text-white/35">{s.totalLines} стр</span>
              <span className="text-white/35">{s.cutMoves + s.rapidMoves + s.arcs} оп</span>
              <span className="text-amber-400/75">~ {formatTime(s.estimatedTime)}</span>
            </div>
          )}
          <button onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 h-6 text-[10px] font-mono border border-white/12 text-white/50 hover:text-emerald-400 hover:border-emerald-500/35 transition-all">
            <Icon name="Upload" size={10} />
            Загрузить
          </button>
          <input ref={fileInputRef} type="file" accept=".nc,.gcode,.ngc,.cnc,.tap,.txt" className="hidden" onChange={handleFileUpload} />
        </div>
      </header>

      {/* Tabs */}
      <div className="flex-none flex items-stretch h-8 border-b border-white/[0.07] bg-[#060910]">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`relative flex items-center gap-1.5 px-4 text-[10px] font-mono tracking-widest uppercase transition-all
              ${activeTab === tab.id
                ? "text-emerald-400 bg-emerald-400/[0.04] cnc-tab-active"
                : "text-white/30 hover:text-white/55 hover:bg-white/[0.02]"}`}>
            <Icon name={tab.icon} size={10} />
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">

        {/* ─ VISUALIZATION ─ */}
        {activeTab === "visual" && (
          <div className="flex h-full">
            <div className="flex-1 relative">
              <Visualizer paths={parsed?.paths ?? []} stats={s ?? null} activeLine={activeLine} />
            </div>
            <div className="w-48 flex-none border-l border-white/[0.07] flex flex-col bg-[#060910]">
              <div className="flex-none px-3 py-2 border-b border-white/[0.07] text-[9px] font-mono text-white/25 uppercase tracking-wider">
                G-code · {parsed?.lines.length ?? 0} строк
              </div>
              <div className="flex-1 overflow-y-auto">
                {parsed?.lines.map((line, i) => (
                  <div key={i} onMouseEnter={() => setActiveLine(line.lineNum)} onMouseLeave={() => setActiveLine(null)}
                    className={`px-2 py-0.5 transition-colors cursor-default ${activeLine === line.lineNum ? "bg-emerald-400/8" : "hover:bg-white/[0.02]"}`}>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[9px] font-mono text-white/18 w-5 text-right flex-none">{line.lineNum}</span>
                      <span className={`text-[10px] font-mono truncate ${getLineColor(line.type)}`}>
                        {line.raw.substring(0, 26)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─ CONTROL ─ */}
        {activeTab === "control" && (
          <div className="flex h-full">
            <div className="flex-1 flex flex-col">
              <div className="flex-none flex items-center justify-between px-4 py-2 border-b border-white/[0.07] bg-[#060910]">
                <span className="text-[10px] font-mono text-white/30 uppercase tracking-wider">Редактор G-code</span>
                <div className="flex gap-2">
                  <button onClick={() => setGCode(DEMO_GCODE)}
                    className="px-3 h-6 text-[10px] font-mono border border-white/12 text-white/45 hover:text-white/70 transition-all">
                    Demo
                  </button>
                  <button onClick={handleParse}
                    className="px-4 h-6 text-[10px] font-mono border border-emerald-500/45 text-emerald-400 hover:bg-emerald-400/8 transition-all">
                    ▶ ЗАПУСТИТЬ
                  </button>
                </div>
              </div>
              <textarea
                value={gcode}
                onChange={e => setGCode(e.target.value)}
                spellCheck={false}
                className="flex-1 bg-[#050709] text-emerald-400/85 font-mono text-[11px] p-4 resize-none outline-none border-0 leading-[1.6] selection:bg-emerald-400/15"
                placeholder="; Вставьте G-code сюда..."
                style={{ caretColor: "#00e5a0" }}
              />
            </div>

            <div className="w-60 flex-none border-l border-white/[0.07] flex flex-col bg-[#060910]">
              <div className="p-4 border-b border-white/[0.07]">
                <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">Загрузка файла</div>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("border-emerald-500/60"); }}
                  onDragLeave={e => { e.currentTarget.classList.remove("border-emerald-500/60"); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.classList.remove("border-emerald-500/60");
                    const file = e.dataTransfer.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = ev => {
                      const text = ev.target?.result as string;
                      setGCode(text);
                      setParsed(parseGCode(text));
                      setActiveTab("visual");
                    };
                    reader.readAsText(file);
                  }}
                  className="w-full h-20 border border-dashed border-white/12 hover:border-emerald-500/35 flex flex-col items-center justify-center gap-2 transition-all group cursor-pointer select-none">
                  <Icon name="FileUp" size={20} className="text-white/22 group-hover:text-emerald-400 transition-colors" />
                  <span className="text-[9px] font-mono text-white/25 group-hover:text-white/50 transition-colors text-center leading-relaxed">
                    Клик или перетащи файл<br/>.nc .gcode .ngc .tap .cnc
                  </span>
                </div>
              </div>

              <div className="p-4 border-b border-white/[0.07]">
                <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">Диалект CNC</div>
                <div className="flex flex-col gap-0.5">
                  {["G-code (Generic)", "Fanuc", "Haas CNC", "Mach3", "GRBL", "LinuxCNC", "Marlin 3D"].map(d => (
                    <div key={d} className={`px-3 py-1.5 text-[10px] font-mono border-l-2 transition-all
                      ${s?.dialect === d ? "border-emerald-400 text-emerald-400 bg-emerald-400/5" : "border-transparent text-white/30"}`}>
                      {d}
                    </div>
                  ))}
                </div>
              </div>

              {s && (
                <div className="p-4">
                  <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">Статус</div>
                  <div className="space-y-1.5">
                    {[
                      { k: "Строк", v: s.totalLines.toString(), c: "text-white/70" },
                      { k: "Операций", v: (s.cutMoves + s.rapidMoves + s.arcs).toString(), c: "text-white/70" },
                      { k: "Диалект", v: s.dialect, c: "text-amber-400/80" },
                      { k: "Ошибок", v: "0", c: "text-emerald-400" },
                    ].map(item => (
                      <div key={item.k} className="flex justify-between text-[10px] font-mono">
                        <span className="text-white/35">{item.k}</span>
                        <span className={item.c}>{item.v}</span>
                      </div>
                    ))}
                    <div className="mt-2 pt-2 border-t border-white/[0.07] flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
                      <span className="text-[10px] font-mono text-emerald-400/80">PARSED OK</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─ PARAMS ─ */}
        {activeTab === "params" && (
          <div className="h-full overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto space-y-3 animate-fade-in">
              <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-4">
                Параметры из G-code {s ? `· ${s.dialect}` : ""}
              </div>

              {!s ? (
                <div className="text-white/25 font-mono text-sm text-center py-12">Загрузите G-code</div>
              ) : (
                <>
                  {/* From code — read only */}
                  <div className="border border-emerald-500/20 p-4 bg-emerald-400/[0.02]">
                    <div className="text-[9px] font-mono text-emerald-400/60 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
                      Извлечено из кода
                    </div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                      {[
                        { l: "Подача врезания", v: s.plungeFeed ? `${s.plungeFeed} мм/мин` : "—", c: "text-sky-400" },
                        { l: "Подача резания", v: s.cuttingFeed ? `${s.cuttingFeed} мм/мин` : "—", c: "text-emerald-400" },
                        { l: "Скорость шпинделя", v: s.spindleSpeeds.length ? `${s.spindleSpeeds.join(", ")} об/мин` : "—", c: "text-amber-400" },
                        { l: "Инструменты (T)", v: s.tools.length ? s.tools.map(t => `T${t.toString().padStart(2,"0")}`).join(", ") : "—", c: "text-purple-400" },
                        { l: "Макс. глубина Z", v: `${Math.abs(s.maxDepth).toFixed(3)} мм`, c: "text-red-400" },
                        { l: "Все подачи F", v: s.feedrates.length ? s.feedrates.join(", ") : "—", c: "text-white/60" },
                        { l: "Рабочая зона X", v: `${s.boundingBox.minX.toFixed(1)} → ${s.boundingBox.maxX.toFixed(1)} мм`, c: "text-white/60" },
                        { l: "Рабочая зона Y", v: `${s.boundingBox.minY.toFixed(1)} → ${s.boundingBox.maxY.toFixed(1)} мм`, c: "text-white/60" },
                      ].map(row => (
                        <div key={row.l} className="flex flex-col gap-0.5">
                          <span className="text-[9px] font-mono text-white/25 uppercase">{row.l}</span>
                          <span className={`text-[11px] font-mono ${row.c}`}>{row.v}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Feedrates visual */}
                  {s.feedrates.length > 0 && (
                    <div className="border border-white/[0.07] p-4 bg-[#060910]">
                      <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">Подачи F в программе</div>
                      <div className="space-y-2">
                        {s.feedrates.map(f => {
                          const isPlunge = f === s.plungeFeed;
                          const isCut = f === s.cuttingFeed;
                          return (
                            <div key={f} className="flex items-center gap-3">
                              <span className={`text-[10px] font-mono w-28 ${isPlunge ? "text-sky-400" : isCut ? "text-emerald-400" : "text-amber-400"}`}>
                                {f} мм/мин
                              </span>
                              <div className="flex-1 h-[3px] bg-white/[0.04]">
                                <div className="h-full" style={{
                                  width: `${(f / Math.max(...s.feedrates)) * 100}%`,
                                  background: isPlunge ? "#4fc3f7" : isCut ? "#00e5a0" : "#ffb300",
                                  opacity: 0.65
                                }}></div>
                              </div>
                              <span className="text-[9px] font-mono text-white/20 w-16 text-right">
                                {isPlunge ? "врезание" : isCut ? "резание" : ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Spindle speeds */}
                  {s.spindleSpeeds.length > 0 && (
                    <div className="border border-white/[0.07] p-4 bg-[#060910]">
                      <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">Скорости шпинделя (S)</div>
                      <div className="flex gap-3 flex-wrap">
                        {s.spindleSpeeds.map(sp => (
                          <div key={sp} className="flex flex-col items-center px-4 py-2 border border-amber-500/20 bg-amber-400/[0.04]">
                            <span className="font-display text-lg font-semibold text-amber-400">{sp.toLocaleString()}</span>
                            <span className="text-[9px] font-mono text-white/25">об/мин</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tools */}
                  {s.tools.length > 0 && (
                    <div className="border border-white/[0.07] p-4 bg-[#060910]">
                      <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">Инструменты (T)</div>
                      <div className="flex gap-2 flex-wrap">
                        {s.tools.map(t => (
                          <div key={t} className="flex items-center gap-2 px-3 py-1.5 border border-purple-500/20 bg-purple-400/[0.04]">
                            <span className="text-[10px] font-mono text-purple-400">T{t.toString().padStart(2, "0")}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ─ ANALYSIS ─ */}
        {activeTab === "analysis" && (
          <div className="h-full overflow-y-auto p-6">
            {!s ? (
              <div className="flex items-center justify-center h-full text-white/25 font-mono text-sm">
                Загрузите G-code для анализа
              </div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-3 animate-fade-in">
                <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-4">
                  Анализ · {s.dialect} · {s.totalLines} строк
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "Время резки", value: formatTime(s.estimatedTime), sub: "расчётное", color: "text-emerald-400" },
                    { label: "Длина реза", value: formatDist(s.cuttingDistance), sub: "G01", color: "text-sky-400" },
                    { label: "Холостой ход", value: formatDist(s.rapidDistance), sub: "G00", color: "text-amber-400" },
                    { label: "Глубина", value: `${Math.abs(s.maxDepth).toFixed(2)}мм`, sub: "max по Z", color: "text-purple-400" },
                  ].map(stat => (
                    <div key={stat.label} className="border border-white/[0.07] p-4 bg-[#060910]">
                      <div className={`font-display text-2xl font-semibold ${stat.color}`}>{stat.value}</div>
                      <div className="text-[9px] font-mono text-white/28 mt-1 uppercase">{stat.label}</div>
                      <div className="text-[9px] font-mono text-white/18">{stat.sub}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="border border-white/[0.07] p-4 bg-[#060910]">
                    <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-4">Операции</div>
                    <div className="space-y-3">
                      {[
                        { label: "Ускоренный ход G00", count: s.rapidMoves, color: "#ffb300", pct: s.rapidMoves / Math.max(1, s.rapidMoves + s.cutMoves + s.arcs) * 100 },
                        { label: "Линейная резка G01", count: s.cutMoves, color: "#00e5a0", pct: s.cutMoves / Math.max(1, s.rapidMoves + s.cutMoves + s.arcs) * 100 },
                        { label: "Дуговая G02/03", count: s.arcs, color: "#4fc3f7", pct: s.arcs / Math.max(1, s.rapidMoves + s.cutMoves + s.arcs) * 100 },
                      ].map(op => (
                        <div key={op.label}>
                          <div className="flex justify-between text-[10px] font-mono mb-1">
                            <span className="text-white/45">{op.label}</span>
                            <span style={{ color: op.color }}>{op.count}</span>
                          </div>
                          <div className="h-[3px] bg-white/[0.04] w-full">
                            <div className="h-full" style={{ width: `${op.pct}%`, background: op.color, opacity: 0.65 }}></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border border-white/[0.07] p-4 bg-[#060910]">
                    <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-4">Подачи (F)</div>
                    {s.feedrates.length ? (
                      <div className="space-y-2">
                        {s.feedrates.map(f => (
                          <div key={f} className="flex items-center gap-3">
                            <span className="text-[10px] font-mono text-amber-400/80 w-24">{f} мм/мин</span>
                            <div className="flex-1 h-[3px] bg-white/[0.04]">
                              <div className="h-full bg-amber-400/55" style={{ width: `${(f / Math.max(...s.feedrates)) * 100}%` }}></div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] font-mono text-white/22">Подачи не заданы</div>
                    )}
                  </div>
                </div>

                <div className="border border-white/[0.07] p-4 bg-[#060910]">
                  <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-4">Рабочая зона (Bounding Box)</div>
                  <div className="grid grid-cols-3 gap-6">
                    {[
                      { ax: "X", min: s.boundingBox.minX, max: s.boundingBox.maxX, c: "text-red-400/80" },
                      { ax: "Y", min: s.boundingBox.minY, max: s.boundingBox.maxY, c: "text-emerald-400/80" },
                      { ax: "Z", min: s.maxDepth, max: 0, c: "text-sky-400/80" },
                    ].map(ax => (
                      <div key={ax.ax}>
                        <div className={`font-display text-xl font-semibold ${ax.c}`}>{ax.ax}</div>
                        <div className="text-[10px] font-mono text-white/38 mt-1 space-y-0.5">
                          <div><span className="text-white/20">min</span> {ax.min.toFixed(2)}</div>
                          <div><span className="text-white/20">max</span> {ax.max.toFixed(2)}</div>
                          <div><span className="text-white/20">Δ</span>{" "}<span className="text-white/60">{Math.abs(ax.max - ax.min).toFixed(2)} мм</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border border-white/[0.07] p-4 bg-[#060910]">
                  <div className="text-[9px] font-mono text-white/25 uppercase tracking-wider mb-3">КПД программы</div>
                  <div className="flex justify-between text-[10px] font-mono mb-1.5">
                    <span className="text-white/40">Резка / Холостой</span>
                    <span className="text-emerald-400">{((s.cuttingDistance / Math.max(1, s.totalDistance)) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-white/[0.04] w-full flex overflow-hidden">
                    <div className="h-full bg-emerald-400/65" style={{ width: `${(s.cuttingDistance / Math.max(1, s.totalDistance)) * 100}%` }}></div>
                    <div className="h-full bg-amber-400/35" style={{ width: `${(s.rapidDistance / Math.max(1, s.totalDistance)) * 100}%` }}></div>
                  </div>
                  <div className="flex gap-4 mt-1.5 text-[9px] font-mono text-white/30">
                    <span className="text-emerald-400/55">■ резка {formatDist(s.cuttingDistance)}</span>
                    <span className="text-amber-400/55">■ холостой {formatDist(s.rapidDistance)}</span>
                    <span>итого {formatDist(s.totalDistance)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex-none flex items-center justify-between px-4 h-6 border-t border-white/[0.07] bg-[#050709]">
        <div className="flex items-center gap-4 text-[9px] font-mono text-white/22">
          <span>X: <span className="text-white/45">0.000</span></span>
          <span>Y: <span className="text-white/45">0.000</span></span>
          <span>Z: <span className="text-white/45">0.000</span></span>
          {s && <span className="hidden sm:inline">F: <span className="text-amber-400/55">{s.feedrates[0] ?? 0}</span></span>}
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-white/18">
          <span>{s?.dialect ?? "—"}</span>
          <span>UTF-8</span>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 cnc-pulse"></div>
            <span className="text-emerald-400/45">READY</span>
          </div>
        </div>
      </div>
    </div>
  );
}