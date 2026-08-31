const APP_VERSION = "v4.3";
const PROTOCOL_VERSION = "v4";
const SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
const ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
const ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
const ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";
const ROUTE_FRAME_HEADER_SIZE = 4;
const ROUTE_OUTPUT_FLUSH_SIZE = 16 * 1024;

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
  routeProtocolLog: $("routeProtocolLog"),
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
let routeLostFrames = 0;
let routeLastDuplicateAckSequence = -1;
let routeRecoveryPending = false;
let routeCrc32 = 0xFFFFFFFF;
let routeStartedAt = 0;
let routeFirstNotifyAt = 0;
let routeTransferEndAt = 0;
let routeTransferring = false;
let routeStopRequested = false;
let routeDownloadUrl = null;
let routeTransferPromise = null;
let routeTransferResolve = null;
let routeTransferReject = null;
let routeTransferTimeout = null;
let routeControlWriteChain = Promise.resolve();
let routeStorageChain = Promise.resolve();
let routeFileHandle = null;
let routeFileWriter = null;
let routeLineCount = 0;
let routePendingOutput = [];
let routePendingOutputBytes = 0;
let routeCompressedController = null;
let routeDecompressionPromise = null;
let routeDecompressionDoneAt = 0;
let routeProfile = null;

function resetRouteProfile() {
  routeProfile = {
    controlWrites: 0,
    ackWrites: 0,
    nackWrites: 0,
    controlQueueMs: 0,
    controlWriteMs: 0,
    controlWriteMaxMs: 0,
    notifyHandlerUs: 0,
    notifyHandlerCalls: 0,
    notifyHandlerMaxUs: 0,
    duplicateFrames: 0,
    flushes: 0,
    flushedBytes: 0,
    flushCopyMs: 0,
    storageWrites: 0,
    storageWriteMs: 0,
    storageWriteMaxMs: 0,
    storageBytes: 0,
    validationMs: 0,
    prepareStorageMs: 0,
  };
}

function recordRouteNotifyHandler(startedAt) {
  const elapsedUs = Math.round((performance.now() - startedAt) * 1000);
  routeProfile.notifyHandlerUs += elapsedUs;
  routeProfile.notifyHandlerCalls += 1;
  routeProfile.notifyHandlerMaxUs = Math.max(routeProfile.notifyHandlerMaxUs, elapsedUs);
}

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

function protocolLog(message, type = "data") {
  if (els.routeProtocolLog.checked) log(message, type);
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

function transferElapsed() {
  const end = routeTransferEndAt || performance.now();
  return routeStartedAt ? (end - routeStartedAt) / 1000 : 0;
}

function updateRouteProgress() {
  const elapsed = transferElapsed();
  const compressedRate = elapsed > 0 ? routeReceivedBytes / elapsed : 0;
  els.routeReceived.textContent = `${formatBytes(routeReceivedBytes)} zlib · ${formatBytes(routeOutputBytes)} CSV · ${routeFrameCount.toLocaleString("pl-PL")} NOTIFY`;
  els.routeRate.textContent = elapsed > 0
    ? `${formatBytes(compressedRate)}/s · ${(compressedRate * 8 / 1000).toFixed(1)} kbit/s`
    : "---";
}

function updateRouteCrc32(bytes) {
  for (const byte of bytes) {
    routeCrc32 ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      routeCrc32 = (routeCrc32 >>> 1) ^ (0xEDB88320 & -(routeCrc32 & 1));
    }
  }
}

function persistRouteOutput(bytes) {
  updateRouteCrc32(bytes);
  routeOutputBytes += bytes.byteLength;
  for (const byte of bytes) if (byte === 10) routeLineCount += 1;
  routePendingOutput.push(bytes.slice());
  routePendingOutputBytes += bytes.byteLength;
}

