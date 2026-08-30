const SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
const MILLIS_CHARACTERISTIC_UUID = "7e6d0002-7b9e-4f5b-a6c2-320000000002";
const RANDOM_CHARACTERISTIC_UUID = "7e6d0003-7b9e-4f5b-a6c2-320000000003";
const COUNTER_CHARACTERISTIC_UUID = "7e6d0004-7b9e-4f5b-a6c2-320000000004";
const NOTIFY_INTERVAL_CHARACTERISTIC_UUID = "7e6d0005-7b9e-4f5b-a6c2-320000000005";

const $ = (id) => document.getElementById(id);
const els = {
  browserWarning: $("browserWarning"),
  connectionBadge: $("connectionBadge"),
  connectionText: $("connectionText"),
  connectButton: $("connectButton"),
  readButton: $("readButton"),
  notifyButton: $("notifyButton"),
  disconnectButton: $("disconnectButton"),
  decreaseIntervalButton: $("decreaseIntervalButton"),
  increaseIntervalButton: $("increaseIntervalButton"),
  notifyIntervalValue: $("notifyIntervalValue"),
  millisValue: $("millisValue"),
  millisTime: $("millisTime"),
  readCount: $("readCount"),
  notifyCount: $("notifyCount"),
  jsonOutput: $("jsonOutput"),
  dataOrigin: $("dataOrigin"),
  deviceName: $("deviceName"),
  randomReadButton: $("randomReadButton"),
  counterReadButton: $("counterReadButton"),
  counterWriteButton: $("counterWriteButton"),
  counterInput: $("counterInput"),
  auxiliaryOutput: $("auxiliaryOutput"),
  eventLog: $("eventLog"),
  clearLogButton: $("clearLogButton"),
  steps: [$("stepDevice"), $("stepService"), $("stepCharacteristic"), $("stepData")],
};

let device = null;
let characteristic = null;
let randomCharacteristic = null;
let counterCharacteristic = null;
let notifyIntervalCharacteristic = null;
let readTotal = 0;
let notificationTotal = 0;
let notificationsEnabled = false;
let notifyIntervalSeconds = 1;

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

function setStep(index, state = "complete") {
  els.steps[index].classList.remove("active", "complete");
  els.steps[index].classList.add(state);
}

function resetSteps() {
  els.steps.forEach((step) => step.classList.remove("active", "complete"));
}

function setControls(connected) {
  els.connectButton.disabled = connected;
  els.readButton.disabled = !connected;
  els.notifyButton.disabled = !connected;
  els.disconnectButton.disabled = !connected;
  els.randomReadButton.disabled = !connected;
  els.counterReadButton.disabled = !connected;
  els.counterWriteButton.disabled = !connected;
  els.decreaseIntervalButton.disabled = !connected || notifyIntervalSeconds <= 1;
  els.increaseIntervalButton.disabled = !connected || notifyIntervalSeconds >= 60;
  els.notifyButton.textContent = notificationsEnabled ? "Wyłącz powiadomienia" : "Włącz powiadomienia";
}

function decodeValue(dataView) {
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  return new TextDecoder().decode(bytes);
}

function characteristicProperties(remoteCharacteristic) {
  const properties = [
    ["read", "READ"],
    ["write", "WRITE"],
    ["writeWithoutResponse", "WRITE WITHOUT RESPONSE"],
    ["notify", "NOTIFY"],
    ["indicate", "INDICATE"],
  ];
  return properties.filter(([key]) => remoteCharacteristic.properties[key]).map(([, label]) => label).join(" + ");
}

function displayAuxiliary(raw, origin) {
  let value = raw;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    // Counter returns a plain integer instead of JSON.
  }
  els.auxiliaryOutput.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  log(`${origin}: ${raw}`, "data");
}

