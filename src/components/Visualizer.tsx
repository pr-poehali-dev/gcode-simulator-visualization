import { useState, useRef, useEffect, useCallback } from "react";
import { ToolPath, ParseResult } from "@/lib/gcode-types";

interface VisualizerProps {
  paths: ToolPath[];
  stats: ParseResult["stats"] | null;
  activeLine: number | null;
}

export default function Visualizer({ paths, stats, activeLine }: VisualizerProps) {
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

    // Origin crosshair
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.85 : 1.15;
    setZoom(z => {
      const newZoom = Math.max(0.1, Math.min(20, z * factor));
      setPan(p => ({
        x: mouseX - (mouseX - p.x) * (newZoom / z),
        y: mouseY - (mouseY - p.y) * (newZoom / z),
      }));
      return newZoom;
    });
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

      {/* Layer toggles */}
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

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <button onClick={() => setZoom(z => Math.min(20, z * 1.3))} className="w-7 h-7 flex items-center justify-center border border-white/10 text-white/50 hover:text-emerald-400 hover:border-emerald-500/40 font-mono text-xs transition-all bg-black/60">+</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="w-7 h-7 flex items-center justify-center border border-white/10 text-white/50 hover:text-emerald-400 hover:border-emerald-500/40 font-mono text-[8px] transition-all bg-black/60">FIT</button>
        <button onClick={() => setZoom(z => Math.max(0.1, z * 0.77))} className="w-7 h-7 flex items-center justify-center border border-white/10 text-white/50 hover:text-emerald-400 hover:border-emerald-500/40 font-mono text-xs transition-all bg-black/60">−</button>
      </div>

      <div className="absolute bottom-3 left-3 text-[10px] font-mono text-white/25">
        {(zoom * 100).toFixed(0)}% · перетащи · колесо: зум
      </div>

      {/* Start / End legend */}
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
