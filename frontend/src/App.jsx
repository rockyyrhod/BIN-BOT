import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { motion } from 'framer-motion';
import { Trash2, Activity, Wifi, Settings, Mic, MicOff } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const socket = io(BACKEND_URL);

const LID_H  = 24;   
const BODY_H = 192;  
const BIN_W  = 192;  

export default function App() {
  const [binState, setBinState] = useState('CLOSED');
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  const [fillLevel, setFillLevel] = useState(0);

  // Voice AI States
  const [isListening, setIsListening] = useState(false);
  const [assistantResponse, setAssistantResponse] = useState('Tap Wake Assistant to begin talking.');

  const recognitionRef = useRef(null);
  const isListeningRef = useRef(false);
  
  // Timer Refs
  const reconnectTimeoutRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const idleTimerRef = useRef(null); // NEW: Controls the 10-second auto-shutoff
  const transcriptBufferRef = useRef('');

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
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('initialState');
      socket.off('binStateUpdate');
      turnOffAssistant(); // Clean up everything on unmount
    };
  }, []);

  const totalDeployments = logs.filter(log => log.command === 'OPEN').length;

  const clearLogs = async () => {
    setLogs([]);
    try {
      await fetch(`${BACKEND_URL}/api/logs`, { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to clear logs on server', error);
    }
  };

  // MASTER KILL SWITCH: Ensures the UI and background timers perfectly sync when stopping
  const turnOffAssistant = (customMessage = 'Tap Wake Assistant to begin talking.') => {
    isListeningRef.current = false;
    setIsListening(false);
    
    // Wipe every single background timer to prevent UI ghosting
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    
    transcriptBufferRef.current = '';
    
    if (recognitionRef.current) recognitionRef.current.stop();
    window.speechSynthesis.cancel();
    
    setAssistantResponse(customMessage);
  };

  const resetIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // Auto-shutoff if no active talking is detected for 10 seconds
    idleTimerRef.current = setTimeout(() => {
      turnOffAssistant('Session timed out. Tap Wake Assistant to talk.');
    }, 10000); 
  };

  const speakAloud = (textToSpeak) => {
    if (!('speechSynthesis' in window)) return;

    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop();
    }

    window.speechSynthesis.cancel(); 
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = 'en-US';

    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.name.includes('Google') || v.name.includes('Natural'));
    if (preferredVoice) utterance.voice = preferredVoice;

    utterance.onend = () => {
      if (isListeningRef.current && recognitionRef.current) {
        try {
          recognitionRef.current.start();
          resetIdleTimer(); // Restart the idle countdown after the bot finishes speaking
        } catch (e) {
          console.error("Microphone restoration error:", e);
        }
      }
    };

    window.speechSynthesis.speak(utterance);
  };

  const toggleVoiceAssistant = () => {
    // If it's already on, clicking the button triggers the clean Master Kill Switch
    if (isListening) {
      turnOffAssistant();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAssistantResponse('Voice infrastructure missing on this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false; 
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListeningRef.current = true;
      setIsListening(true);
      setAssistantResponse('Groq pipeline active. I am listening...');
      resetIdleTimer(); // Start the 10-second timeout clock
    };

    recognition.onerror = (event) => {
      if (event.error === 'network') {
        setAssistantResponse('Network hiccup detected. Re-establishing cloud link...');
      } else if (event.error !== 'no-speech') {
        turnOffAssistant(`Pipeline exception: [${event.error}].`);
      }
    };

    recognition.onend = () => {
      if (isListeningRef.current) {
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isListeningRef.current) {
            try { 
              recognition.start(); 
            } catch (err) {}
          }
        }, 1000);
      }
    };

    recognition.onresult = (event) => {
      const currentResultIndex = event.resultIndex;
      const newSnippet = event.results[currentResultIndex][0].transcript;
      
      // If we caught real words, stop the idle turn-off timer
      if (newSnippet.trim() !== '') {
        resetIdleTimer(); 
        transcriptBufferRef.current += newSnippet + ' ';
        setAssistantResponse(`Hearing: "${transcriptBufferRef.current.trim()}"...`);
      }

      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }

      silenceTimerRef.current = setTimeout(async () => {
        const finalizedThought = transcriptBufferRef.current.trim();
        transcriptBufferRef.current = '';

        // If no words were spoken, gently return to the listening state (but idle timer keeps ticking down)
        if (!finalizedThought) {
          if (isListeningRef.current) {
            setAssistantResponse('Groq pipeline active. I am listening...');
          }
          return;
        }

        setAssistantResponse(`Sending to Brain: "${finalizedThought}"...`);
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current); // Pause idle timer while fetching

        try {
          const response = await fetch(`${BACKEND_URL}/api/assistant`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: finalizedThought, currentState: binState })
          });
          
          const data = await response.json();
          
          setAssistantResponse(data.reply);
          speakAloud(data.reply);

        } catch (err) {
          console.error("API error:", err);
          setAssistantResponse("Failed connecting to AI gateway.");
          resetIdleTimer(); // Resume idle timer if fetch fails
        }
      }, 1500); 
    };

    recognitionRef.current = recognition;
    recognition.start();
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

      {/* Main Framework Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Animated Visualizer */}
        <div className="lg:col-span-2 bg-slate-800/80 border border-slate-700/80 rounded-2xl p-8 flex flex-col items-center justify-center min-h-[450px] relative overflow-hidden shadow-xl">
          <div className={`absolute w-96 h-96 blur-[120px] rounded-full transition-colors duration-1000 ${binState === 'OPEN' ? 'bg-emerald-500/20' : 'bg-transparent'}`} />
          <div className="relative z-10 pt-[180px] pb-8">
            <div className="relative" style={{ width: BIN_W, height: LID_H + BODY_H }}>
              <motion.div
                initial={false}
                animate={{ rotateZ: binState === 'OPEN' ? -105 : 0 }}
                transition={{ type: 'spring', stiffness: 100, damping: 15 }}
                style={{ position: 'absolute', top: 0, left: 0, width: BIN_W, height: LID_H, transformOrigin: 'bottom left', zIndex: 20 }}
                className="bg-slate-300 rounded-t-lg border-b-4 border-slate-400"
              />
              <div style={{ position: 'absolute', top: LID_H, left: 0, width: BIN_W, height: BODY_H }} className="bg-slate-700 border-2 border-t-0 border-slate-600 rounded-b-lg flex items-center justify-center overflow-hidden shadow-inner">
                <div className="flex gap-5">
                  <div className="w-2 h-32 bg-slate-800 rounded-full" />
                  <div className="w-2 h-32 bg-slate-800 rounded-full" />
                  <div className="w-2 h-32 bg-slate-800 rounded-full" />
                </div>
              </div>
            </div>
          </div>
          <div className="text-center z-10">
            <p className="text-sm text-slate-400 uppercase tracking-widest mb-1 font-bold">Live Status</p>
            <h2 className={`text-3xl font-black tracking-tight transition-colors ${binState === 'OPEN' ? 'text-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.4)]' : 'text-slate-300'}`}>
              {binState}
            </h2>
          </div>
        </div>

        {/* Health */}
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
                    <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" /></span>
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

      {/* Bottom Grid Layout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1">
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-6 shadow-xl relative overflow-hidden flex flex-col group">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-auto">Commercial Fill Level</h3>
          <div className="flex items-center gap-8 mt-8">
            <div className="w-16 h-36 border-2 border-slate-700 bg-slate-900 rounded-md relative overflow-hidden">
              <motion.div className="absolute bottom-0 w-full bg-slate-500" initial={{ height: 0 }} animate={{ height: `${fillLevel}%` }} />
            </div>
            <div className="flex items-baseline">
              <span className="text-7xl font-black text-slate-100 tracking-tighter">{fillLevel}</span>
              <span className="text-2xl font-bold text-slate-500 ml-1">%</span>
            </div>
          </div>
        </div>

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
          </div>
        </div>

        {/* Groq Assistant Interface card */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-6 shadow-xl flex flex-col justify-between min-h-[350px]">
          <div>
            <div className="flex justify-between items-start mb-2">
              <h3 className="text-[11px] font-bold tracking-[0.15em] text-indigo-400 uppercase">Google Assistant Pipeline</h3>
              <div className="flex items-center gap-1 bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800 text-[9px] font-mono text-slate-400 tracking-wider">
                <span className={`h-1 w-1 rounded-full ${isListening ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                {isListening ? 'LISTENING' : 'STANDBY'}
              </div>
            </div>
            <p className="text-[12px] text-indigo-200 font-medium bg-indigo-950/30 border border-indigo-900/40 px-3 py-2 rounded-xl mb-3 min-h-[36px] flex items-center shadow-inner">
              {assistantResponse}
            </p>
          </div>

          <div className="bg-slate-900/60 border border-slate-700/50 rounded-2xl p-4 flex flex-col items-center justify-center my-2 shadow-inner relative overflow-hidden">
            <div className={`absolute inset-0 opacity-10 blur-xl transition-all duration-1000 ${isListening ? 'bg-gradient-to-r from-blue-500 via-red-500 to-yellow-500' : 'bg-transparent'}`} />
            <div className="flex items-center justify-center gap-2 h-8 mb-4 relative z-10">
              {[ 'bg-blue-500', 'bg-red-500', 'bg-yellow-500', 'bg-emerald-500' ].map((color, i) => (
                <motion.div
                  key={i}
                  className={`w-2.5 h-2.5 rounded-full ${color}`}
                  animate={isListening ? { y: [0, -14, 0], scale: [1, 1.2, 1] } : { y: 0, scale: 1 }}
                  transition={{ duration: 0.6, repeat: Infinity, repeatType: "loop", delay: i * 0.15, ease: "easeInOut" }}
                />
              ))}
            </div>

            <button
              onClick={toggleVoiceAssistant}
              className={`w-full max-w-[200px] py-2.5 rounded-full border flex items-center justify-center gap-2.5 font-bold text-[11px] tracking-[0.15em] uppercase transition-all shadow-md active:scale-98 relative z-10
                ${isListening ? 'bg-rose-500/10 border-rose-500/40 text-rose-400 hover:bg-rose-500/20' : 'bg-slate-800 border-slate-600 text-slate-200 hover:border-indigo-500/50 hover:text-indigo-400 shadow-black/40'}`}
            >
              {isListening ? <><MicOff size={14} className="animate-pulse" /> Stop Assistant</> : <><Mic size={14} className="text-indigo-400" /> Wake Assistant</>}
            </button>
          </div>

          <div className="flex flex-col mt-2 flex-1 justify-end">
            <div className="flex justify-between items-center mb-1.5 px-1">
              <h4 className="text-[10px] font-bold tracking-[0.15em] text-slate-500 uppercase">Audit Ledger Feed</h4>
              <button onClick={clearLogs} className="text-[10px] flex items-center gap-1 text-slate-500 hover:text-rose-400 transition-colors uppercase tracking-widest font-semibold"><Trash2 size={11} /> Flush</button>
            </div>
            <div className="bg-slate-950/80 border border-slate-800/60 rounded-xl p-3 h-28 overflow-y-auto text-[11px] text-slate-400 space-y-2 custom-scrollbar">
              {logs.length === 0 && <div className="text-slate-600 flex items-center gap-2 italic"><span className="h-1 w-1 rounded-full bg-slate-600" />[SYSTEM RETRIEVAL] Ready for voice interaction...</div>}
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-slate-600 font-mono text-[10px] pt-0.5">[{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                  <div className="flex-1">Voice AI parsed statement <span className={`mx-1 px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tracking-wide ${log.command === 'OPEN' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>{log.command}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}