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
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] }
});

const eventLogs = [];
let currentBinState = 'CLOSED'; 

// Adafruit IO Cloud Configurations
const AIO_USERNAME = process.env.AIO_USERNAME;
const AIO_KEY = process.env.AIO_KEY;
const FEED_PATH = `${AIO_USERNAME}/feeds/${process.env.AIO_FEED}`;
const MQTT_URL = `mqtts://${AIO_USERNAME}:${AIO_KEY}@io.adafruit.com`;

console.log(`Connecting to Adafruit IO...`);
const mqttClient = mqtt.connect(MQTT_URL, { port: 8883 });

mqttClient.on('connect', () => {
  console.log('Connected to Adafruit IO MQTT broker');
  mqttClient.subscribe(FEED_PATH);
});

mqttClient.on('message', (topic, message) => {
  if (topic === FEED_PATH) {
    const cmd = message.toString().toUpperCase();
    currentBinState = cmd; 
    
    const logEntry = { id: Date.now(), command: cmd, timestamp: new Date().toISOString() };
    eventLogs.unshift(logEntry);
    if (eventLogs.length > 50) eventLogs.pop(); // Keep log array memory clean

    io.emit('binStateUpdate', { state: cmd, logs: eventLogs });
  }
});

// HIGH-RELIABILITY: High-Speed Groq AI Voice Processing Pipeline
app.post('/api/assistant', async (req, res) => {
  const { text } = req.body;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_API_KEY) {
    return res.json({ 
      reply: "AI Error: GROQ_API_KEY environment variable is missing on the server.", 
      command: null 
    });
  }

  try {
    const payload = {
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are the voice of BinBot, an intelligent commercial waste logistics terminal operating in a bilingual English/Tagalog (Filipino) environment.
          
          Your primary job is to interpret user intent from raw speech transcripts. Because users speak with local accents, the speech-to-text engine frequently makes phonetic spelling errors. You must look past these errors to find the real intent.
          
          STRICT INTENT MAPPING MATRIX:
          1. "OPEN" Intent: Matches "open", "buka", "taas", "tapon", "trash", "basura", "buksan", "itapon" AND common phonetic errors like "boca", "booker", "tass", "toss", "upen", "ofen".
          2. "CLOSE" Intent: Matches "close", "sara", "baba", "shut", "lock", "seal", "isara", "sarado" AND common phonetic errors like "sarah", "shutt", "cloze", "shat", "serra".
          
          If the transcript contains any words matching or sounding like the intents above, output the command ("OPEN" or "CLOSE"). 
          Only output null if the transcript is completely unrelated background noise or casual conversation.
          
          Respond strictly using this JSON layout:
          {
            "reply": "A very brief, ultra-natural confirmation (max 8 words) matching the dialect used by the user.",
            "command": "OPEN" or "CLOSE" or null
          }`
        },
        {
          role: "user",
          content: text
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.0 // Zero variance keeps the matching razor-sharp and predictable
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
      return res.json({ 
        reply: `Groq API Exception: ${data.error.message}`, 
        command: null 
      });
    }

    const rawContent = data.choices[0].message.content;
    const aiResult = JSON.parse(rawContent);

    // FIXED SELF-HEALING PULSE: Always push the raw command over MQTT if an intent is found.
    // This bypasses local software state check caching completely to fix hardware state desyncs.
    if (aiResult.command) {
      const targetCommand = aiResult.command.toUpperCase().trim();
      mqttClient.publish(FEED_PATH, targetCommand);
    }

    res.json(aiResult);

  } catch (error) {
    console.error("Groq pipeline breakdown:", error);
    res.json({ 
      reply: `Internal Server Error: ${error.message}`, 
      command: null 
    });
  }
});

// Standard REST Endpoint Manual Override
app.post('/api/command', (req, res) => {
  const { command } = req.body;
  if (!['OPEN', 'CLOSE'].includes(command)) return res.status(400).json({ error: 'Invalid command' });

  mqttClient.publish(FEED_PATH, command, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to publish' });
    res.json({ success: true, command });
  });
});

// Endpoint to fetch real-time lifecycle metrics
app.get('/api/logs', (req, res) => res.json(eventLogs));

// Endpoint to flush the transaction table
app.delete('/api/logs', (req, res) => {
  eventLogs.length = 0; 
  io.emit('binStateUpdate', { state: currentBinState, logs: eventLogs }); 
  res.json({ success: true });
});

// Real-time bidirectional UI syncing socket handshake
io.on('connection', (socket) => {
  socket.emit('initialState', { 
    logs: eventLogs, 
    connection: mqttClient.connected, 
    currentState: currentBinState 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running securely on port ${PORT}`));