#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "route_data.h"

static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
static const char *ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
static const char *ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";

static const uint16_t ROUTE_FRAME_SIZE = 244;
static const uint16_t ROUTE_FRAME_HEADER_SIZE = sizeof(uint32_t);
static const uint8_t ROUTE_NOTIFY_WINDOW_SIZE = 8;
static const uint32_t ROUTE_NOTIFY_INTERVAL_MS = 2;

BLECharacteristic *routeDataCharacteristic = nullptr;
BLEServer *bleServer = nullptr;
volatile bool deviceConnected = false;
volatile bool routeTransferActive = false;
volatile bool routeTransferComplete = false;
volatile bool routeAwaitingAck = false;
volatile uint8_t routeWindowSent = 0;
volatile uint32_t routeSourceOffset = 0;
volatile uint32_t routeOutputBytes = 0;
volatile uint32_t routeNextSequence = 0;
volatile uint32_t routeWindowEndSequence = 0;
uint32_t routeStartedAt = 0;
uint32_t routeLastNotifyAt = 0;
uint32_t routeCrc32 = 0;
uint16_t routePayloadSize = ROUTE_FRAME_SIZE - ROUTE_FRAME_HEADER_SIZE;
uint8_t routeNotifyBuffer[ROUTE_FRAME_SIZE];

uint32_t calculateRouteCrc32() {
  uint32_t crc = 0xFFFFFFFF;
  for (uint32_t index = 0; index < GPS_ROUTE_RAW_SIZE; index += 1) {
    crc ^= pgm_read_byte(GPS_ROUTE_CSV + index);
    for (uint8_t bit = 0; bit < 8; bit += 1) {
      crc = (crc >> 1) ^ (0xEDB88320 & (-(int32_t)(crc & 1)));
    }
  }
  return ~crc;
}

uint16_t currentRouteMtu() {
  if (bleServer == nullptr || !deviceConnected) return 23;
  return bleServer->getPeerMTU(bleServer->getConnId());
}

uint16_t currentRoutePayloadSize() {
  uint16_t mtu = currentRouteMtu();
  uint16_t attPayloadSize = mtu > 3 ? mtu - 3 : 20;
  uint16_t availablePayloadSize = attPayloadSize > ROUTE_FRAME_HEADER_SIZE
                                      ? (uint16_t)(attPayloadSize - ROUTE_FRAME_HEADER_SIZE)
                                      : (uint16_t)1;
  return min((uint16_t)(ROUTE_FRAME_SIZE - ROUTE_FRAME_HEADER_SIZE), availablePayloadSize);
}

String makeRouteInfoJson() {
  uint16_t mtu = currentRouteMtu();
  routePayloadSize = currentRoutePayloadSize();
  char json[256];
  snprintf(json, sizeof(json),
           "{\"encoding\":\"identity\",\"transport\":\"notify-v1\",\"format\":\"csv\",\"points\":%lu,\"raw_bytes\":%lu,\"crc32\":\"%08lX\",\"mtu\":%u,\"chunk_bytes\":%u,\"window_chunks\":%u,\"ready\":true,\"done\":%s,\"error\":false}",
           (unsigned long)GPS_ROUTE_POINT_COUNT,
           (unsigned long)GPS_ROUTE_RAW_SIZE,
           (unsigned long)routeCrc32,
           mtu,
           routePayloadSize,
           ROUTE_NOTIFY_WINDOW_SIZE,
           routeTransferComplete ? "true" : "false");
  return String(json);
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
    Serial.println("[BLE] Klient polaczony");
  }

  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
    routeTransferActive = false;
    routeAwaitingAck = false;
    Serial.println("[BLE] Klient rozlaczony; ponawiam advertising");
    BLEDevice::startAdvertising();
  }
};

class RouteInfoCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    String json = makeRouteInfoJson();
    characteristic->setValue(json.c_str());
  }
};

class RouteControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    String command = characteristic->getValue().c_str();
    command.trim();

    if (command == "START") {
      routeStartedAt = millis();
      routeLastNotifyAt = 0;
      routePayloadSize = currentRoutePayloadSize();
      routeSourceOffset = 0;
      routeOutputBytes = 0;
      routeNextSequence = 0;
      routeWindowEndSequence = 0;
      routeWindowSent = 0;
      routeAwaitingAck = false;
      routeTransferComplete = false;
      routeTransferActive = true;
      Serial.println("[BLE] ROUTE START (notify stream v1)");
      return;
    }

    if (command == "STOP") {
      routeTransferActive = false;
      routeAwaitingAck = false;
      Serial.println("[BLE] ROUTE STOP");
      return;
    }

    if (command.startsWith("ACK:")) {
      uint32_t acknowledgedSequence = strtoul(command.substring(4).c_str(), nullptr, 10);
      if (!routeTransferActive || acknowledgedSequence != routeWindowEndSequence) return;

      routeWindowSent = 0;
      routeAwaitingAck = false;
      if (routeSourceOffset >= GPS_ROUTE_RAW_SIZE) {
        routeTransferActive = false;
        routeTransferComplete = true;
        Serial.printf("[BLE] ROUTE complete: %lu bytes in %lu ms\n",
                      (unsigned long)routeOutputBytes,
                      (unsigned long)(millis() - routeStartedAt));
      }
      return;
    }

    if (command.startsWith("NACK:")) {
      uint32_t requestedSequence = strtoul(command.substring(5).c_str(), nullptr, 10);
      uint64_t requestedOffset = (uint64_t)requestedSequence * routePayloadSize;
      if (!routeTransferActive || requestedOffset > GPS_ROUTE_RAW_SIZE) return;

      routeSourceOffset = (uint32_t)requestedOffset;
      routeNextSequence = requestedSequence;
      routeWindowEndSequence = requestedSequence;
      routeWindowSent = 0;
      routeAwaitingAck = false;
      routeLastNotifyAt = 0;
      Serial.printf("[BLE] ROUTE retransmit from sequence %lu\n",
                    (unsigned long)requestedSequence);
      return;
    }

    Serial.printf("[BLE] ROUTE command odrzucony: %s\n", command.c_str());
  }
};

void pumpRouteNotifications() {
  if (!deviceConnected || !routeTransferActive || routeAwaitingAck || routeDataCharacteristic == nullptr) return;
  if (millis() - routeLastNotifyAt < ROUTE_NOTIFY_INTERVAL_MS) return;
  if (routeSourceOffset >= GPS_ROUTE_RAW_SIZE) {
    routeAwaitingAck = true;
    return;
  }

  uint32_t remaining = GPS_ROUTE_RAW_SIZE - routeSourceOffset;
  uint16_t payloadLength = remaining > routePayloadSize ? routePayloadSize : (uint16_t)remaining;
  uint32_t sequence = routeNextSequence;
  memcpy(routeNotifyBuffer, &sequence, sizeof(sequence));
  memcpy_P(routeNotifyBuffer + ROUTE_FRAME_HEADER_SIZE,
           GPS_ROUTE_CSV + routeSourceOffset,
           payloadLength);

  routeDataCharacteristic->setValue(routeNotifyBuffer, ROUTE_FRAME_HEADER_SIZE + payloadLength);
  routeDataCharacteristic->notify();
  routeLastNotifyAt = millis();
  routeSourceOffset += payloadLength;
  routeOutputBytes += payloadLength;
  routeNextSequence += 1;
  routeWindowEndSequence = routeNextSequence;
  routeWindowSent += 1;

  if (routeWindowSent >= ROUTE_NOTIFY_WINDOW_SIZE || routeSourceOffset >= GPS_ROUTE_RAW_SIZE) {
    routeAwaitingAck = true;
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== BleTestEsp32 GPS route test ===");
  Serial.println("[SYS] Start BLE server");
  routeCrc32 = calculateRouteCrc32();

  BLEDevice::init("BleTestEsp32");
  BLEDevice::setMTU(517);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  BLEService *service = bleServer->createService(SERVICE_UUID);
  BLECharacteristic *routeInfoCharacteristic = service->createCharacteristic(
      ROUTE_INFO_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_READ);
  routeInfoCharacteristic->setCallbacks(new RouteInfoCallbacks());
  routeInfoCharacteristic->setValue(makeRouteInfoJson().c_str());

  BLECharacteristic *routeControlCharacteristic = service->createCharacteristic(
      ROUTE_CONTROL_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_WRITE);
  routeControlCharacteristic->setCallbacks(new RouteControlCallbacks());

  routeDataCharacteristic = service->createCharacteristic(
      ROUTE_DATA_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  routeDataCharacteristic->addDescriptor(new BLE2902());

  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising: BleTestEsp32");
  Serial.printf("[BLE] Route source: %lu raw bytes, %lu points\n",
                (unsigned long)GPS_ROUTE_RAW_SIZE,
                (unsigned long)GPS_ROUTE_POINT_COUNT);
  Serial.printf("[BLE] Route CRC32: %08lX\n", (unsigned long)routeCrc32);
}

void loop() {
  pumpRouteNotifications();
  delay(1);
}
