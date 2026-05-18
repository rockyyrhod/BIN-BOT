import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { motion } from 'framer-motion';
import { Trash2, Activity, Wifi, Settings, Power } from 'lucide-react';

const socket = io('http://localhost:3001');

// Original un-scaled constants
const LID_H  = 24;   // px — h-6
const BODY_H = 192;  // px — h-48
const BIN_W  = 192;  // px — w-48

export default function App() {
  const [binState, setBinState] = useState('CLOSED');
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [fillLevel, setFillLevel] = useState(0);

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('initialState', (data) => {
      setLogs(data.logs);
      if (data.logs.length > 0) {
        setBinState(data.logs[0].command);
      } else if (data.currentState) {
        setBinState(data.currentState);
      }
    });

    socket.on('binStateUpdate', (data) => {
      setBinState(data.state);
      setLogs(data.logs);
      setIsPublishing(false);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('initialState');
      socket.off('binStateUpdate');
    };
  }, []);

  const totalDeployments = logs.filter(log => log.command === 'OPEN').length;

  const sendCommand = async (command) => {
    if (command === binState || isPublishing) return;
    setIsPublishing(true);
    try {
      await fetch('http://localhost:3001/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch (error) {
      console.error('Failed to send command', error);
      setIsPublishing(false);
    }
  };

  const clearLogs = async () => {
    setLogs([]);
    try {
      await fetch('http://localhost:3001/api/logs', { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to clear logs on server', error);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 p-6 font-sans text-slate-200 selection:bg-emerald-500/30 flex flex-col">

      {/* Header */}
      <header className="flex justify-between items-center mb-6 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <Trash2 className="text-slate-400" size={24} />
          <h1 className="text-xl font-bold tracking-widest uppercase text-slate-100">
            BINBOT <span className="text-slate-500 font-light">Commercial Compliance & Waste Logistics Terminal</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {isConnected ? (
            <span className="flex items-center gap-2 text-xs font-bold tracking-widest text-emerald-400 uppercase">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Network Linked
            </span>
          ) : (
            <span className="flex items-center gap-2 text-xs font-bold tracking-widest text-rose-500 uppercase">
              <span className="h-2 w-2 rounded-full bg-rose-500" /> Offline
            </span>
          )}
          <button className="p-2 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700 transition-colors">
            <Settings size={18} className="text-slate-300" />
          </button>
        </div>
      </header>

      {/* Top Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Animated Visualizer - Increased min-h to 450px for clearance */}
        <div className="lg:col-span-2 bg-slate-800/80 border border-slate-700/80 rounded-2xl p-8 flex flex-col items-center justify-center min-h-[450px] relative overflow-hidden shadow-xl">

          {/* Background glow */}
          <div className={`absolute w-96 h-96 blur-[120px] rounded-full transition-colors duration-1000 ${binState === 'OPEN' ? 'bg-emerald-500/20' : 'bg-transparent'}`} />

          {/* * CONTAINER FIX:
            * pt-[180px] explicitly reserves the ~185px of vertical space 
            * the 192px lid needs to swing upwards at a 105-degree angle.
            * This forces the flexbox to calculate the visual center lower down.
            */}
          <div className="relative z-10 pt-[180px] pb-8">
            <div
              className="relative"
              style={{ width: BIN_W, height: LID_H + BODY_H }}
            >
              {/* Lid */}
              <motion.div
                initial={false}
                animate={{ rotateZ: binState === 'OPEN' ? -105 : 0 }}
                transition={{ type: 'spring', stiffness: 100, damping: 15 }}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: BIN_W,
                  height: LID_H,
                  transformOrigin: 'bottom left',
                  zIndex: 20,
                }}
                className="bg-slate-300 rounded-t-lg border-b-4 border-slate-400"
              />

              {/* Bin Body */}
              <div
                style={{
                  position: 'absolute',
                  top: LID_H,
                  left: 0,
                  width: BIN_W,
                  height: BODY_H,
                }}
                className="bg-slate-700 border-2 border-t-0 border-slate-600 rounded-b-lg flex items-center justify-center overflow-hidden shadow-inner"
              >
                <div className="flex gap-5">
                  <div className="w-2 h-32 bg-slate-800 rounded-full" />
                  <div className="w-2 h-32 bg-slate-800 rounded-full" />
                  <div className="w-2 h-32 bg-slate-800 rounded-full" />
                </div>
              </div>
            </div>
          </div>

          {/* Status label */}
          <div className="text-center z-10">
            <p className="text-sm text-slate-400 uppercase tracking-widest mb-1 font-bold">Live Status</p>
            <h2 className={`text-3xl font-black tracking-tight transition-colors ${binState === 'OPEN' ? 'text-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.4)]' : 'text-slate-300'}`}>
              {binState}
            </h2>
          </div>
        </div>

        {/* Health Panel */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-6 shadow-xl flex flex-col justify-center">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-6 flex items-center gap-2">
            <Activity size={16} /> System Health
          </h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center p-4 bg-slate-900 rounded-xl border border-slate-700/50">
              <span className="text-slate-300 font-medium text-sm">Socket.IO Web UI</span>
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    <span className="text-xs font-bold text-emerald-400 tracking-widest">SYNCED</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-rose-500" />
                    <span className="text-xs font-bold text-rose-500 tracking-widest">OFFLINE</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center p-4 bg-slate-900 rounded-xl border border-slate-700/50">
              <span className="text-slate-300 font-medium text-sm">Adafruit Cloud</span>
              <div className="flex items-center gap-2">
                <Wifi size={14} className="text-slate-400" />
                <span className="text-xs font-bold text-slate-400 tracking-widest">ACTIVE</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1">

        {/* Panel 1: Fill Level */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-6 shadow-xl relative overflow-hidden flex flex-col group">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-auto">Commercial Fill Level</h3>
          <div className="flex items-center gap-8 mt-8">
            <div className="w-16 h-36 border-2 border-slate-700 bg-slate-900 rounded-md relative overflow-hidden">
              <motion.div
                className="absolute bottom-0 w-full bg-slate-500"
                initial={{ height: 0 }}
                animate={{ height: `${fillLevel}%` }}
              />
            </div>
            <div className="flex items-baseline">
              <span className="text-7xl font-black text-slate-100 tracking-tighter">{fillLevel}</span>
              <span className="text-2xl font-bold text-slate-500 ml-1">%</span>
            </div>
          </div>
        </div>

        {/* Panel 2: Logistics Telemetry */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-6 shadow-xl flex flex-col">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-8">Logistics Telemetry</h3>
          <div className="space-y-6 flex-1 mt-2">
            <div className="flex justify-between items-end border-b border-slate-700/50 pb-3">
              <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">Heavy Lid State</span>
              <span className={`text-lg font-black tracking-widest uppercase transition-colors ${binState === 'OPEN' ? 'text-emerald-400' : 'text-slate-300'}`}>
                {binState}
              </span>
            </div>
            <div className="flex justify-between items-end border-b border-slate-700/50 pb-3">
              <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">Total Deployments</span>
              <span className="text-xl font-black text-slate-100">{totalDeployments}</span>
            </div>
            <div className="flex justify-between items-end">
              <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">System Wear Index</span>
              <span className="text-sm font-black tracking-widest text-slate-400 uppercase">Nominal</span>
            </div>
          </div>
        </div>

        {/* Panel 3: Interrogation Hub */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-6 shadow-xl flex flex-col">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase leading-relaxed mb-4">
            Touchless Compliance<br />Interrogation Hub
          </h3>
          <p className="text-[12px] text-slate-300 leading-relaxed mb-6">
            Terminal runs a voice audit pipeline. Speak directly to query status or flush lifecycle metrics below.
          </p>

          <div className="flex items-center gap-4 mb-8">
            <button
              onClick={() => sendCommand(binState === 'OPEN' ? 'CLOSE' : 'OPEN')}
              disabled={isPublishing}
              className="bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 border border-indigo-400/50 transition-colors text-white text-[10px] font-bold tracking-[0.2em] px-4 py-3 rounded-lg uppercase flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(79,70,229,0.3)] disabled:opacity-50"
            >
              <Power size={14} /> Audit Override
            </button>
            <span className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">System Active</span>
          </div>

          <div className="flex justify-between items-center mb-2">
            <h4 className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">Audit Ledger</h4>
            <button
              onClick={clearLogs}
              title="Erase all logs"
              className="text-[10px] flex items-center gap-1 text-slate-400 hover:text-rose-400 transition-colors uppercase tracking-widest"
            >
              <Trash2 size={12} /> Clear
            </button>
          </div>

          {/* Terminal */}
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 h-28 overflow-y-auto font-mono text-[11px] text-slate-400 space-y-2">
            {logs.length === 0 && (
              <div className="text-slate-500">[SYSTEM BOOT] Real-time data pipeline tracking activated...</div>
            )}
            {logs.map((log) => (
              <div key={log.id} className="leading-relaxed">
                <span className="text-slate-500">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                <span className={`ml-2 font-bold ${log.command === 'OPEN' ? 'text-emerald-400' : 'text-slate-300'}`}>
                  CMD_{log.command}
                </span>{' '}logged via MQTT.
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}