#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// These UUIDs are also used by the PWA in web/app.js.
static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *MILLIS_CHARACTERISTIC_UUID = "7e6d0002-7b9e-4f5b-a6c2-320000000002";

BLECharacteristic *millisCharacteristic = nullptr;
volatile bool deviceConnected = false;
unsigned long lastNotification = 0;

String makeMillisJson() {
  char json[48];
  snprintf(json, sizeof(json), "{\"millis\":%lu}", millis());
  return String(json);
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

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== BleTestEsp32 ===");
  Serial.println("[SYS] Start BLE server");

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
  Serial.println("[SYS] Oczekiwanie na polaczenie...");
}

void loop() {
  unsigned long now = millis();

  if (deviceConnected && now - lastNotification >= 1000) {
    lastNotification = now;
    String json = makeMillisJson();
    millisCharacteristic->setValue(json.c_str());
    millisCharacteristic->notify();
    Serial.printf("[BLE] NOTIFY %s\n", json.c_str());
  }

  delay(10);
}