function flushRouteOutput() {
  if (routePendingOutput.length === 0) return;
  const flushStartedAt = performance.now();
  const bytes = new Uint8Array(routePendingOutputBytes);
  let offset = 0;
  for (const part of routePendingOutput) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  routePendingOutput = [];
  routePendingOutputBytes = 0;
  routeProfile.flushes += 1;
  routeProfile.flushedBytes += bytes.byteLength;
  routeProfile.flushCopyMs += performance.now() - flushStartedAt;
  if (routeFileWriter) {
    const writer = routeFileWriter;
    routeStorageChain = routeStorageChain.then(async () => {
      const writeStartedAt = performance.now();
      await writer.write(bytes);
      const elapsedMs = performance.now() - writeStartedAt;
      routeProfile.storageWrites += 1;
      routeProfile.storageWriteMs += elapsedMs;
      routeProfile.storageWriteMaxMs = Math.max(routeProfile.storageWriteMaxMs, elapsedMs);
      routeProfile.storageBytes += bytes.byteLength;
    });
  } else {
    routeChunks.push(bytes);
  }
}

async function consumeDecompressedRoute(stream) {
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    persistRouteOutput(bytes);
    if (routePendingOutputBytes >= ROUTE_OUTPUT_FLUSH_SIZE) flushRouteOutput();
    updateRouteProgress();
  }
  flushRouteOutput();
  await routeStorageChain;
  routeDecompressionDoneAt = performance.now();
}

function startRouteDecompressor() {
  if (!window.DecompressionStream || !window.ReadableStream) {
    throw new Error("Ta przeglądarka nie obsługuje natywnej dekompresji DEFLATE");
  }

  const compressedStream = new ReadableStream({
    start(controller) {
      routeCompressedController = controller;
    },
  });
  const decompressedStream = compressedStream.pipeThrough(new DecompressionStream("deflate"));
  routeDecompressionPromise = consumeDecompressedRoute(decompressedStream);
  routeDecompressionPromise.catch((error) => {
    if (routeTransferring) rejectRouteTransfer(error);
  });
}

function writeRouteCommand(command) {
  const value = new TextEncoder().encode(command);
  const queuedAt = performance.now();
  const operation = routeControlWriteChain.catch(() => {}).then(async () => {
    const writeStartedAt = performance.now();
    routeProfile.controlQueueMs += writeStartedAt - queuedAt;
    await routeControlCharacteristic.writeValue(value);
    const elapsedMs = performance.now() - writeStartedAt;
    routeProfile.controlWrites += 1;
    routeProfile.controlWriteMs += elapsedMs;
    routeProfile.controlWriteMaxMs = Math.max(routeProfile.controlWriteMaxMs, elapsedMs);
    if (command.startsWith("ACK:")) routeProfile.ackWrites += 1;
    if (command.startsWith("NACK:")) routeProfile.nackWrites += 1;
    protocolLog(`CONTROL WRITE: ${command} · ${elapsedMs.toFixed(1)} ms`);
  });
  routeControlWriteChain = operation;
  return operation;
}

function rejectRouteTransfer(error) {
  if (routeTransferReject) routeTransferReject(error);
}

