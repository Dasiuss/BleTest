const SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
const ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
const ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
const ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";

const $ = (id) => document.getElementById(id);
const els = {
  browserWarning: $("browserWarning"),
  connectionBadge: $("connectionBadge"),
  connectionText: $("connectionText"),
  connectButton: $("connectButton"),
  disconnectButton: $("disconnectButton"),
  routeStartButton: $("routeStartButton"),
  routeStopButton: $("routeStopButton"),
  routeInfo: $("routeInfo"),
  routeReceived: $("routeReceived"),
  routeRate: $("routeRate"),
  routeStatus: $("routeStatus"),
  routeOutput: $("routeOutput"),
  routeDownloadLink: $("routeDownloadLink"),
  eventLog: $("eventLog"),
  clearLogButton: $("clearLogButton"),
};

let device = null;
let routeInfoCharacteristic = null;
let routeControlCharacteristic = null;
let routeDataCharacteristic = null;
let routeInfo = null;
let routeChunks = [];
let routeReceivedBytes = 0;
let routeOutputBytes = 0;
let routeFrameCount = 0;
let routeExpectedSequence = 0;
let routeRecoveryPending = false;
let routeCrc32 = 0xFFFFFFFF;
let routeStartedAt = 0;
let routeTransferring = false;
let routeStopRequested = false;
let routeDownloadUrl = null;
let routeTransferPromise = null;
let routeTransferResolve = null;
let routeTransferReject = null;
let routeControlWriteChain = Promise.resolve();
let routeStorageChain = Promise.resolve();
let routeFileHandle = null;
let routeFileWriter = null;
let routeLineCount = 0;
let routeDecoder = null;
let routeEncodedTextBuffer = "";
let routeHeaderDecoded = false;
let routeDecodedPointCount = 0;
let routePreviousTimestamp = 0;
let routePreviousLatitude = 0;
let routePreviousLongitude = 0;
let routePendingOutput = [];

function log(message, type = "") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString("pl-PL", { hour12: false });
  const timeElement = document.createElement("span");
  timeElement.className = "log-time";
  timeElement.textContent = time;
  entry.append(timeElement, document.createTextNode(message));
  els.eventLog.prepend(entry);
}

function setConnection(state, label) {
  els.connectionBadge.className = `badge badge-${state}`;
  els.connectionText.textContent = label;
}

function setControls(connected) {
  els.connectButton.disabled = connected;
  els.disconnectButton.disabled = !connected;
  els.routeStartButton.disabled = !connected || routeTransferring;
  els.routeStopButton.disabled = !connected || !routeTransferring;
}

