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
  const [isListening, setIsListening] = useState(false);
  const [assistantResponse, setAssistantResponse] = useState('Tap Wake Assistant to begin talking.');

  // STALE STATE FIX: Live References for the background microphone listener
  const binStateRef = useRef(binState);
  const fillLevelRef = useRef(fillLevel);

  // Sync the live references every time the real state changes
  useEffect(() => { binStateRef.current = binState; }, [binState]);
  useEffect(() => { fillLevelRef.current = fillLevel; }, [fillLevel]);

  const recognitionRef = useRef(null);
  const isListeningRef = useRef(false);
  const reconnectTimeoutRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const idleTimerRef = useRef(null); 
  const transcriptBufferRef = useRef('');

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('initialState', (data) => {
      setLogs(data.logs);
      if (data.logs.length > 0) setBinState(data.logs[0].command);
      else if (data.currentState) setBinState(data.currentState);
      if (data.currentFillLevel !== undefined) setFillLevel(data.currentFillLevel);
    });

    socket.on('binStateUpdate', (data) => {
      setBinState(data.state);
      setLogs(data.logs);
    });

    socket.on('fillLevelUpdate', (data) => {
      const clampedLevel = Math.max(0, Math.min(100, data.level));
      setFillLevel(clampedLevel);
    });

    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('initialState');
      socket.off('binStateUpdate');
      socket.off('fillLevelUpdate');
      turnOffAssistant(); 
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

  const turnOffAssistant = (customMessage = 'Tap Wake Assistant to begin talking.') => {
    isListeningRef.current = false;
    setIsListening(false);
    
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
    utterance.rate = 0.95; 
    utterance.pitch = 1.0; 

    const voices = window.speechSynthesis.getVoices();
    const usVoices = voices.filter(v => v.lang === 'en-US' || v.lang === 'en_US');

    let preferredVoice = 
      usVoices.find(v => v.name.includes('Google US English')) ||
      usVoices.find(v => v.name.includes('Samantha')) ||
      usVoices.find(v => v.name.includes('Alex')) ||
      usVoices.find(v => v.name.includes('Siri')) ||
      usVoices.find(v => v.name.includes('Zira')) ||
      usVoices.find(v => v.name.includes('David')) ||
      usVoices.find(v => v.name.includes('Natural')) ||
      usVoices[0] ||
      voices.find(v => v.lang.startsWith('en')) ||
      voices[0];

    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utterance.onend = () => {
      if (isListeningRef.current && recognitionRef.current) {
        try {
          recognitionRef.current.start();
          resetIdleTimer(); 
        } catch (e) {
          console.error("Microphone restoration error:", e);
        }
      }
    };

    window.speechSynthesis.speak(utterance);
  };

  const toggleVoiceAssistant = () => {
    if ('speechSynthesis' in window) {
      const silentAudio = new SpeechSynthesisUtterance('');
      silentAudio.volume = 0;
      window.speechSynthesis.speak(silentAudio);
    }

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
      resetIdleTimer(); 
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
            try { recognition.start(); } catch (err) {}
          }
        }, 1000);
      }
    };

    recognition.onresult = (event) => {
      const currentResultIndex = event.resultIndex;
      const newSnippet = event.results[currentResultIndex][0].transcript;
      
      if (newSnippet.trim() !== '') {
        resetIdleTimer(); 
        transcriptBufferRef.current += newSnippet + ' ';
        setAssistantResponse(`Hearing: "${transcriptBufferRef.current.trim()}"...`);
      }

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

      silenceTimerRef.current = setTimeout(async () => {
        const finalizedThought = transcriptBufferRef.current.trim();
        transcriptBufferRef.current = '';

        if (!finalizedThought) {
          if (isListeningRef.current) setAssistantResponse('Groq pipeline active. I am listening...');
          return;
        }

        setAssistantResponse(`Sending to Brain: "${finalizedThought}"...`);
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current); 

        try {
          const response = await fetch(`${BACKEND_URL}/api/assistant`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // STALE STATE FIX: Always fetch the absolute newest state from the Live Refs!
            body: JSON.stringify({ 
              text: finalizedThought, 
              currentState: binStateRef.current, 
              fillLevel: fillLevelRef.current 
            })
          });
          
          const data = await response.json();
          setAssistantResponse(data.reply);
          speakAloud(data.reply);

        } catch (err) {
          console.error("API error:", err);
          setAssistantResponse("Failed connecting to AI gateway.");
          resetIdleTimer(); 
        }
      }, 800); 
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const getFillColor = () => {
    if (fillLevel >= 85) return 'bg-rose-500';
    if (fillLevel >= 60) return 'bg-yellow-500';
    return 'bg-emerald-500';
  };

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-6 font-sans text-slate-200 selection:bg-emerald-500/30 flex flex-col overflow-x-hidden">

      {/* Header */}
      <header className="flex justify-between items-center mb-6 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2 md:gap-3">
          <Trash2 className="text-slate-400" size={20} />
          <h1 className="text-sm md:text-xl font-bold tracking-widest uppercase text-slate-100 flex flex-col md:flex-row md:items-baseline">
            BINBOT <span className="text-slate-500 font-light text-[9px] md:text-sm mt-1 md:mt-0 md:ml-2">Commercial Compliance and Waste Logistices Terminal</span>
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {isConnected ? (
            <span className="flex items-center gap-1 md:gap-2 text-[10px] md:text-xs font-bold tracking-widest text-emerald-400 uppercase">
              <span className="h-1.5 w-1.5 md:h-2 md:w-2 rounded-full bg-emerald-400 animate-pulse" /> Linked
            </span>
          ) : (
            <span className="flex items-center gap-1 md:gap-2 text-[10px] md:text-xs font-bold tracking-widest text-rose-500 uppercase">
              <span className="h-1.5 w-1.5 md:h-2 md:w-2 rounded-full bg-rose-500" /> Offline
            </span>
          )}
        </div>
      </header>

      {/* Main Framework Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        
        {/* Animated Visualizer */}
        <div className="lg:col-span-2 bg-slate-800/80 border border-slate-700/80 rounded-2xl p-4 md:p-8 flex flex-col items-center justify-center min-h-[300px] lg:min-h-[450px] relative overflow-hidden shadow-xl">
          <div className={`absolute w-64 md:w-96 h-64 md:h-96 blur-[100px] rounded-full transition-colors duration-1000 ${binState === 'OPEN' ? 'bg-emerald-500/20' : 'bg-transparent'}`} />
          
          <div className="relative z-10 pt-24 md:pt-[180px] pb-8 scale-75 md:scale-100 transition-transform origin-bottom">
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
          
          <div className="text-center z-10 mt-auto">
            <p className="text-[11px] md:text-sm text-slate-400 uppercase tracking-widest mb-1 font-bold">Live Status</p>
            <h2 className={`text-2xl md:text-3xl font-black tracking-tight transition-colors ${binState === 'OPEN' ? 'text-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.4)]' : 'text-slate-300'}`}>
              {binState}
            </h2>
          </div>
        </div>

        {/* Health */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-5 md:p-6 shadow-xl flex flex-col justify-center">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-4 md:mb-6 flex items-center gap-2">
            <Activity size={16} /> System Health
          </h3>
          <div className="space-y-3 md:space-y-4">
            <div className="flex justify-between items-center p-3 md:p-4 bg-slate-900 rounded-xl border border-slate-700/50">
              <span className="text-slate-300 font-medium text-xs md:text-sm">Socket.IO Core</span>
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <>
                    <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" /></span>
                    <span className="text-[10px] md:text-xs font-bold text-emerald-400 tracking-widest">SYNCED</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-rose-500" />
                    <span className="text-[10px] md:text-xs font-bold text-rose-500 tracking-widest">OFFLINE</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center p-3 md:p-4 bg-slate-900 rounded-xl border border-slate-700/50">
              <span className="text-slate-300 font-medium text-xs md:text-sm">Adafruit Broker</span>
              <div className="flex items-center gap-2">
                <Wifi size={14} className="text-slate-400" />
                <span className="text-[10px] md:text-xs font-bold text-slate-400 tracking-widest">ACTIVE</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Grid Layout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1">
        
        {/* Fill Level */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-5 md:p-6 shadow-xl relative overflow-hidden flex flex-col group min-h-[180px]">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-auto">Commercial Fill Level</h3>
          <div className="flex items-center justify-between md:justify-start gap-8 mt-4 md:mt-8">
            <div className="w-16 h-28 md:h-36 border-2 border-slate-700 bg-slate-900 rounded-md relative overflow-hidden shrink-0">
              <motion.div 
                className={`absolute bottom-0 w-full transition-colors duration-700 ${getFillColor()}`} 
                initial={{ height: 0 }} 
                animate={{ height: `${fillLevel}%` }} 
              />
            </div>
            <div className="flex items-baseline">
              <span className="text-6xl md:text-7xl font-black text-slate-100 tracking-tighter">{fillLevel}</span>
              <span className="text-xl md:text-2xl font-bold text-slate-500 ml-1">%</span>
            </div>
          </div>
        </div>

        {/* Telemetry */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-5 md:p-6 shadow-xl flex flex-col min-h-[180px]">
          <h3 className="text-[11px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-6 md:mb-8">Logistics Telemetry</h3>
          <div className="space-y-4 md:space-y-6 flex-1 mt-auto md:mt-2">
            <div className="flex justify-between items-end border-b border-slate-700/50 pb-2 md:pb-3">
              <span className="text-[10px] md:text-xs font-semibold tracking-widest text-slate-400 uppercase">Heavy Lid State</span>
              <span className={`text-base md:text-lg font-black tracking-widest uppercase transition-colors ${binState === 'OPEN' ? 'text-emerald-400' : 'text-slate-300'}`}>
                {binState}
              </span>
            </div>
            <div className="flex justify-between items-end border-b border-slate-700/50 pb-2 md:pb-3">
              <span className="text-[10px] md:text-xs font-semibold tracking-widest text-slate-400 uppercase">Deployments</span>
              <span className="text-lg md:text-xl font-black text-slate-100">{totalDeployments}</span>
            </div>
          </div>
        </div>

        {/* Groq Assistant Interface card */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-5 md:p-6 shadow-xl flex flex-col justify-between min-h-[350px]">
          <div>
            <div className="flex justify-between items-center md:items-start mb-3 md:mb-2">
              <h3 className="text-[11px] font-bold tracking-[0.15em] text-indigo-400 uppercase">Google Assistant</h3>
              <div className="flex items-center gap-1.5 bg-slate-900/80 px-2 py-1 md:py-0.5 rounded border border-slate-800 text-[9px] font-mono text-slate-400 tracking-wider">
                <span className={`h-1.5 w-1.5 md:h-1 md:w-1 rounded-full ${isListening ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                {isListening ? 'LISTENING' : 'STANDBY'}
              </div>
            </div>
            <p className="text-xs md:text-[12px] text-indigo-200 font-medium bg-indigo-950/30 border border-indigo-900/40 px-4 md:px-3 py-3 md:py-2 rounded-xl mb-4 md:mb-3 min-h-[44px] md:min-h-[36px] flex items-center shadow-inner">
              {assistantResponse}
            </p>
          </div>

          <div className="bg-slate-900/60 border border-slate-700/50 rounded-2xl p-5 md:p-4 flex flex-col items-center justify-center my-2 shadow-inner relative overflow-hidden">
            <div className={`absolute inset-0 opacity-10 blur-xl transition-all duration-1000 ${isListening ? 'bg-gradient-to-r from-blue-500 via-red-500 to-yellow-500' : 'bg-transparent'}`} />
            <div className="flex items-center justify-center gap-2 h-8 mb-5 md:mb-4 relative z-10">
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
              className={`w-full max-w-[220px] min-h-[48px] rounded-full border flex items-center justify-center gap-2.5 font-bold text-xs md:text-[11px] tracking-[0.15em] uppercase transition-all shadow-md active:scale-95 relative z-10
                ${isListening ? 'bg-rose-500/10 border-rose-500/40 text-rose-400 hover:bg-rose-500/20' : 'bg-slate-800 border-slate-600 text-slate-200 hover:border-indigo-500/50 hover:text-indigo-400 shadow-black/40'}`}
            >
              {isListening ? <><MicOff size={16} className="animate-pulse" /> Stop Assistant</> : <><Mic size={16} className="text-indigo-400" /> Wake Assistant</>}
            </button>
          </div>

          <div className="flex flex-col mt-4 md:mt-2 flex-1 justify-end">
            <div className="flex justify-between items-center mb-2 md:mb-1.5 px-1">
              <h4 className="text-[10px] font-bold tracking-[0.15em] text-slate-500 uppercase">Audit Ledger</h4>
              <button onClick={clearLogs} className="text-[10px] flex items-center gap-1 text-slate-500 hover:text-rose-400 transition-colors uppercase tracking-widest font-semibold p-1 md:p-0"><Trash2 size={12} md:size={11} /> Flush</button>
            </div>
            <div className="bg-slate-950/80 border border-slate-800/60 rounded-xl p-3 h-32 md:h-28 overflow-y-auto text-[11px] text-slate-400 space-y-2 custom-scrollbar shadow-inner">
              {logs.length === 0 && <div className="text-slate-600 flex items-center gap-2 italic"><span className="h-1 w-1 rounded-full bg-slate-600" />[SYSTEM RETRIEVAL] Ready...</div>}
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-slate-600 font-mono text-[9px] md:text-[10px] pt-0.5">[{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                  <div className="flex-1">AI parsed intent <span className={`mx-1 px-1.5 py-0.5 rounded text-[9px] md:text-[10px] font-bold font-mono tracking-wide ${log.command === 'OPEN' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>{log.command}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}