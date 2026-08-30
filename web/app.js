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
let routeReadCount = 0;
let routeStartedAt = 0;
let routeTransferring = false;
let routeStopRequested = false;
let routeDownloadUrl = null;

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
  els.routeReceived.textContent = `${formatBytes(routeReceivedBytes)} · ${routeReadCount.toLocaleString("pl-PL")} READ`;
  els.routeRate.textContent = elapsed > 0 ? `${formatBytes(rate)}/s · ${(rate * 8 / 1000).toFixed(1)} kbit/s` : "---";
}

async function finishRouteTransfer() {
  const elapsed = (performance.now() - routeStartedAt) / 1000;
  const compressedBlob = new Blob(routeChunks, { type: "application/zlib" });
  if (!("DecompressionStream" in window)) throw new Error("Przeglądarka nie obsługuje DecompressionStream");
  const rawText = await new Response(
    compressedBlob.stream().pipeThrough(new DecompressionStream("deflate"))
  ).text();
  const rawBytes = new TextEncoder().encode(rawText).byteLength;
  const pointCount = rawText.split("\n").filter(Boolean).length - 1;
  if (rawBytes !== routeInfo.raw_bytes || pointCount !== routeInfo.points) {
    throw new Error(`Walidacja CSV nie powiodła się: ${pointCount} punktów, ${rawBytes} bajtów`);
  }
  const compression = routeInfo.raw_bytes / routeReceivedBytes;

  if (routeDownloadUrl) URL.revokeObjectURL(routeDownloadUrl);
  routeDownloadUrl = URL.createObjectURL(compressedBlob);
  els.routeDownloadLink.href = routeDownloadUrl;
  els.routeDownloadLink.hidden = false;
  els.routeDownloadLink.textContent = `Pobierz zlib (${formatBytes(routeReceivedBytes)})`;
  els.routeStatus.textContent = `OK · ${elapsed.toFixed(2)} s`;
  els.routeOutput.textContent = [
    `Punkty: ${routeInfo.points.toLocaleString("pl-PL")}`,
    `Odczyty READ: ${routeReadCount.toLocaleString("pl-PL")}`,
    `Surowy CSV: ${formatBytes(rawBytes)}`,
    `Zlib: ${formatBytes(routeReceivedBytes)} · kompresja ${compression.toFixed(1)}x`,
    `Transfer zlib: ${formatBytes(routeReceivedBytes / elapsed)}/s · ${(routeReceivedBytes * 8 / elapsed / 1000).toFixed(1)} kbit/s`,
    `Transfer efektywny CSV: ${formatBytes(rawBytes / elapsed)}/s`,
    "",
    rawText.split("\n").slice(0, 3).join("\n"),
  ].join("\n");
  log(`Transfer trasy zakończony: ${elapsed.toFixed(2)} s`, "success");
}

async function transferRoute() {
  if (!routeControlCharacteristic || !routeDataCharacteristic || routeTransferring) return;

  routeChunks = [];
  routeReceivedBytes = 0;
  routeReadCount = 0;
  routeStartedAt = performance.now();
  routeTransferring = true;
  routeStopRequested = false;
  els.routeStatus.textContent = "Pobieranie...";
  els.routeOutput.textContent = "Urządzenie kompresuje trasę podczas odczytu...";
  els.routeDownloadLink.hidden = true;
  setControls(true);

  try {
    await routeControlCharacteristic.writeValue(new TextEncoder().encode("START"));
    while (true) {
      const value = await routeDataCharacteristic.readValue();
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      if (chunk.byteLength === 0) break;
      routeChunks.push(chunk);
      routeReceivedBytes += chunk.byteLength;
      routeReadCount += 1;
      updateRouteProgress();
    }
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
    routeTransferring = false;
    routeStopRequested = false;
    setControls(Boolean(routeDataCharacteristic));
  }
}

async function stopRouteTransfer() {
  if (!routeControlCharacteristic || !routeTransferring) return;
  routeStopRequested = true;
  try {
    await routeControlCharacteristic.writeValue(new TextEncoder().encode("STOP"));
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
    routeInfo = JSON.parse(decodeValue(await routeInfoCharacteristic.readValue()));
    els.routeInfo.textContent = `${routeInfo.points.toLocaleString("pl-PL")} punktów · ${formatBytes(routeInfo.raw_bytes)} CSV · MTU ${routeInfo.mtu} · fragment ${routeInfo.chunk_bytes} B`;
    setConnection("connected", "Połączono");
    setControls(true);
    log("Gotowe: trasa jest pobierana przez serię READ", "success");
  } catch (error) {
    log(`Połączenie nie powiodło się: ${error.message}`, "error");
    setConnection("error", "Błąd połączenia");
    cleanupConnection();
  }
}

function cleanupConnection() {
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