function displayData(raw, origin) {
  let packet;
  try {
    packet = JSON.parse(raw);
  } catch (error) {
    log(`Nieprawidłowy JSON: ${raw}`, "error");
    return;
  }

  if (typeof packet.millis !== "number") {
    log("JSON nie zawiera liczbowego pola millis", "error");
    return;
  }

  els.millisValue.textContent = packet.millis.toLocaleString("pl-PL");
  els.millisTime.textContent = `${origin} · ${new Date().toLocaleTimeString("pl-PL", { hour12: false })}`;
  els.jsonOutput.textContent = JSON.stringify(packet, null, 2);
  els.dataOrigin.textContent = origin;
  els.steps[3].classList.add("complete");
  log(`${origin}: ${raw}`, "data");
}

function handleNotification(event) {
  notificationTotal += 1;
  els.notifyCount.textContent = notificationTotal;
  displayData(decodeValue(event.target.value), "NOTIFY");
}

async function readMillis() {
  if (!characteristic) return;
  try {
    log("Odczyt READ charakterystyki...");
    const value = await characteristic.readValue();
    readTotal += 1;
    els.readCount.textContent = readTotal;
    displayData(decodeValue(value), "READ");
    log("Odczyt READ zakończony", "success");
  } catch (error) {
    log(`READ nie powiódł się: ${error.message}`, "error");
  }
}

async function readRandom() {
  if (!randomCharacteristic) return;
  try {
    log("Odczyt READ random...");
    const value = await randomCharacteristic.readValue();
    displayAuxiliary(decodeValue(value), "READ random");
    log("Odczyt READ random zakończony", "success");
  } catch (error) {
    log(`READ random nie powiódł się: ${error.message}`, "error");
  }
}

async function readCounter() {
  if (!counterCharacteristic) return;
  try {
    log("Odczyt READ counter...");
    const value = await counterCharacteristic.readValue();
    const raw = decodeValue(value);
    els.counterInput.value = raw;
    displayAuxiliary(raw, "READ counter");
    log("Odczyt READ counter zakończony", "success");
  } catch (error) {
    log(`READ counter nie powiódł się: ${error.message}`, "error");
  }
}

async function writeCounter() {
  if (!counterCharacteristic) return;
  const value = els.counterInput.value.trim();
  if (!/^-?\d+$/.test(value)) {
    log("WRITE counter wymaga liczby całkowitej", "error");
    return;
  }

  try {
    log(`Zapis WRITE counter = ${value}...`);
    await counterCharacteristic.writeValue(new TextEncoder().encode(value));
    log(`WRITE counter zakończony: ${value}`, "success");
  } catch (error) {
    log(`WRITE counter nie powiódł się: ${error.message}`, "error");
  }
}

async function writeNotifyInterval() {
  if (!notifyIntervalCharacteristic) return;
  try {
    const value = String(notifyIntervalSeconds);
    log(`Zapis WRITE notify interval = ${value} s...`);
    await notifyIntervalCharacteristic.writeValue(new TextEncoder().encode(value));
    log(`Interwał NOTIFY ustawiony na ${value} s`, "success");
  } catch (error) {
    log(`WRITE notify interval nie powiódł się: ${error.message}`, "error");
  }
}

function changeNotifyInterval(delta) {
  notifyIntervalSeconds = Math.min(60, Math.max(1, notifyIntervalSeconds + delta));
  els.notifyIntervalValue.textContent = `${notifyIntervalSeconds} s`;
  setControls(Boolean(characteristic));
  void writeNotifyInterval();
}

async function toggleNotifications() {
  if (!characteristic) return;
  try {
    if (notificationsEnabled) {
      await characteristic.stopNotifications();
      notificationsEnabled = false;
      characteristic.removeEventListener("characteristicvaluechanged", handleNotification);
      log("Powiadomienia NOTIFY wyłączone");
    } else {
      await characteristic.startNotifications();
      notificationsEnabled = true;
      characteristic.addEventListener("characteristicvaluechanged", handleNotification);
      log("Powiadomienia NOTIFY włączone", "success");
    }
    setControls(true);
  } catch (error) {
    log(`Zmiana NOTIFY nie powiodła się: ${error.message}`, "error");
  }
}

