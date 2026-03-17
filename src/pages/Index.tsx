import { useState, useRef, useEffect } from "react";
import Icon from "@/components/ui/icon";
import TabContent from "@/components/TabContent";
import { ParseResult, parseGCode, DEMO_GCODE, formatTime } from "@/lib/gcode-types";

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

      {/* Tab content */}
      <TabContent
        activeTab={activeTab}
        parsed={parsed}
        gcode={gcode}
        activeLine={activeLine}
        fileInputRef={fileInputRef}
        setActiveLine={setActiveLine}
        setGCode={setGCode}
        setParsed={setParsed}
        setActiveTab={setActiveTab}
        handleParse={handleParse}
      />

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
