/**
 * ==========================================================================
 * ESP32 + DHT11 IoT Environmental Dashboard
 * Modern Vanilla JavaScript with Web Serial API
 * ==========================================================================
 */

// --- Application State ---
let port = null;
let reader = null;
let isReading = false;
let packetCount = 0;
const MAX_HISTORY_ROWS = 10;
const readingsHistory = [];

// --- DOM Elements ---
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const serialWarning = document.getElementById('serialWarning');
const noticeToast = document.getElementById('noticeToast');
const noticeMessage = document.getElementById('noticeMessage');
const noticeClose = document.getElementById('noticeClose');

// Live Sensor Card Elements
const tempValueEl = document.getElementById('tempValue');
const humidityValueEl = document.getElementById('humidityValue');
const tempStatusTextEl = document.getElementById('tempStatusText');
const humidityStatusTextEl = document.getElementById('humidityStatusText');

// Device & Diagnostics Elements
const packetsCountEl = document.getElementById('packetsCount');
const lastUpdateTimestampEl = document.getElementById('lastUpdateTimestamp');
const comfortIndexEl = document.getElementById('comfortIndex');
const lastRawJsonEl = document.getElementById('lastRawJson');
const streamActiveBadgeEl = document.getElementById('streamActiveBadge');

// Table Elements
const readingsTableBody = document.getElementById('readingsTableBody');
const emptyTableRow = document.getElementById('emptyTableRow');
const readingsCounterBadge = document.getElementById('readingsCounterBadge');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

// --- Initialization & Browser Check ---
document.addEventListener('DOMContentLoaded', () => {
  checkWebSerialSupport();
  setupEventListeners();
});

/**
 * Verifies if the browser supports the Web Serial API.
 * Shows a banner and disables connect if unsupported.
 */
function checkWebSerialSupport() {
  if (!('serial' in navigator)) {
    serialWarning.style.display = 'flex';
    connectBtn.disabled = true;
    connectBtn.title = 'Web Serial API is not supported in this browser';
    showNotice('Web Serial API is not supported. Use Google Chrome or Microsoft Edge.', 8000);
  }
}

/**
 * Registers all UI and Serial event listeners.
 */
function setupEventListeners() {
  connectBtn.addEventListener('click', handleConnect);
  disconnectBtn.addEventListener('click', handleDisconnect);
  clearHistoryBtn.addEventListener('click', clearTableHistory);
  noticeClose.addEventListener('click', () => {
    noticeToast.style.display = 'none';
  });

  // Listen for physical USB unplug events
  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (port && event.target === port) {
        showNotice('ESP32 was disconnected from USB.', 4000);
        handleDisconnect();
      }
    });
  }
}

// --- Serial Connection Management ---

/**
 * Requests USB Serial Port and initiates 115200 baud connection.
 */
async function handleConnect() {
  if (!('serial' in navigator)) {
    showNotice('Web Serial API is not supported in your browser.', 5000);
    return;
  }

  try {
    setConnectionState('connecting');

    // Prompt user to select ESP32 COM port
    port = await navigator.serial.requestPort();

    // Open connection at 115200 baud
    await port.open({ baudRate: 115200 });

    setConnectionState('connected');
    showNotice('Connected to ESP32 at 115200 baud.', 3500);

    // Start reading stream
    readSerialData();

  } catch (error) {
    // If the user cancelled the port picker dialog
    if (error.name === 'NotFoundError' || error.name === 'AbortError') {
      setConnectionState('disconnected');
      return;
    }

    console.error('Serial Connection Error:', error);
    let errorMessage = `Failed to connect: ${error.message}`;

    if (error.name === 'NetworkError' || error.message.includes('open')) {
      errorMessage = 'Could not open port. Ensure Arduino Serial Monitor or other apps are closed.';
    }

    showNotice(errorMessage, 6000);
    setConnectionState('disconnected');
    await cleanupPort();
  }
}

/**
 * Disconnects and cleans up serial streams safely.
 */
async function handleDisconnect() {
  setConnectionState('disconnected');
  await cleanupPort();
  showNotice('Disconnected from ESP32.', 3000);
}

/**
 * Safely cancels reader, releases lock, and closes serial port.
 */