async function connect() {
  if (!navigator.bluetooth) {
    log("Ta przeglądarka nie udostępnia Web Bluetooth", "error");
    return;
  }

  try {
    setConnection("busy", "Wybierz urządzenie");
    resetSteps();
    log("Otwieram wybór urządzenia BLE...");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", handleDisconnect);
    els.deviceName.textContent = device.name || "Bez nazwy";
    setStep(0);
    log(`Wybrano: ${device.name || "urządzenie BLE"}`, "success");

    setConnection("busy", "Łączenie GATT");
    const server = await device.gatt.connect();
    log("Połączono z serwerem GATT", "success");
    const service = await server.getPrimaryService(SERVICE_UUID);
    setStep(1);
    log(`Discovery: usługa GATT ${service.uuid}`, "success");
    const discoveredCharacteristics = await service.getCharacteristics();
    log(`Discovery: znaleziono ${discoveredCharacteristics.length} charakterystyk`);
    discoveredCharacteristics.forEach((remoteCharacteristic) => {
      log(`Discovery: ${remoteCharacteristic.uuid} [${characteristicProperties(remoteCharacteristic)}]`);
    });

    characteristic = await service.getCharacteristic(MILLIS_CHARACTERISTIC_UUID);
    randomCharacteristic = await service.getCharacteristic(RANDOM_CHARACTERISTIC_UUID);
    counterCharacteristic = await service.getCharacteristic(COUNTER_CHARACTERISTIC_UUID);
    notifyIntervalCharacteristic = await service.getCharacteristic(NOTIFY_INTERVAL_CHARACTERISTIC_UUID);
    setStep(2);
    characteristic.addEventListener("characteristicvaluechanged", handleNotification);
    setConnection("connected", "Połączono");
    setControls(true);
    log("Znaleziono charakterystyki millis, random, counter i notify interval", "success");
    log("NOTIFY pozostaje wyłączone do ręcznego włączenia");
    await readMillis();
  } catch (error) {
    log(`Połączenie nie powiodło się: ${error.message}`, "error");
    setConnection("error", "Błąd połączenia");
    cleanupConnection();
  }
}

function cleanupConnection() {
  if (characteristic) characteristic.removeEventListener("characteristicvaluechanged", handleNotification);
  characteristic = null;
  randomCharacteristic = null;
  counterCharacteristic = null;
  notifyIntervalCharacteristic = null;
  notificationsEnabled = false;
  setControls(false);
  resetSteps();
}

function handleDisconnect() {
  log("ESP32 rozłączył połączenie", "error");
  setConnection("idle", "Rozłączono");
  cleanupConnection();
}

async function disconnect() {
  try {
    if (characteristic && notificationsEnabled) await characteristic.stopNotifications();
  } catch (error) {
    log(`Nie udało się zatrzymać NOTIFY: ${error.message}`, "error");
  }
  if (device?.gatt?.connected) device.gatt.disconnect();
  setConnection("idle", "Rozłączono");
  log("Rozłączono ręcznie");
  cleanupConnection();
}

els.connectButton.addEventListener("click", connect);
els.readButton.addEventListener("click", readMillis);
els.notifyButton.addEventListener("click", toggleNotifications);
els.disconnectButton.addEventListener("click", disconnect);
els.decreaseIntervalButton.addEventListener("click", () => changeNotifyInterval(-1));
els.increaseIntervalButton.addEventListener("click", () => changeNotifyInterval(1));
els.randomReadButton.addEventListener("click", readRandom);
els.counterReadButton.addEventListener("click", readCounter);
els.counterWriteButton.addEventListener("click", writeCounter);
els.clearLogButton.addEventListener("click", () => { els.eventLog.replaceChildren(); });

if (!navigator.bluetooth) els.browserWarning.hidden = false;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => log(`Service worker: ${error.message}`, "error"));
log("Gotowe. Naciśnij „Połącz i pobierz”.");
