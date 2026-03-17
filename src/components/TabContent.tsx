import Icon from "@/components/ui/icon";
import Visualizer from "@/components/Visualizer";
import { ParseResult, GCodeLine, DEMO_GCODE, parseGCode, formatTime, formatDist, getLineColor } from "@/lib/gcode-types";

type Tab = "visual" | "control" | "params" | "analysis";

interface TabContentProps {
  activeTab: Tab;
  parsed: ParseResult | null;
  gcode: string;
  activeLine: number | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  setActiveLine: (n: number | null) => void;
  setGCode: (s: string) => void;
  setParsed: (r: ParseResult) => void;
  setActiveTab: (t: Tab) => void;
  handleParse: () => void;
}

export default function TabContent({
  activeTab, parsed, gcode, activeLine, fileInputRef,
  setActiveLine, setGCode, setParsed, setActiveTab, handleParse,
}: TabContentProps) {
  const s = parsed?.stats;

  return (
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
              {parsed?.lines.map((line: GCodeLine, i: number) => (
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
                  Клик или перетащи файл<br />.nc .gcode .ngc .tap .cnc
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
                      { l: "Инструменты (T)", v: s.tools.length ? s.tools.map(t => `T${t.toString().padStart(2, "0")}`).join(", ") : "—", c: "text-purple-400" },
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
                                opacity: 0.65,
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
  );
}