function decodeValue(dataView) {
  return new TextDecoder().decode(new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function characteristicProperties(characteristic) {
  return [
    ["read", "READ"],
    ["write", "WRITE"],
    ["writeWithoutResponse", "WRITE WITHOUT RESPONSE"],
    ["notify", "NOTIFY"],
  ].filter(([key]) => characteristic.properties[key]).map(([, label]) => label).join(" + ");
}

function updateRouteProgress() {
  const elapsed = routeStartedAt ? (performance.now() - routeStartedAt) / 1000 : 0;
  const rate = elapsed > 0 ? routeReceivedBytes / elapsed : 0;
  els.routeReceived.textContent = `${formatBytes(routeOutputBytes)} CSV · ${routeFrameCount.toLocaleString("pl-PL")} NOTIFY`;
  els.routeRate.textContent = elapsed > 0 ? `${formatBytes(rate)}/s · ${(rate * 8 / 1000).toFixed(1)} kbit/s` : "---";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function updateRouteCrc32(bytes) {
  for (const byte of bytes) {
    routeCrc32 ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      routeCrc32 = (routeCrc32 >>> 1) ^ (0xEDB88320 & -(routeCrc32 & 1));
    }
  }
}

function persistRouteOutput(text) {
  const bytes = new TextEncoder().encode(text);
  updateRouteCrc32(bytes);
  routeOutputBytes += bytes.byteLength;
  routeLineCount += 1;
  routePendingOutput.push(bytes);
}

function flushRouteOutput() {
  if (routePendingOutput.length === 0) return;
  const size = routePendingOutput.reduce((total, bytes) => total + bytes.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of routePendingOutput) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  routePendingOutput = [];
  if (routeFileWriter) {
    routeStorageChain = routeStorageChain.then(() => routeFileWriter.write(bytes));
  } else {
    routeChunks.push(bytes);
  }
}

function decodeRouteLine(line) {
  if (!routeHeaderDecoded) {
    if (line !== "t_ms,latitude,longitude") throw new Error("Nieprawidłowy nagłówek delta trasy");
    routeHeaderDecoded = true;
    persistRouteOutput(`${line}\n`);
    return;
  }

  const fields = line.split(",");
  if (fields.length !== 3) throw new Error("Nieprawidłowy rekord delta trasy");
  const values = fields.map(Number);
  if (values.some((value) => !Number.isInteger(value) || !Number.isFinite(value))) {
    throw new Error("Nieprawidłowa wartość delta trasy");
  }

  if (routeDecodedPointCount === 0) {
    [routePreviousTimestamp, routePreviousLatitude, routePreviousLongitude] = values;
  } else {
    routePreviousTimestamp += values[0];
    routePreviousLatitude += values[1];
    routePreviousLongitude += values[2];
  }

  persistRouteOutput(`${routePreviousTimestamp},${(routePreviousLatitude / 1e6).toFixed(6)},${(routePreviousLongitude / 1e6).toFixed(6)}\n`);
  routeDecodedPointCount += 1;
}

function decodeRoutePayload(payload) {
  routeEncodedTextBuffer += routeDecoder.decode(payload, { stream: true });
  let newlineIndex = routeEncodedTextBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = routeEncodedTextBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    routeEncodedTextBuffer = routeEncodedTextBuffer.slice(newlineIndex + 1);
    decodeRouteLine(line);
    newlineIndex = routeEncodedTextBuffer.indexOf("\n");
  }
}

function finishRouteDecoder() {
  routeEncodedTextBuffer += routeDecoder.decode();
  if (routeEncodedTextBuffer.length > 0) {
    decodeRouteLine(routeEncodedTextBuffer.replace(/\r$/, ""));
    routeEncodedTextBuffer = "";
  }
  if (!routeHeaderDecoded || routeDecodedPointCount !== routeInfo.points) {
    throw new Error("Nieprawidłowa liczba punktów delta trasy");
  }
}

async function waitForRouteReady() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    routeInfo = JSON.parse(decodeValue(await routeInfoCharacteristic.readValue()));
    if (routeInfo.ready) return;
    await sleep(10);
  }
  throw new Error("Timeout oczekiwania na gotowość trasy");
}

function writeRouteCommand(command) {
  const value = new TextEncoder().encode(command);
  const operation = routeControlWriteChain.catch(() => {}).then(() => routeControlCharacteristic.writeValue(value));
  routeControlWriteChain = operation;
  return operation;
}

async function waitForRouteComplete() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    routeInfo = JSON.parse(decodeValue(await routeInfoCharacteristic.readValue()));
    if (routeInfo.done) return;
    await sleep(10);
  }
  throw new Error("Timeout oczekiwania na potwierdzenie trasy");
}

function rejectRouteTransfer(error) {
  if (routeTransferReject) routeTransferReject(error);
}

function acknowledgeRouteSequence(sequence, finalFrame, persisted) {
  const acknowledgement = persisted.then(() => writeRouteCommand(`ACK:${sequence}`));
  if (finalFrame) {
    acknowledgement.then(waitForRouteComplete).then(() => routeTransferResolve?.(), rejectRouteTransfer);
  } else {
    acknowledgement.catch(rejectRouteTransfer);
  }
}

function handleRouteNotification(event) {
  if (!routeTransferring || !routeInfo) return;

  const value = event.target.value;
  if (value.byteLength < 4) {
    rejectRouteTransfer(new Error("Nieprawidłowa ramka NOTIFY trasy"));
    return;
  }

  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const sequence = view.getUint32(0, true);
  if (sequence < routeExpectedSequence) return;
  if (sequence > routeExpectedSequence) {
    if (!routeRecoveryPending) {
      routeRecoveryPending = true;
      writeRouteCommand(`NACK:${routeExpectedSequence}`).catch(rejectRouteTransfer);
    }
    return;
  }

  routeRecoveryPending = false;
  const payload = new Uint8Array(value.buffer, value.byteOffset + 4, value.byteLength - 4).slice();
  if (payload.byteLength > routeInfo.chunk_bytes || routeReceivedBytes + payload.byteLength > routeInfo.encoded_bytes) {
    rejectRouteTransfer(new Error("Nieprawidłowy rozmiar fragmentu trasy"));
    return;
  }

  routeReceivedBytes += payload.byteLength;
  routeFrameCount += 1;
  try {
    decodeRoutePayload(payload);
  } catch (error) {
    rejectRouteTransfer(error);
    return;
  }
  routeExpectedSequence += 1;
  updateRouteProgress();

  const finalFrame = routeReceivedBytes === routeInfo.encoded_bytes;
  if (finalFrame) {
    try {
      finishRouteDecoder();
    } catch (error) {
      rejectRouteTransfer(error);
      return;
    }
  }
  const requiresAcknowledgement = finalFrame || routeExpectedSequence % routeInfo.window_chunks === 0;
  if (requiresAcknowledgement) {
    flushRouteOutput();
  }
  const persisted = routeStorageChain;
  if (requiresAcknowledgement) {
    acknowledgeRouteSequence(routeExpectedSequence, finalFrame, persisted);
  }
}

