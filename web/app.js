const SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
const MILLIS_CHARACTERISTIC_UUID = "7e6d0002-7b9e-4f5b-a6c2-320000000002";

const $ = (id) => document.getElementById(id);
const els = {
  browserWarning: $("browserWarning"),
  connectionBadge: $("connectionBadge"),
  connectionText: $("connectionText"),
  connectButton: $("connectButton"),
  readButton: $("readButton"),
  notifyButton: $("notifyButton"),
  disconnectButton: $("disconnectButton"),
  millisValue: $("millisValue"),
  millisTime: $("millisTime"),
  readCount: $("readCount"),
  notifyCount: $("notifyCount"),
  jsonOutput: $("jsonOutput"),
  dataOrigin: $("dataOrigin"),
  deviceName: $("deviceName"),
  eventLog: $("eventLog"),
  clearLogButton: $("clearLogButton"),
  steps: [$("stepDevice"), $("stepService"), $("stepCharacteristic"), $("stepData")],
};

let device = null;
let characteristic = null;
let readTotal = 0;
let notificationTotal = 0;
let notificationsEnabled = false;

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
  els.notifyButton.textContent = notificationsEnabled ? "Wyłącz powiadomienia" : "Włącz powiadomienia";
}

function decodeValue(dataView) {
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  return new TextDecoder().decode(bytes);
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
    log("Znaleziono usługę GATT", "success");
    characteristic = await service.getCharacteristic(MILLIS_CHARACTERISTIC_UUID);
    setStep(2);
    characteristic.addEventListener("characteristicvaluechanged", handleNotification);
    setConnection("connected", "Połączono");
    setControls(true);
    log("Znaleziono charakterystykę millis (READ + NOTIFY)", "success");

    await characteristic.startNotifications();
    notificationsEnabled = true;
    setControls(true);
    log("Powiadomienia NOTIFY włączone automatycznie", "success");
    await readMillis();
  } catch (error) {
    log(`Połączenie nie powiodło się: ${error.message}`, "error");
    setConnection("error", "Błąd połączenia");
    cleanupConnection();
  }
}

function cleanupConnection() {
  characteristic = null;
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
els.clearLogButton.addEventListener("click", () => { els.eventLog.replaceChildren(); });

if (!navigator.bluetooth) els.browserWarning.hidden = false;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => log(`Service worker: ${error.message}`, "error"));
log("Gotowe. Naciśnij „Połącz i pobierz”.");