async function cleanupPort() {
  isReading = false;

  if (reader) {
    try {
      await reader.cancel();
    } catch (err) {
      console.warn('Reader cancel notice:', err);
    }
    try {
      reader.releaseLock();
    } catch (err) {
      console.warn('Reader releaseLock notice:', err);
    }
    reader = null;
  }

  if (port) {
    try {
      await port.close();
    } catch (err) {
      console.warn('Port close notice:', err);
    }
    port = null;
  }
}

/**
 * Reads incoming serial chunks, decodes UTF-8 lines, and parses JSON.
 */
async function readSerialData() {
  if (!port || !port.readable) return;

  isReading = true;
  const textDecoder = new TextDecoder();
  let lineBuffer = '';

  try {
    reader = port.readable.getReader();

    while (isReading && port.readable) {
      const { value, done } = await reader.read();

      if (done) {
        break; // Reader was cancelled or stream finished
      }

      if (value) {
        // Decode Uint8Array chunk to string
        const chunk = textDecoder.decode(value, { stream: true });
        lineBuffer += chunk;

        // Split by newline to extract complete lines
        const lines = lineBuffer.split(/\r?\n/);
        
        // Keep the incomplete trailing fragment in the buffer
        lineBuffer = lines.pop();

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.length > 0) {
            processIncomingLine(trimmedLine);
          }
        }
      }
    }
  } catch (error) {
    if (isReading) {
      console.error('Serial read loop error:', error);
      showNotice(`Read error: ${error.message}`, 4000);
      handleDisconnect();
    }
  } finally {
    if (reader) {
      try {
        reader.releaseLock();
      } catch (err) {
        // Ignored
      }
      reader = null;
    }
  }
}

/**
 * Processes a single line received from ESP32.
 * Expects JSON format: {"temperature":28.5,"humidity":65}
 */
function processIncomingLine(line) {
  // Update raw payload preview in UI
  lastRawJsonEl.textContent = line;

  try {
    const data = JSON.parse(line);

    // Validate expected properties
    if (data.temperature !== undefined && data.humidity !== undefined) {
      const temp = parseFloat(data.temperature);
      const humidity = parseFloat(data.humidity);

      if (!isNaN(temp) && !isNaN(humidity)) {
        packetCount++;
        handleValidReading(temp, humidity);
      } else {
        console.warn('Received non-numeric sensor data:', data);
      }
    }
  } catch (parseError) {
    // If ESP32 prints boot logs, debug strings, or fragmented JSON, ignore gracefully
    console.debug('Non-JSON serial line ignored:', line);
  }
}

/**
 * Updates all dashboard cards, telemetry stats, and history table.
 */
function handleValidReading(temperature, humidity) {
  const timestamp = new Date();
  const timeString = timestamp.toLocaleTimeString();

  // 1. Update Live Sensor Cards
  tempValueEl.textContent = temperature.toFixed(1);
  tempValueEl.classList.remove('value-placeholder');

  humidityValueEl.textContent = Math.round(humidity);
  humidityValueEl.classList.remove('value-placeholder');

  // Qualitative environment feedback
  const tempStatus = getTemperatureStatus(temperature);
  const humidityStatus = getHumidityStatus(humidity);
  tempStatusTextEl.textContent = tempStatus.text;
  humidityStatusTextEl.textContent = humidityStatus.text;

  // 2. Update Device & Telemetry Details
  packetsCountEl.textContent = packetCount.toLocaleString();
  lastUpdateTimestampEl.textContent = timeString;

  const comfort = calculateComfortIndex(temperature, humidity);
  comfortIndexEl.textContent = comfort;

  streamActiveBadgeEl.textContent = 'Active';
  streamActiveBadgeEl.className = 'pill-badge badge-active';

  // 3. Update Recent Readings Table (Latest 10)
  addReadingToTable({
    id: packetCount,
    time: timeString,
    temp: temperature.toFixed(1),
    humidity: Math.round(humidity),
    status: comfort
  });
}

/**
 * Inserts a new row into the table, keeping only the latest 10.
 */
