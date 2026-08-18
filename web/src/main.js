import { ESPLoader, Transport, ClassicReset } from "esptool-js";
import boards from "./boards.json";

const els = {
  serialNotice: document.getElementById("serial-support-notice"),
  baudRate: document.getElementById("baud-rate"),
  connectBtn: document.getElementById("connect-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  connectionStatus: document.getElementById("connection-status"),
  firmwareSelect: document.getElementById("firmware-select"),
  refreshFirmwareBtn: document.getElementById("refresh-firmware-btn"),
  boardSelect: document.getElementById("board-select"),
  eraseFlashCheckbox: document.getElementById("erase-flash-checkbox"),
  flashBtn: document.getElementById("flash-btn"),
  autoMonitorCheckbox: document.getElementById("auto-monitor-checkbox"),
  flashProgress: document.getElementById("flash-progress"),
  monitorBaudRate: document.getElementById("monitor-baud-rate"),
  monitorBtn: document.getElementById("monitor-btn"),
  monitorDisconnectBtn: document.getElementById("monitor-disconnect-btn"),
  monitorAutoReconnectCheckbox: document.getElementById("monitor-auto-reconnect-checkbox"),
  monitorStatus: document.getElementById("monitor-status"),
  deviceResetBtn: document.getElementById("device-reset-btn"),
  logClearBtn: document.getElementById("log-clear-btn"),
  logOutput: document.getElementById("log-output"),
};

/**
 * @type {{
 *   port: SerialPort | null,
 *   transport: Transport | null,
 *   esploader: ESPLoader | null,
 *   monitorActive: boolean,
 *   monitorReader: ReadableStreamDefaultReader | null,
 *   monitorDesired: boolean,
 *   monitorBaudRate: number | null,
 *   lastMonitorPort: SerialPort | null,
 *   lastMonitorPortInfo: SerialPortInfo | null,
 *   monitorReconnectTimer: ReturnType<typeof setTimeout> | null,
 *   monitorReconnectInProgress: boolean,
 * }}
 */
const state = {
  port: null,
  transport: null,
  esploader: null,
  monitorActive: false,
  monitorReader: null,
  monitorDesired: false,
  monitorBaudRate: null,
  lastMonitorPort: null,
  lastMonitorPortInfo: null,
  monitorReconnectTimer: null,
  monitorReconnectInProgress: false,
};

const MONITOR_RECONNECT_DELAY_MS = 500;

// Ports we've already attached a "disconnect" listener to, so re-opening the
// same port for flashing / monitoring doesn't stack duplicate listeners.
const portsWithDisconnectListener = new WeakSet();

function selectedBoard() {
  const option = els.boardSelect.selectedOptions[0];
  return { chip: option.dataset.chip, flashSize: option.dataset.flashSize };
}

function populateBoardSelect() {
  els.boardSelect.innerHTML = "";
  for (const board of boards) {
    const option = document.createElement("option");
    option.value = board.value;
    option.dataset.chip = board.chip;
    option.dataset.flashSize = board.flashSize;
    option.textContent = board.label;
    els.boardSelect.appendChild(option);
  }
}

const FIRMWARE_NAME_PATTERN = /-0x([0-9a-fA-F]+)-(\d+)bytes\.bin$/i;

/**
 * Parse the flash start address and max byte count encoded at the end of a
 * firmware filename, e.g. "...-0x10000-6553600bytes.bin" -> address 0x10000,
 * maxBytes 6553600. Returns null for filenames without this suffix.
 */
function parseFirmwareName(name) {
  const match = name.match(FIRMWARE_NAME_PATTERN);
  if (!match) return null;
  return { address: parseInt(match[1], 16), maxBytes: parseInt(match[2], 10) };
}

function log(message) {
  els.logOutput.textContent += `${message}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

const terminal = {
  clean() {
    els.logOutput.textContent = "";
  },
  writeLine(data) {
    log(data);
  },
  write(data) {
    els.logOutput.textContent += data;
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
  },
};

function setConnected(connected) {
  els.connectBtn.disabled = connected || state.monitorActive || state.monitorDesired;
  els.disconnectBtn.disabled = !connected;
  els.baudRate.disabled = connected;
  els.connectionStatus.textContent = connected ? "接続済み" : "未接続";
  updateFlashButtonState();
}

function setMonitorConnected(connected, status = connected ? "接続済み" : "未接続") {
  state.monitorActive = connected;
  els.monitorBtn.disabled = connected || state.monitorDesired || !!state.esploader;
  els.monitorDisconnectBtn.disabled = !connected && !state.monitorDesired;
  els.monitorBaudRate.disabled = connected || state.monitorDesired;
  els.monitorStatus.textContent = status;
  els.connectBtn.disabled = connected || state.monitorDesired || !!state.esploader;
  els.deviceResetBtn.disabled = !connected;
}

/** Pulse the EN line via the already-open monitor port to reset the device without entering bootloader mode. */
async function resetDevice() {
  if (!state.monitorActive || !state.port) return;

  els.deviceResetBtn.disabled = true;
  try {
    log("Resetting device...");
    const transport = new Transport(state.port);
    await new ClassicReset(transport, 100).reset();
    log("Device reset.");
  } catch (err) {
    log(`Device reset failed: ${err.message}`);
  } finally {
    els.deviceResetBtn.disabled = !state.monitorActive;
  }
}

function attachDisconnectListener(port) {
  if (portsWithDisconnectListener.has(port)) return;
  portsWithDisconnectListener.add(port);
  port.addEventListener("disconnect", () => {
    log("Device disconnected.");
    if (state.monitorDesired && (state.port === port || state.lastMonitorPort === port)) {
      handleUnexpectedMonitorDisconnect(port);
    } else if (state.port === port) {
      resetConnectionState();
    }
  });
}

function updateFlashButtonState() {
  els.flashBtn.disabled = !state.esploader || !els.firmwareSelect.value;
}

async function syncAndReloadFirmwareList() {
  els.refreshFirmwareBtn.disabled = true;
  try {
    log("Syncing firmware from ~/MyGit...");
    const res = await fetch("/api/firmware/sync", { method: "POST" });
    const body = await res.json();
    if (body.stdout) log(body.stdout.trim());
    if (body.stderr) log(body.stderr.trim());
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    log("Sync complete.");
  } catch (err) {
    log(`Firmware sync failed: ${err.message}`);
  } finally {
    els.refreshFirmwareBtn.disabled = false;
  }
  await loadFirmwareList();
}

async function loadFirmwareList() {
  els.firmwareSelect.innerHTML = '<option value="">読み込み中...</option>';
  try {
    const res = await fetch("/api/firmware");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const firmwares = await res.json();

    if (firmwares.length === 0) {
      els.firmwareSelect.innerHTML = '<option value="">firmware/ にファイルがありません</option>';
      updateFlashButtonState();
      return;
    }

    els.firmwareSelect.innerHTML = "";
    for (const fw of firmwares) {
      const option = document.createElement("option");
      option.value = fw.name;
      const sizeKb = (fw.size / 1024).toFixed(1);
      const parsed = parseFirmwareName(fw.name);
      const addressLabel = parsed ? ` @ 0x${parsed.address.toString(16)}` : "";
      option.textContent = `${fw.name} (${sizeKb} KB)${addressLabel}`;
      els.firmwareSelect.appendChild(option);
    }
    updateFlashButtonState();
  } catch (err) {
    els.firmwareSelect.innerHTML = '<option value="">読み込み失敗</option>';
    log(`Failed to load firmware list: ${err.message}`);
  }
}

async function connect() {
  if (!("serial" in navigator) || state.monitorActive) return;

  try {
    const port = await navigator.serial.requestPort();
    const transport = new Transport(port, true);
    const baudrate = Number(els.baudRate.value);

    const esploader = new ESPLoader({ transport, baudrate, terminal });

    const chipDescription = await esploader.main();
    log(`Connected: ${chipDescription}`);

    const detectedChip = esploader.chip.CHIP_NAME;
    const board = selectedBoard();

    if (detectedChip !== board.chip) {
      const proceed = confirm(
        `選択したボード (${els.boardSelect.selectedOptions[0].textContent.trim()}, ${board.chip}) と` +
          `検出されたチップ (${detectedChip}) が一致しません。\n` +
          "このまま書き込みを続行しますか？",
      );
      if (!proceed) {
        await transport.disconnect();
        return;
      }
    }

    state.port = port;
    state.transport = transport;
    state.esploader = esploader;

    attachDisconnectListener(port);

    setConnected(true);
  } catch (err) {
    log(`Connect failed: ${err.message}`);
  }
}

function resetConnectionState() {
  state.port = null;
  state.transport = null;
  state.esploader = null;
  setConnected(false);
  if (state.monitorActive) {
    state.monitorReader = null;
    state.monitorDesired = false;
    setMonitorConnected(false);
  }
}

async function disconnect() {
  try {
    if (state.transport) {
      await state.transport.disconnect();
    }
  } catch (err) {
    log(`Disconnect error: ${err.message}`);
  } finally {
    resetConnectionState();
  }
}

/** Release the ESPLoader/Transport that owns the port so it can be reopened for monitoring. */
async function releaseFlashSession() {
  if (state.transport) {
    try {
      await state.transport.disconnect();
    } catch (err) {
      log(`Warning while releasing device: ${err.message}`);
    }
  }
  state.transport = null;
  state.esploader = null;
  setConnected(false);
}

function rememberMonitorPort(port) {
  state.lastMonitorPort = port;
  try {
    state.lastMonitorPortInfo = port.getInfo();
  } catch {
    state.lastMonitorPortInfo = null;
  }
}

function isLastMonitorDevice(port) {
  if (port === state.lastMonitorPort) return true;
  if (!state.lastMonitorPortInfo) return false;

  let info;
  try {
    info = port.getInfo();
  } catch {
    return false;
  }

  const identityKeys = ["usbVendorId", "usbProductId", "bluetoothServiceClassId"].filter(
    (key) => state.lastMonitorPortInfo[key] !== undefined,
  );
  return (
    identityKeys.length > 0 &&
    identityKeys.every((key) => info[key] === state.lastMonitorPortInfo[key])
  );
}

function cancelMonitorReconnectTimer() {
  if (state.monitorReconnectTimer !== null) {
    clearTimeout(state.monitorReconnectTimer);
    state.monitorReconnectTimer = null;
  }
}

function scheduleMonitorReconnect(delay = MONITOR_RECONNECT_DELAY_MS) {
  if (
    state.monitorReconnectTimer !== null ||
    state.monitorReconnectInProgress ||
    state.monitorActive ||
    !state.monitorDesired ||
    !els.monitorAutoReconnectCheckbox.checked
  ) {
    return;
  }

  state.monitorReconnectTimer = setTimeout(() => {
    state.monitorReconnectTimer = null;
    void attemptMonitorReconnect();
  }, delay);
}

async function openMonitorPort(port, reconnecting = false) {
  state.port = port;
  rememberMonitorPort(port);
  attachDisconnectListener(port);

  try {
    await port.open({ baudRate: state.monitorBaudRate });
  } catch (err) {
    if (reconnecting && state.port === port) state.port = null;
    throw err;
  }

  // The user may have stopped monitoring while port.open() was pending.
  if (!state.monitorDesired) {
    try {
      await port.close();
    } catch {
      // The port may already have disappeared again.
    }
    if (state.port === port) state.port = null;
    return false;
  }

  cancelMonitorReconnectTimer();
  setMonitorConnected(true);
  log(
    reconnecting
      ? `Serial monitor reconnected at ${state.monitorBaudRate} baud.`
      : `Serial monitor started at ${state.monitorBaudRate} baud.`,
  );
  void runMonitorReadLoop(port);
  return true;
}

function handleUnexpectedMonitorDisconnect(port) {
  if (state.port !== port && state.lastMonitorPort !== port) return;

  if (state.port === port) state.port = null;
  state.monitorReader = null;
  setMonitorConnected(false);

  if (state.monitorDesired && els.monitorAutoReconnectCheckbox.checked) {
    setMonitorConnected(false, "再接続待機中...");
    scheduleMonitorReconnect(0);
    return;
  }

  state.monitorDesired = false;
  setMonitorConnected(false);
}

async function attemptMonitorReconnect(preferredPort = null) {
  if (
    state.monitorReconnectInProgress ||
    state.monitorActive ||
    !state.monitorDesired ||
    !els.monitorAutoReconnectCheckbox.checked
  ) {
    return;
  }

  state.monitorReconnectInProgress = true;
  try {
    const authorizedPorts = await navigator.serial.getPorts();
    const candidates = [];
    if (preferredPort && isLastMonitorDevice(preferredPort)) candidates.push(preferredPort);
    for (const port of authorizedPorts) {
      if (isLastMonitorDevice(port) && !candidates.includes(port)) candidates.push(port);
    }

    for (const port of candidates) {
      if (!state.monitorDesired || els.monitorAutoReconnectCheckbox.checked === false) return;
      try {
        if (await openMonitorPort(port, true)) return;
      } catch {
        // The device may not be ready immediately after insertion. Retry shortly.
      }
    }
  } catch {
    // getPorts() can fail transiently while the browser processes a disconnect.
  } finally {
    state.monitorReconnectInProgress = false;
    if (!state.monitorActive) scheduleMonitorReconnect();
  }
}

async function startMonitor() {
  if (!("serial" in navigator) || state.monitorActive) return;

  state.monitorDesired = true;
  state.monitorBaudRate = Number(els.monitorBaudRate.value);
  setMonitorConnected(false, "接続中...");
  els.monitorBtn.disabled = true;
  try {
    if (state.transport) {
      log("Releasing device from flash session for monitor...");
      await releaseFlashSession();
    }
    if (!state.port) {
      state.port = await navigator.serial.requestPort();
    }
    await openMonitorPort(state.port);
  } catch (err) {
    log(`Monitor failed: ${err.message}`);
    state.monitorDesired = false;
    setMonitorConnected(false);
  }
}

async function runMonitorReadLoop(port) {
  const decoder = new TextDecoder();
  try {
    while (state.port === port && port.readable && state.monitorActive) {
      const reader = port.readable.getReader();
      state.monitorReader = reader;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) terminal.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Stream already errored/closed (e.g. device unplugged); nothing to release.
        }
        if (state.monitorReader === reader) state.monitorReader = null;
      }
    }
  } catch (err) {
    if (state.monitorActive) log(`Monitor read error: ${err.message}`);
  } finally {
    if (state.monitorDesired && state.port === port) {
      // Port closed/lost unexpectedly (e.g. device unplugged).
      handleUnexpectedMonitorDisconnect(port);
    }
  }
}

async function stopMonitor() {
  if (!state.monitorActive && !state.monitorDesired) return;

  state.monitorDesired = false;
  cancelMonitorReconnectTimer();
  setMonitorConnected(false);
  try {
    if (state.monitorReader) {
      await state.monitorReader.cancel();
    }
  } catch {
    // Reader already gone; nothing to clean up.
  }
  try {
    if (state.port) await state.port.close();
  } catch (err) {
    log(`Monitor disconnect error: ${err.message}`);
  }
  log("Serial monitor stopped.");
}

async function flash() {
  const firmwareName = els.firmwareSelect.value;
  if (!firmwareName || !state.esploader) return;

  els.connectBtn.disabled = true;
  els.disconnectBtn.disabled = true;
  els.flashBtn.disabled = true;
  els.monitorBtn.disabled = true;
  els.flashProgress.hidden = false;
  els.flashProgress.value = 0;

  let flashSucceeded = false;

  try {
    log(`Fetching firmware: ${firmwareName}`);
    const res = await fetch(`/firmware/${encodeURIComponent(firmwareName)}`);
    if (!res.ok) throw new Error(`Failed to fetch firmware (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());

    const parsed = parseFirmwareName(firmwareName);
    const address = parsed ? parsed.address : 0x0;

    if (parsed && data.length > parsed.maxBytes) {
      throw new Error(
        `File size (${data.length} bytes) exceeds the partition capacity encoded in the ` +
          `filename (${parsed.maxBytes} bytes)`,
      );
    }

    const board = selectedBoard();
    log(
      `Flashing ${firmwareName} (${data.length} bytes) at 0x${address.toString(16)} ` +
        `[board=${els.boardSelect.selectedOptions[0].textContent.trim()}, flashSize=${board.flashSize}]...`,
    );

    await state.esploader.writeFlash({
      fileArray: [{ data, address }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: board.flashSize,
      eraseAll: els.eraseFlashCheckbox.checked,
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        els.flashProgress.value = (written / total) * 100;
      },
    });

    log("Flash complete. Resetting device...");
    // esploader.after("hard_reset") only pulls RTS low, but RTS is already low
    // at this point (left that way by the connect-time reset sequence), so it
    // produces no edge and the chip stays put. ClassicReset drives a full
    // low->high pulse on RTS (EN) regardless of the pin's current state, so
    // the app actually starts running without a manual reset button press.
    await new ClassicReset(state.transport, 100).reset();
    log("Done.");
    flashSucceeded = true;
  } catch (err) {
    log(`Flash failed: ${err.message}`);
  } finally {
    els.flashProgress.hidden = true;
    els.disconnectBtn.disabled = !state.esploader;
    els.connectBtn.disabled = !!state.esploader;
    els.monitorBtn.disabled = state.monitorActive;
    updateFlashButtonState();
  }

  if (flashSucceeded) {
    if (els.autoMonitorCheckbox.checked) {
      await startMonitor();
    } else {
      log("Click Monitor to view the device's serial output.");
    }
  }
}