async function prepareRouteStorage() {
  routeStorageChain = Promise.resolve();
  routeFileHandle = null;
  routeFileWriter = null;
  if (!navigator.storage?.getDirectory) return;

  const root = await navigator.storage.getDirectory();
  routeFileHandle = await root.getFileHandle(`route-gps-${Date.now()}.csv`, { create: true });
  routeFileWriter = await routeFileHandle.createWritable();
}

async function finishRouteTransfer() {
  const elapsed = (performance.now() - routeStartedAt) / 1000;
  await routeStorageChain;
  if (routeFileWriter) {
    await routeFileWriter.close();
    routeFileWriter = null;
  }
  const routeBlob = routeFileHandle ? await routeFileHandle.getFile() : new Blob(routeChunks, { type: "text/csv" });
  const rawBytes = routeBlob.size;
  const pointCount = Math.max(0, routeLineCount - 1);
  const receivedCrc32 = ((routeCrc32 ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  if (rawBytes !== routeInfo.raw_bytes || pointCount !== routeInfo.points || receivedCrc32 !== routeInfo.crc32) {
    throw new Error(`Walidacja CSV nie powiodła się: ${pointCount} punktów, ${rawBytes} bajtów`);
  }

  if (routeDownloadUrl) URL.revokeObjectURL(routeDownloadUrl);
  routeDownloadUrl = URL.createObjectURL(routeBlob);
  els.routeDownloadLink.href = routeDownloadUrl;
  els.routeDownloadLink.hidden = false;
  els.routeDownloadLink.textContent = `Pobierz CSV (${formatBytes(rawBytes)})`;
  els.routeStatus.textContent = `OK · ${elapsed.toFixed(2)} s`;
  els.routeOutput.textContent = [
    `Punkty: ${routeInfo.points.toLocaleString("pl-PL")}`,
    `Pakiety NOTIFY: ${routeFrameCount.toLocaleString("pl-PL")}`,
    `CRC32: ${receivedCrc32}`,
    `Delta wire: ${formatBytes(routeReceivedBytes)}`,
    `Surowy CSV: ${formatBytes(rawBytes)}`,
    `Redukcja: ${(routeInfo.raw_bytes / routeInfo.encoded_bytes).toFixed(2)}x`,
    `Transfer delta: ${formatBytes(routeReceivedBytes / elapsed)}/s · ${(routeReceivedBytes * 8 / elapsed / 1000).toFixed(1)} kbit/s`,
    "",
    await routeBlob.slice(0, 512).text(),
  ].join("\n");
  log(`Transfer trasy zakończony: ${elapsed.toFixed(2)} s`, "success");
}

async function transferRoute() {
  if (!routeControlCharacteristic || !routeDataCharacteristic || routeTransferring) return;

  routeChunks = [];
  routeReceivedBytes = 0;
  routeOutputBytes = 0;
  routeFrameCount = 0;
  routeExpectedSequence = 0;
  routeRecoveryPending = false;
  routeCrc32 = 0xFFFFFFFF;
  routeLineCount = 0;
  routeDecoder = new TextDecoder();
  routeEncodedTextBuffer = "";
  routeHeaderDecoded = false;
  routeDecodedPointCount = 0;
  routePreviousTimestamp = 0;
  routePreviousLatitude = 0;
  routePreviousLongitude = 0;
  routePendingOutput = [];
  routeStartedAt = performance.now();
  routeTransferring = true;
  routeStopRequested = false;
  els.routeStatus.textContent = "Pobieranie...";
  els.routeOutput.textContent = "Urządzenie strumieniuje trasę przez NOTIFY...";
  els.routeDownloadLink.hidden = true;
  setControls(true);

  try {
    await prepareRouteStorage();
    routeTransferPromise = new Promise((resolve, reject) => {
      routeTransferResolve = resolve;
      routeTransferReject = reject;
    });
    await writeRouteCommand("START");
    await waitForRouteReady();
    await routeTransferPromise;
    await finishRouteTransfer();
  } catch (error) {
    if (routeStopRequested) {
      els.routeStatus.textContent = "Zatrzymano";
      els.routeOutput.textContent = `Odebrano ${formatBytes(routeReceivedBytes)} delta.`;
    } else {
      els.routeStatus.textContent = "BŁĄD transferu";
      els.routeOutput.textContent = error.message;
      log(`Transfer trasy nie powiódł się: ${error.message}`, "error");
    }
  } finally {
    if (routeFileWriter) {
      try {
        await routeFileWriter.abort();
      } catch (error) {
        log(`Nie udało się zamknąć pliku tymczasowego: ${error.message}`, "error");
      }
      routeFileWriter = null;
    }
    routeTransferPromise = null;
    routeTransferResolve = null;
    routeTransferReject = null;
    routeTransferring = false;
    routeStopRequested = false;
    setControls(Boolean(routeDataCharacteristic));
  }
}

async function stopRouteTransfer() {
  if (!routeControlCharacteristic || !routeTransferring) return;
  routeStopRequested = true;
  try {
    await writeRouteCommand("STOP");
    rejectRouteTransfer(new Error("Transfer zatrzymany"));
    log(`Transfer zatrzymany po ${formatBytes(routeReceivedBytes)} delta`);
  } catch (error) {
    log(`Nie udało się zatrzymać transferu: ${error.message}`, "error");
  }
}

async function connect() {
  if (!navigator.bluetooth) {
    log("Ta przeglądarka nie udostępnia Web Bluetooth", "error");
    return;
  }

  try {
    setConnection("busy", "Wybierz urządzenie");
    log("Otwieram wybór urządzenia BLE...");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", handleDisconnect);
    setConnection("busy", "Łączenie GATT");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const discovered = await service.getCharacteristics();
    discovered.forEach((item) => log(`Discovery: ${item.uuid} [${characteristicProperties(item)}]`));

    routeInfoCharacteristic = await service.getCharacteristic(ROUTE_INFO_CHARACTERISTIC_UUID);
    routeControlCharacteristic = await service.getCharacteristic(ROUTE_CONTROL_CHARACTERISTIC_UUID);
    routeDataCharacteristic = await service.getCharacteristic(ROUTE_DATA_CHARACTERISTIC_UUID);
    if (!routeDataCharacteristic.properties.notify) throw new Error("Urządzenie nie obsługuje NOTIFY dla trasy");
    await routeDataCharacteristic.startNotifications();
    routeDataCharacteristic.addEventListener("characteristicvaluechanged", handleRouteNotification);
    routeInfo = JSON.parse(decodeValue(await routeInfoCharacteristic.readValue()));
    els.routeInfo.textContent = `${routeInfo.points.toLocaleString("pl-PL")} punktów · ${formatBytes(routeInfo.raw_bytes)} CSV · ${formatBytes(routeInfo.encoded_bytes)} delta · MTU ${routeInfo.mtu} · fragment ${routeInfo.chunk_bytes} B`;
    setConnection("connected", "Połączono");
    setControls(true);
    log("Gotowe: trasa jest pobierana przez NOTIFY", "success");
  } catch (error) {
    log(`Połączenie nie powiodło się: ${error.message}`, "error");
    setConnection("error", "Błąd połączenia");
    cleanupConnection();
  }
}

function cleanupConnection() {
  if (routeDataCharacteristic) routeDataCharacteristic.removeEventListener("characteristicvaluechanged", handleRouteNotification);
  if (routeTransferReject) routeTransferReject(new Error("Połączenie BLE zostało przerwane"));
  routeTransferring = false;
  routeInfoCharacteristic = null;
  routeControlCharacteristic = null;
  routeDataCharacteristic = null;
  routeInfo = null;
  setControls(false);
}

function handleDisconnect() {
  log("ESP32 rozłączył połączenie", "error");
  setConnection("idle", "Rozłączono");
  cleanupConnection();
}

function disconnect() {
  if (device?.gatt?.connected) device.gatt.disconnect();
  setConnection("idle", "Rozłączono");
  cleanupConnection();
}

els.connectButton.addEventListener("click", connect);
els.disconnectButton.addEventListener("click", disconnect);
els.routeStartButton.addEventListener("click", transferRoute);
els.routeStopButton.addEventListener("click", stopRouteTransfer);
els.clearLogButton.addEventListener("click", () => els.eventLog.replaceChildren());

if (!navigator.bluetooth) els.browserWarning.hidden = false;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => log(`Service worker: ${error.message}`, "error"));
log("Gotowe. Połącz urządzenie, aby uruchomić test trasy.");