function handleRouteNotification(event) {
  if (!routeTransferring || !routeInfo) return;
  const handlerStartedAt = performance.now();

  const value = event.target.value;
  if (value.byteLength < ROUTE_FRAME_HEADER_SIZE) {
    rejectRouteTransfer(new Error("Nieprawidłowa ramka NOTIFY trasy"));
    recordRouteNotifyHandler(handlerStartedAt);
    return;
  }

  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const sequence = view.getUint32(0, true);
  if (sequence < routeExpectedSequence) {
    routeProfile.duplicateFrames += 1;
    protocolLog(`DUPLICATE NOTIFY #${sequence}`);
    if (routeInfo.window_chunks && routeExpectedSequence % routeInfo.window_chunks === 0 && routeLastDuplicateAckSequence !== routeExpectedSequence) {
      routeLastDuplicateAckSequence = routeExpectedSequence;
      writeRouteCommand(`ACK:${routeExpectedSequence}`).catch(rejectRouteTransfer);
    }
    recordRouteNotifyHandler(handlerStartedAt);
    return;
  }
  if (sequence > routeExpectedSequence) {
    routeLostFrames += sequence - routeExpectedSequence;
    if (!routeRecoveryPending) {
      routeRecoveryPending = true;
      protocolLog(`NACK: ${routeExpectedSequence} · otrzymano #${sequence}`);
      writeRouteCommand(`NACK:${routeExpectedSequence}`).catch(rejectRouteTransfer);
    }
    recordRouteNotifyHandler(handlerStartedAt);
    return;
  }

  routeRecoveryPending = false;
  routeExpectedSequence += 1;
  routeFrameCount += 1;
  const payload = new Uint8Array(value.buffer, value.byteOffset + ROUTE_FRAME_HEADER_SIZE, value.byteLength - ROUTE_FRAME_HEADER_SIZE).slice();
  if (routeFirstNotifyAt === 0) routeFirstNotifyAt = performance.now();
  protocolLog(`NOTIFY #${sequence}: ${payload.byteLength} B${payload.byteLength === 0 ? " · KONIEC" : ""}`);

  if (payload.byteLength === 0) {
    routeTransferEndAt = performance.now();
    try {
      routeCompressedController.close();
    } catch (error) {
      rejectRouteTransfer(error);
      recordRouteNotifyHandler(handlerStartedAt);
      return;
    }
    writeRouteCommand(`ACK:${routeExpectedSequence}`).catch(rejectRouteTransfer);
    routeDecompressionPromise.then(() => routeTransferResolve?.(), rejectRouteTransfer);
    updateRouteProgress();
    recordRouteNotifyHandler(handlerStartedAt);
    return;
  }

  routeReceivedBytes += payload.byteLength;
  try {
    routeCompressedController.enqueue(payload);
  } catch (error) {
    rejectRouteTransfer(error);
    recordRouteNotifyHandler(handlerStartedAt);
    return;
  }
  updateRouteProgress();
  if (routeInfo.window_chunks && routeExpectedSequence % routeInfo.window_chunks === 0) {
    writeRouteCommand(`ACK:${routeExpectedSequence}`).catch(rejectRouteTransfer);
  }
  recordRouteNotifyHandler(handlerStartedAt);
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
  const elapsed = transferElapsed();
  await routeStorageChain;
  if (routeFileWriter) {
    await routeFileWriter.close();
    routeFileWriter = null;
  }

  const routeBlob = routeFileHandle ? await routeFileHandle.getFile() : new Blob(routeChunks, { type: "text/csv" });
  const validationStartedAt = performance.now();
  const rawBytes = routeBlob.size;
  const receivedCrc32 = ((routeCrc32 ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  routeProfile.validationMs = performance.now() - validationStartedAt;
  if (rawBytes !== routeInfo.raw_bytes || routeLineCount !== routeInfo.lines || receivedCrc32 !== routeInfo.crc32) {
    throw new Error(`Walidacja NMEA nie powiodła się: ${routeLineCount} linii, ${rawBytes} bajtów, CRC ${receivedCrc32}`);
  }

  if (routeDownloadUrl) URL.revokeObjectURL(routeDownloadUrl);
  routeDownloadUrl = URL.createObjectURL(routeBlob);
  els.routeDownloadLink.href = routeDownloadUrl;
  els.routeDownloadLink.hidden = false;
  els.routeDownloadLink.textContent = `Pobierz CSV (${formatBytes(rawBytes)})`;

  const decompressionElapsed = Math.max(0, ((routeDecompressionDoneAt || performance.now()) - routeTransferEndAt) / 1000);
  const firstNotifyDelay = Math.max(0, (routeFirstNotifyAt - routeStartedAt) / 1000);
  const notifySpan = Math.max(0, (routeTransferEndAt - routeFirstNotifyAt) / 1000);
  const compressedRate = elapsed > 0 ? routeReceivedBytes / elapsed : 0;
  const totalRate = elapsed > 0 ? rawBytes / elapsed : 0;
  const averageHandlerUs = routeProfile.notifyHandlerCalls > 0
    ? routeProfile.notifyHandlerUs / routeProfile.notifyHandlerCalls
    : 0;
  const averageControlWriteMs = routeProfile.controlWrites > 0
    ? routeProfile.controlWriteMs / routeProfile.controlWrites
    : 0;
  const averageStorageWriteMs = routeProfile.storageWrites > 0
    ? routeProfile.storageWriteMs / routeProfile.storageWrites
    : 0;
  const profileLines = [
    "",
    "PROFILOWANIE PWA",
    `Strumień BLE od pierwszego NOTIFY: ${(notifySpan * 1000).toFixed(0)} ms`,
    `Obsługa NOTIFY JS: ${(routeProfile.notifyHandlerUs / 1000).toFixed(1)} ms łącznie · średnio ${averageHandlerUs.toFixed(0)} us · max ${routeProfile.notifyHandlerMaxUs} us`,
    `ACK: ${routeProfile.ackWrites} · NACK: ${routeProfile.nackWrites} · duplikaty: ${routeProfile.duplicateFrames}`,
    `Komendy control: ${routeProfile.controlWrites} · kolejka ${routeProfile.controlQueueMs.toFixed(1)} ms · write ${routeProfile.controlWriteMs.toFixed(1)} ms · średnio ${averageControlWriteMs.toFixed(1)} ms`,
    `Bufory wyjścia: ${routeProfile.flushes} · ${formatBytes(routeProfile.flushedBytes)} · kopiowanie ${routeProfile.flushCopyMs.toFixed(1)} ms`,
    `Zapis wyniku (${routeFileHandle ? "OPFS" : "Blob"}): ${routeProfile.storageWrites} zapisów · ${formatBytes(routeProfile.storageBytes)} · łącznie ${routeProfile.storageWriteMs.toFixed(1)} ms · max ${routeProfile.storageWriteMaxMs.toFixed(1)} ms`,
    `Przygotowanie magazynu: ${routeProfile.prepareStorageMs.toFixed(1)} ms`,
    `Dekompresja + zapis po końcu NOTIFY: ${(decompressionElapsed * 1000).toFixed(1)} ms`,
    `Walidacja pliku: ${routeProfile.validationMs.toFixed(1)} ms`,
  ];
  els.routeStatus.textContent = `OK · ${elapsed.toFixed(2)} s`;
  els.routeOutput.textContent = [
    `PWA: ${APP_VERSION} · protokół: ${PROTOCOL_VERSION} · firmware: ${routeInfo.firmware || routeInfo.version}`,
    `Punkty GPS: ${routeInfo.points.toLocaleString("pl-PL")}`,
    `Wiersze NMEA: ${routeLineCount.toLocaleString("pl-PL")}`,
    `Pakiety NOTIFY: ${routeFrameCount.toLocaleString("pl-PL")}`,
  `Odzyskane luki ramek: ${routeLostFrames}`,
    `Pierwszy NOTIFY po: ${(firstNotifyDelay * 1000).toFixed(0)} ms`,
    `CRC32: ${receivedCrc32}`,
    `Skompresowany wire: ${formatBytes(routeReceivedBytes)}`,
    `Surowy CSV: ${formatBytes(rawBytes)}`,
    `Redukcja: ${(rawBytes / routeReceivedBytes).toFixed(2)}x`,
    `Bitrate skompresowany: ${formatBytes(compressedRate)}/s · ${(compressedRate * 8 / 1000).toFixed(1)} kbit/s`,
    `Średni bitrate całkowity CSV: ${formatBytes(totalRate)}/s · ${(totalRate * 8 / 1000).toFixed(1)} kbit/s`,
    ...profileLines,
    "",
    await routeBlob.slice(0, 512).text(),
  ].join("\n");
  log(`Transfer trasy ${APP_VERSION} zakończony: ${elapsed.toFixed(2)} s · NOTIFY ${routeFrameCount} · ACK ${routeProfile.ackWrites} · NACK ${routeProfile.nackWrites}`, "success");
  log(`[PROFILE] JS NOTIFY avg ${averageHandlerUs.toFixed(0)} us / max ${routeProfile.notifyHandlerMaxUs} us · OPFS ${routeProfile.storageWriteMs.toFixed(1)} ms`, "success");
}

async function transferRoute() {
  if (!routeControlCharacteristic || !routeDataCharacteristic || routeTransferring) return;

  routeChunks = [];
  routeReceivedBytes = 0;
  routeOutputBytes = 0;
  routeFrameCount = 0;
  routeExpectedSequence = 0;
  routeLostFrames = 0;
  routeLastDuplicateAckSequence = -1;
  routeRecoveryPending = false;
  routeCrc32 = 0xFFFFFFFF;
  routeLineCount = 0;
  routePendingOutput = [];
  routePendingOutputBytes = 0;
  routeCompressedController = null;
  routeDecompressionPromise = null;
  routeDecompressionDoneAt = 0;
  resetRouteProfile();
  routeStartedAt = 0;
  routeFirstNotifyAt = 0;
  routeTransferEndAt = 0;
  routeTransferring = true;
  routeStopRequested = false;
  els.routeStatus.textContent = "Pobieranie...";
  els.routeOutput.textContent = "ESP32 kompresuje surowy NMEA CSV w loop i strumieniuje DEFLATE przez NOTIFY...";
  els.routeDownloadLink.hidden = true;
  setControls(true);

  try {
    const prepareStorageStartedAt = performance.now();
    await prepareRouteStorage();
    routeProfile.prepareStorageMs = performance.now() - prepareStorageStartedAt;
    routeTransferPromise = new Promise((resolve, reject) => {
      routeTransferResolve = resolve;
      routeTransferReject = reject;
    });
    startRouteDecompressor();
    routeStartedAt = performance.now();
    routeTransferTimeout = setTimeout(() => rejectRouteTransfer(new Error("Timeout oczekiwania na koniec transferu")), 120000);
    await writeRouteCommand("START");
    await routeTransferPromise;
    await routeControlWriteChain;
    await finishRouteTransfer();
  } catch (error) {
    if (routeStopRequested) {
      els.routeStatus.textContent = "Zatrzymano";
      els.routeOutput.textContent = `Odebrano ${formatBytes(routeReceivedBytes)} skompresowanych danych.`;
    } else {
      els.routeStatus.textContent = "BŁĄD transferu";
      els.routeOutput.textContent = error.message;
      log(`Transfer trasy nie powiódł się: ${error.message}`, "error");
    }
  } finally {
    if (routeTransferTimeout) clearTimeout(routeTransferTimeout);
    routeTransferTimeout = null;
    if (routeFileWriter) {
      try {
        await routeFileWriter.abort();
      } catch (error) {
        log(`Nie udało się zamknąć pliku tymczasowego: ${error.message}`, "error");
      }
      routeFileWriter = null;
    }
    routeCompressedController = null;
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
    routeCompressedController?.error(new Error("Transfer zatrzymany"));
    rejectRouteTransfer(new Error("Transfer zatrzymany"));
    log(`Transfer zatrzymany po ${formatBytes(routeReceivedBytes)} skompresowanych danych`);
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
    log(`Otwieram wybór urządzenia BLE (${APP_VERSION})...`);
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
    if (routeInfo.version !== PROTOCOL_VERSION || routeInfo.encoding !== "zlib-deflate") {
      throw new Error(`Nieobsługiwana wersja protokołu: ${routeInfo.version || "brak"}`);
    }
    els.routeInfo.textContent = `${routeInfo.version} · firmware ${routeInfo.firmware || "?"} · ${routeInfo.points.toLocaleString("pl-PL")} punktów · ${routeInfo.lines.toLocaleString("pl-PL")} wierszy NMEA · ${formatBytes(routeInfo.raw_bytes)} CSV · zlib DEFLATE · MTU ${routeInfo.mtu} · fragment ${routeInfo.chunk_bytes} B · okno ${routeInfo.window_chunks}/${routeInfo.inflight_chunks || "?"}`;
    setConnection("connected", "Połączono");
    setControls(true);
    log(`Gotowe: ${APP_VERSION}, surowy NMEA CSV przez NOTIFY`, "success");
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

if (!navigator.bluetooth || !window.DecompressionStream) els.browserWarning.hidden = false;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => log(`Service worker: ${error.message}`, "error"));
log(`Gotowe. PWA ${APP_VERSION}. Połącz urządzenie, aby uruchomić test trasy.`);
