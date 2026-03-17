// ─── Types ────────────────────────────────────────────────────────────────────
export interface GCodeLine {
  lineNum: number;
  raw: string;
  command: string;
  params: Record<string, number>;
  type: "rapid" | "cut" | "arc" | "probe" | "comment" | "other";
  x?: number; y?: number; z?: number;
}

export interface ToolPath {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  type: "rapid" | "cut" | "arc" | "probe";
  lineNum: number;
  feedrate?: number;
  arcCx?: number; arcCy?: number; arcR?: number;
  arcStartAngle?: number; arcEndAngle?: number; arcCCW?: boolean;
}

export interface ParseResult {
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
    spindleSpeeds: number[];
    tools: number[];
    plungeFeed: number | null;
    cuttingFeed: number | null;
    rapidFeed: number | null;
  };
}

// ─── Dialect detection ────────────────────────────────────────────────────────
export function detectDialect(code: string): string {
  if (/ArtCAM/i.test(code) || /G71/.test(code) && /N\d+G\d+/.test(code)) return "ArtCAM";
  if (/HAAS/i.test(code)) return "Haas CNC";
  if (/FANUC/i.test(code) || /\(FANUC/i.test(code)) return "Fanuc";
  if (/;MACH3/i.test(code) || /\(Mach3/i.test(code)) return "Mach3";
  if (/GRBL/i.test(code) || /\$H/i.test(code)) return "GRBL";
  if (/LinuxCNC/i.test(code)) return "LinuxCNC";
  if (/Marlin/i.test(code) || /M104/i.test(code)) return "Marlin 3D";
  if (/^N\d+/m.test(code)) return "Fanuc / ArtCAM";
  return "G-code (Generic)";
}

// ─── Parser ───────────────────────────────────────────────────────────────────
export function parseGCode(code: string): ParseResult {
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

    raw = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").trim();
    if (!raw) continue;

    const stripped = raw.replace(/^N\d+\s*/i, "");
    const isComment = /^[;(%]/.test(raw);

    const params: Record<string, number> = {};
    const paramPattern = /([A-Za-z])([+-]?\d+\.?\d*)/g;
    let m;
    while ((m = paramPattern.exec(stripped)) !== null) {
      const letter = m[1].toUpperCase();
      if (letter === "N") continue;
      params[letter] = parseFloat(m[2]);
    }

    const gcodes: string[] = [];
    const gcodePattern = /G(\d+\.?\d*)/gi;
    let gm;
    while ((gm = gcodePattern.exec(stripped)) !== null) {
      gcodes.push("G" + parseInt(gm[1]).toString().padStart(2, "0").replace(/^G0(\d)$/, "G0$1"));
    }
    const normalizeG = (g: string) => "G" + parseInt(g.slice(1));
    const gcodeNorm = gcodes.map(normalizeG);

    const mcodes: string[] = [];
    const mcodePattern = /M(\d+)/gi;
    while ((gm = mcodePattern.exec(stripped)) !== null) {
      mcodes.push("M" + parseInt(gm[1]));
    }

    for (const g of gcodeNorm) {
      if (g === "G0") modal.motion = "G0";
      else if (g === "G1") modal.motion = "G1";
      else if (g === "G2") { modal.motion = "G2"; modal.arcCCW = false; }
      else if (g === "G3") { modal.motion = "G3"; modal.arcCCW = true; }
      else if (g === "G90") modal.coords = "G90";
      else if (g === "G91") modal.coords = "G91";
    }

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

    const hasG0 = gcodeNorm.includes("G0");
    const hasG1 = gcodeNorm.includes("G1");
    const hasG2 = gcodeNorm.includes("G2");
    const hasG3 = gcodeNorm.includes("G3");

    if (isComment) {
      type = "comment";
    } else if (hasG2 || hasG3 || modal.motion === "G2" || modal.motion === "G3") {
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
      type = "cut";
      if (hasMotion) {
        cutDist += dist3(pos, newPos);
        cutMoves++;
        paths.push({ from: { ...pos }, to: { ...newPos }, type: "cut", lineNum: i + 1, feedrate });
      }
    } else if (hasG0 || (!hasG1 && !hasG2 && !hasG3 && modal.motion === "G0" && hasMotion)) {
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

    const displayCmd = gcodeNorm[0] || mcodes[0] || "";
    lines.push({ lineNum: i + 1, raw: rawLines[i].trim(), command: displayCmd, params, type });
  }

  const totalDist = rapidDist + cutDist;
  const avgFeed = feedrates.length ? feedrates.reduce((a, b) => a + b, 0) / feedrates.length : 300;
  const estimatedTime = (cutDist / Math.max(1, avgFeed)) + (rapidDist / 3000);

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

// ─── Demo G-code ──────────────────────────────────────────────────────────────
export const DEMO_GCODE = `N0G00 G21 G17 G90
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function formatTime(minutes: number): string {
  if (minutes < 1) return `${(minutes * 60).toFixed(0)}с`;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  const s = Math.round((minutes * 60) % 60);
  if (h > 0) return `${h}ч ${m}м ${s}с`;
  return `${m}м ${s}с`;
}

export function formatDist(mm: number): string {
  if (mm > 1000) return `${(mm / 1000).toFixed(2)} м`;
  return `${mm.toFixed(1)} мм`;
}

export function getLineColor(type: GCodeLine["type"]): string {
  switch (type) {
    case "rapid": return "text-amber-400";
    case "cut": return "text-emerald-400";
    case "arc": return "text-sky-400";
    case "probe": return "text-purple-400";
    case "comment": return "text-white/22";
    default: return "text-white/55";
  }
}