function addReadingToTable(reading) {
  readingsHistory.unshift(reading);

  // Keep array capped at MAX_HISTORY_ROWS
  if (readingsHistory.length > MAX_HISTORY_ROWS) {
    readingsHistory.pop();
  }

  // Hide empty state row if visible
  if (emptyTableRow) {
    emptyTableRow.style.display = 'none';
  }

  // Create table row
  const row = document.createElement('tr');
  row.className = 'new-row-animation';

  row.innerHTML = `
    <td><strong>#${reading.id}</strong></td>
    <td>${reading.time}</td>
    <td><span style="color: var(--temp-blue); font-weight: 600;">${reading.temp} °C</span></td>
    <td><span style="color: var(--humidity-teal); font-weight: 600;">${reading.humidity} %</span></td>
    <td><span class="badge-reading-status">${escapeHtml(reading.status)}</span></td>
  `;

  // Prepend new row to the table body
  readingsTableBody.insertBefore(row, readingsTableBody.firstChild);

  // Prune table DOM elements exceeding MAX_HISTORY_ROWS (excluding empty row)
  const rows = readingsTableBody.querySelectorAll('tr:not(#emptyTableRow)');
  if (rows.length > MAX_HISTORY_ROWS) {
    for (let i = MAX_HISTORY_ROWS; i < rows.length; i++) {
      rows[i].remove();
    }
  }

  // Update badge counter
  readingsCounterBadge.textContent = `${readingsHistory.length} / ${MAX_HISTORY_ROWS} Recorded`;
}

/**
 * Clears table rows and restores placeholder.
 */
function clearTableHistory() {
  readingsHistory.length = 0;
  readingsTableBody.innerHTML = '';
  
  // Re-append empty state row
  if (emptyTableRow) {
    emptyTableRow.style.display = '';
    readingsTableBody.appendChild(emptyTableRow);
  }
  
  readingsCounterBadge.textContent = `0 / ${MAX_HISTORY_ROWS} Recorded`;
  showNotice('Readings table history cleared.', 2000);
}

// --- Status & UI Helpers ---

/**
 * Updates UI controls and status badges based on connection state.
 */
function setConnectionState(state) {
  statusBadge.className = 'status-badge';

  if (state === 'connected') {
    statusBadge.classList.add('status-connected');
    statusText.textContent = 'Connected (115200)';
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } else if (state === 'connecting') {
    statusBadge.classList.add('status-connecting');
    statusText.textContent = 'Connecting...';
    connectBtn.disabled = true;
    disconnectBtn.disabled = true;
  } else {
    // Disconnected
    statusBadge.classList.add('status-disconnected');
    statusText.textContent = 'Disconnected';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    streamActiveBadgeEl.textContent = 'Idle';
    streamActiveBadgeEl.className = 'pill-badge badge-idle';

    // Reset sensor card statuses
    tempStatusTextEl.textContent = 'Awaiting serial stream';
    humidityStatusTextEl.textContent = 'Awaiting serial stream';
  }
}

/**
 * Returns temperature condition descriptor.
 */
function getTemperatureStatus(temp) {
  if (temp < 18) return { text: 'Cool / Chilly' };
  if (temp <= 26) return { text: 'Optimal Room Temp' };
  if (temp <= 32) return { text: 'Warm' };
  return { text: 'High Temperature' };
}

/**
 * Returns humidity condition descriptor.
 */
function getHumidityStatus(humidity) {
  if (humidity < 30) return { text: 'Dry Air' };
  if (humidity <= 60) return { text: 'Comfortable Level' };
  return { text: 'High Humidity' };
}

/**
 * Computes an environmental comfort rating from Temp and Humidity.
 */
function calculateComfortIndex(temp, humidity) {
  if (temp >= 20 && temp <= 26 && humidity >= 35 && humidity <= 60) {
    return 'Optimal';
  }
  if (humidity > 70) {
    return 'Humid';
  }
  if (humidity < 30) {
    return 'Dry';
  }
  if (temp > 30) {
    return 'Warm';
  }
  if (temp < 18) {
    return 'Cool';
  }
  return 'Normal';
}

/**
 * Displays a toast message bar with auto-dismiss.
 */
let noticeTimeout = null;
function showNotice(message, duration = 4000) {
  noticeMessage.textContent = message;
  noticeToast.style.display = 'flex';

  if (noticeTimeout) {
    clearTimeout(noticeTimeout);
  }

  noticeTimeout = setTimeout(() => {
    noticeToast.style.display = 'none';
  }, duration);
}

/**
 * Escapes HTML characters to prevent XSS.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