function checkSerialSupport() {
  if (!("serial" in navigator)) {
    els.serialNotice.hidden = false;
    els.connectBtn.disabled = true;
    els.monitorBtn.disabled = true;
    els.monitorAutoReconnectCheckbox.disabled = true;
    return false;
  }
  return true;
}

els.connectBtn.addEventListener("click", connect);
els.disconnectBtn.addEventListener("click", disconnect);
els.refreshFirmwareBtn.addEventListener("click", syncAndReloadFirmwareList);
els.firmwareSelect.addEventListener("change", updateFlashButtonState);
els.flashBtn.addEventListener("click", flash);
els.monitorBtn.addEventListener("click", startMonitor);
els.monitorDisconnectBtn.addEventListener("click", stopMonitor);
els.monitorAutoReconnectCheckbox.addEventListener("change", () => {
  if (!els.monitorAutoReconnectCheckbox.checked && state.monitorDesired && !state.monitorActive) {
    state.monitorDesired = false;
    cancelMonitorReconnectTimer();
    setMonitorConnected(false);
    log("Serial monitor auto-reconnect cancelled.");
  }
});
els.deviceResetBtn.addEventListener("click", resetDevice);
els.logClearBtn.addEventListener("click", () => terminal.clean());

if ("serial" in navigator) {
  navigator.serial.addEventListener("connect", (event) => {
    if (
      state.monitorDesired &&
      !state.monitorActive &&
      els.monitorAutoReconnectCheckbox.checked
    ) {
      void attemptMonitorReconnect(event.port);
    }
  });
}

checkSerialSupport();
populateBoardSelect();
loadFirmwareList();
