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
let currentBinState = 'CLOSED'; // <-- NEW: Tracks the physical state independent of logs

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
    console.log(`Received from hardware: ${cmd}`);
    
    const logEntry = { id: Date.now(), command: cmd, timestamp: new Date().toISOString() };
    eventLogs.unshift(logEntry);
    if (eventLogs.length > 50) eventLogs.pop(); // Keep last 50

    io.emit('binStateUpdate', { state: cmd, logs: eventLogs });
  }
});

app.post('/api/command', (req, res) => {
  const { command } = req.body;
  if (!['OPEN', 'CLOSE'].includes(command)) {
    return res.status(400).json({ error: 'Invalid command' });
  }

  mqttClient.publish(FEED_PATH, command, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to publish' });
    res.json({ success: true, command });
  });
});

app.get('/api/logs', (req, res) => {
  res.json(eventLogs);
});

// Endpoint to clear the logs
app.delete('/api/logs', (req, res) => {
  console.log("⚠️ DELETE COMMAND RECEIVED: Wiping all logs...");
  eventLogs.length = 0; 
  // THE FIX: Send the actual current state back to the UI
  io.emit('binStateUpdate', { state: currentBinState, logs: eventLogs }); 
  res.json({ success: true });
});

io.on('connection', (socket) => {
  console.log('Frontend client connected');
  // THE FIX: Add currentState to the initial payload
  socket.emit('initialState', { 
    logs: eventLogs, 
    connection: mqttClient.connected, 
    currentState: currentBinState 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));