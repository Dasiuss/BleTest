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
  els.routeReceived.textContent = `${formatBytes(routeReceivedBytes)} · ${routeFrameCount.toLocaleString("pl-PL")} NOTIFY`;
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
  if (payload.byteLength > routeInfo.chunk_bytes || routeReceivedBytes + payload.byteLength > routeInfo.raw_bytes) {
    rejectRouteTransfer(new Error("Nieprawidłowy rozmiar fragmentu trasy"));
    return;
  }

  if (!routeFileWriter) routeChunks.push(payload);
  updateRouteCrc32(payload);
  routeLineCount += new TextDecoder().decode(payload).split("\n").length - 1;
  routeReceivedBytes += payload.byteLength;
  routeFrameCount += 1;
  routeExpectedSequence += 1;
  updateRouteProgress();

  const finalFrame = routeReceivedBytes === routeInfo.raw_bytes;
  if (routeFileWriter) {
    routeStorageChain = routeStorageChain.then(() => routeFileWriter.write(payload));
  }
  const persisted = routeStorageChain;
  if (finalFrame || routeExpectedSequence % routeInfo.window_chunks === 0) {
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
  els.routeDownloadLink.textContent = `Pobierz CSV (${formatBytes(routeReceivedBytes)})`;
  els.routeStatus.textContent = `OK · ${elapsed.toFixed(2)} s`;
  els.routeOutput.textContent = [
    `Punkty: ${routeInfo.points.toLocaleString("pl-PL")}`,
    `Pakiety NOTIFY: ${routeFrameCount.toLocaleString("pl-PL")}`,
    `CRC32: ${receivedCrc32}`,
    `Surowy CSV: ${formatBytes(rawBytes)}`,
    `CSV: ${formatBytes(routeReceivedBytes)}`,
    `Transfer CSV: ${formatBytes(routeReceivedBytes / elapsed)}/s · ${(routeReceivedBytes * 8 / elapsed / 1000).toFixed(1)} kbit/s`,
    "",
    await routeBlob.slice(0, 512).text(),
  ].join("\n");
  log(`Transfer trasy zakończony: ${elapsed.toFixed(2)} s`, "success");
}

async function transferRoute() {
  if (!routeControlCharacteristic || !routeDataCharacteristic || routeTransferring) return;

  routeChunks = [];
  routeReceivedBytes = 0;
  routeFrameCount = 0;
  routeExpectedSequence = 0;
  routeRecoveryPending = false;
  routeCrc32 = 0xFFFFFFFF;
  routeLineCount = 0;
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
      els.routeOutput.textContent = `Odebrano ${formatBytes(routeReceivedBytes)}.`;
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
    log(`Transfer zatrzymany po ${formatBytes(routeReceivedBytes)}`);
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
    els.routeInfo.textContent = `${routeInfo.points.toLocaleString("pl-PL")} punktów · ${formatBytes(routeInfo.raw_bytes)} CSV · MTU ${routeInfo.mtu} · fragment ${routeInfo.chunk_bytes} B`;
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
