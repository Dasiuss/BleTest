#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <stdlib.h>

// These UUIDs are also used by the PWA in web/app.js.
static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *MILLIS_CHARACTERISTIC_UUID = "7e6d0002-7b9e-4f5b-a6c2-320000000002";
static const char *RANDOM_CHARACTERISTIC_UUID = "7e6d0003-7b9e-4f5b-a6c2-320000000003";
static const char *COUNTER_CHARACTERISTIC_UUID = "7e6d0004-7b9e-4f5b-a6c2-320000000004";
static const char *NOTIFY_INTERVAL_CHARACTERISTIC_UUID = "7e6d0005-7b9e-4f5b-a6c2-320000000005";

BLECharacteristic *millisCharacteristic = nullptr;
BLECharacteristic *randomCharacteristic = nullptr;
BLECharacteristic *counterCharacteristic = nullptr;
BLECharacteristic *notifyIntervalCharacteristic = nullptr;
volatile bool deviceConnected = false;
volatile uint32_t notifyIntervalMs = 1000;
uint32_t lastNotification = 0;
int32_t counterValue = 0;

String makeMillisJson() {
  char json[48];
  snprintf(json, sizeof(json), "{\"millis\":%lu}", millis());
  return String(json);
}

String makeRandomJson() {
  char json[32];
  snprintf(json, sizeof(json), "{\"random\":%ld}", random(0, 1000000L));
  return String(json);
}

bool parseInteger(const String &raw, long &result) {
  String value = raw;
  value.trim();
  if (value.length() == 0) return false;

  char *end = nullptr;
  result = strtol(value.c_str(), &end, 10);
  return *end == '\0';
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
    Serial.println("[BLE] Klient polaczony");
  }

  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
    Serial.println("[BLE] Klient rozlaczony; ponawiam advertising");
    BLEDevice::startAdvertising();
  }
};

class MillisCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    String json = makeMillisJson();
    characteristic->setValue(json.c_str());
    Serial.printf("[BLE] READ  %s\n", json.c_str());
  }
};

class RandomCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    String json = makeRandomJson();
    characteristic->setValue(json.c_str());
    Serial.printf("[BLE] READ random %s\n", json.c_str());
  }
};

class CounterCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    int32_t value = counterValue++;
    char text[16];
    snprintf(text, sizeof(text), "%ld", (long)value);
    characteristic->setValue(text);
    Serial.printf("[BLE] READ counter %s\n", text);
  }

  void onWrite(BLECharacteristic *characteristic) override {
    String raw = characteristic->getValue().c_str();
    long value = 0;
    if (!parseInteger(raw, value)) {
      Serial.printf("[BLE] WRITE counter odrzucony: %s\n", raw.c_str());
      return;
    }

    counterValue = (int32_t)value;
    Serial.printf("[BLE] WRITE counter = %ld\n", value);
  }
};

class NotifyIntervalCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    String raw = characteristic->getValue().c_str();
    long seconds = 0;
    if (!parseInteger(raw, seconds) || seconds < 1 || seconds > 60) {
      Serial.printf("[BLE] WRITE notify interval odrzucony: %s (zakres 1-60)\n", raw.c_str());
      return;
    }

    notifyIntervalMs = (uint32_t)seconds * 1000UL;
    lastNotification = millis();
    Serial.printf("[BLE] WRITE notify interval = %ld s\n", seconds);
  }
};

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== BleTestEsp32 ===");
  Serial.println("[SYS] Start BLE server");
  randomSeed(micros());

  BLEDevice::init("BleTestEsp32");

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);
  millisCharacteristic = service->createCharacteristic(
      MILLIS_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  millisCharacteristic->addDescriptor(new BLE2902());
  millisCharacteristic->setCallbacks(new MillisCallbacks());
  millisCharacteristic->setValue(makeMillisJson().c_str());

  randomCharacteristic = service->createCharacteristic(
      RANDOM_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_READ);
  randomCharacteristic->setCallbacks(new RandomCallbacks());
  randomCharacteristic->setValue(makeRandomJson().c_str());

  counterCharacteristic = service->createCharacteristic(
      COUNTER_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
  counterCharacteristic->setCallbacks(new CounterCallbacks());
  counterCharacteristic->setValue("0");

  notifyIntervalCharacteristic = service->createCharacteristic(
      NOTIFY_INTERVAL_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_WRITE);
  notifyIntervalCharacteristic->setCallbacks(new NotifyIntervalCallbacks());
  notifyIntervalCharacteristic->setValue("1");

  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising: BleTestEsp32");
  Serial.printf("[BLE] Service: %s\n", SERVICE_UUID);
  Serial.printf("[BLE] Characteristic: %s\n", MILLIS_CHARACTERISTIC_UUID);
  Serial.printf("[BLE] Characteristic: %s (READ)\n", RANDOM_CHARACTERISTIC_UUID);
  Serial.printf("[BLE] Characteristic: %s (READ + WRITE)\n", COUNTER_CHARACTERISTIC_UUID);
  Serial.printf("[BLE] Characteristic: %s (WRITE, seconds)\n", NOTIFY_INTERVAL_CHARACTERISTIC_UUID);
  Serial.println("[SYS] Oczekiwanie na polaczenie...");
}

void loop() {
  uint32_t now = millis();

  if (deviceConnected && now - lastNotification >= notifyIntervalMs) {
    lastNotification = now;
    String json = makeMillisJson();
    millisCharacteristic->setValue(json.c_str());
    millisCharacteristic->notify();
    Serial.printf("[BLE] NOTIFY %s\n", json.c_str());
  }

  delay(10);
}
