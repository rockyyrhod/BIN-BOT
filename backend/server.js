require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  pingTimeout: 60000,   
  pingInterval: 25000   
});

const eventLogs = [];
let currentBinState = 'CLOSED'; 

// --- SYSTEM HEALTH CONFIGURATION & TRACKING ---
const systemHealth = {
  mqttConnected: false,
  aiPipelineHealthy: true,
  lastAiCheck: new Date().toISOString(),
  uptime: process.uptime()
};

// Helper to notify all connected clients when health updates
const broadcastHealthUpdate = () => {
  systemHealth.uptime = process.uptime();
  io.emit('systemHealthUpdate', systemHealth);
};

const AIO_USERNAME = process.env.AIO_USERNAME;
const AIO_KEY = process.env.AIO_KEY;
const FEED_PATH = `${AIO_USERNAME}/feeds/${process.env.AIO_FEED}`; 
const FILL_FEED_PATH = `${AIO_USERNAME}/feeds/commercial-fill-level`; 
const MQTT_URL = `mqtts://${AIO_USERNAME}:${AIO_KEY}@io.adafruit.com`;

console.log(`Connecting to Adafruit IO...`);
const mqttClient = mqtt.connect(MQTT_URL, { port: 8883, reconnectPeriod: 5000 });

// Handle dynamic MQTT connection state tracking
mqttClient.on('connect', () => {
  console.log('Connected to Adafruit IO MQTT broker');
  systemHealth.mqttConnected = true;
  broadcastHealthUpdate();
  
  mqttClient.subscribe(FEED_PATH);
  mqttClient.subscribe(FILL_FEED_PATH);
});

mqttClient.on('close', () => {
  if (systemHealth.mqttConnected) {
    console.warn('MQTT connection broken.');
    systemHealth.mqttConnected = false;
    broadcastHealthUpdate();
  }
});

mqttClient.on('error', (err) => {
  console.error('MQTT Client Error:', err);
  systemHealth.mqttConnected = false;
  broadcastHealthUpdate();
});

mqttClient.on('message', (topic, message) => {
  if (topic === FEED_PATH) {
    const cmd = message.toString().toUpperCase();
    currentBinState = cmd; 
    
    const logEntry = { id: Date.now(), command: cmd, timestamp: new Date().toISOString() };
    eventLogs.unshift(logEntry);
    if (eventLogs.length > 50) eventLogs.pop(); 

    io.emit('binStateUpdate', { state: cmd, logs: eventLogs });
  }

  if (topic === FILL_FEED_PATH) {
    const rawLevel = parseInt(message.toString(), 10);
    if (!isNaN(rawLevel)) {
      io.emit('fillLevelUpdate', { level: rawLevel });
    }
  }
});

// HIGH-RELIABILITY: Context-Aware AI Pipeline
app.post('/api/assistant', async (req, res) => {
  const { text, currentState, fillLevel } = req.body;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_API_KEY) {
    systemHealth.aiPipelineHealthy = false;
    systemHealth.lastAiCheck = new Date().toISOString();
    broadcastHealthUpdate();
    return res.json({ reply: "AI Error: GROQ_API_KEY missing.", command: null });
  }

  try {
    const payload = {
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are the voice of BinBot, an intelligent commercial waste logistics terminal.
          
          SYSTEM TELEMETRY:
          - Physical Lid State: ${currentState}
          - Current Fill Capacity: ${fillLevel || 0}%
          
          OPERATIONAL DIRECTIVES & INTENT MAPPING:
          1. "OPEN" Intent: Matches words like "open", "buka", "taas", "tapon", "trash", "basura", "buksan". (Also allow phonetic errors like "boca", "tass", "ofen").
             -> CRITICAL SAFETY OVERRIDE: If "Fill Capacity" is 90% or higher, YOU MUST REFUSE TO OPEN. Output command null and reply informing the user that the bin is at maximum capacity and must be emptied first.
          
          2. "CLOSE" Intent: Matches words like "close", "sara", "baba", "shut", "lock", "isara". (Also allow phonetic errors like "sarah", "shutt", "serra").
             -> You may always close the bin regardless of capacity.
             
          3. STATUS / MALFUNCTION: If the user asks about the status, tell them the current Fill Capacity. If the user mentions a malfunction (e.g., "you are stuck", "it's broken"), output command null and reply that maintenance mode has been engaged.
          
          If an intent matches (and is not blocked by safety overrides), output the correct command ("OPEN" or "CLOSE"). 
          
          Respond strictly using this JSON layout:
          {
            "reply": "A brief, natural conversational response (max 12 words) in the user's dialect. If refusing an action, explain why based on telemetry.",
            "command": "OPEN" or "CLOSE" or null
          }`
        },
        {
          role: "user",
          content: text
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.0 
    };

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.error) {
      systemHealth.aiPipelineHealthy = false;
      systemHealth.lastAiCheck = new Date().toISOString();
      broadcastHealthUpdate();
      return res.json({ reply: `Groq API Exception: ${data.error.message}`, command: null });
    }

    const rawContent = data.choices[0].message.content;
    const aiResult = JSON.parse(rawContent);

    // AI pipeline answered successfully
    if (!systemHealth.aiPipelineHealthy) {
      systemHealth.aiPipelineHealthy = true;
      broadcastHealthUpdate();
    }
    systemHealth.lastAiCheck = new Date().toISOString();

    if (aiResult.command) {
      const targetCommand = aiResult.command.toUpperCase().trim();
      mqttClient.publish(FEED_PATH, targetCommand);
    }

    res.json(aiResult);

  } catch (error) {
    console.error("Groq pipeline breakdown:", error);
    systemHealth.aiPipelineHealthy = false;
    systemHealth.lastAiCheck = new Date().toISOString();
    broadcastHealthUpdate();
    res.json({ reply: `Internal Server Error: ${error.message}`, command: null });
  }
});

app.post('/api/command', (req, res) => {
  const { command } = req.body;
  if (!['OPEN', 'CLOSE'].includes(command)) return res.status(400).json({ error: 'Invalid command' });

  mqttClient.publish(FEED_PATH, command, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to publish' });
    res.json({ success: true, command });
  });
});

app.get('/api/logs', (req, res) => res.json(eventLogs));

// NEW: System Status API Route for HTTP monitoring tools
app.get('/api/health', (req, res) => {
  systemHealth.uptime = process.uptime();
  
  // Calculate a strict overall node health score
  const overallHealthy = systemHealth.mqttConnected && systemHealth.aiPipelineHealthy;
  
  res.status(overallHealthy ? 200 : 503).json({
    status: overallHealthy ? 'HEALTHY' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    ...systemHealth
  });
});

app.delete('/api/logs', (req, res) => {
  eventLogs.length = 0; 
  io.emit('binStateUpdate', { state: currentBinState, logs: eventLogs }); 
  res.json({ success: true });
});

io.on('connection', (socket) => {
  systemHealth.uptime = process.uptime();
  socket.emit('initialState', { 
    logs: eventLogs, 
    connection: mqttClient.connected, 
    currentState: currentBinState,
    systemHealth: systemHealth // Seed client with initial health payload
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running securely on port ${PORT}`));