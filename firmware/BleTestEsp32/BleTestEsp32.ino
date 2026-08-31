#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "miniz.h"
#include "route_data.h"

static const char *FIRMWARE_VERSION = "v2";
static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
static const char *ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
static const char *ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";

static const uint16_t ROUTE_MAX_FRAME_SIZE = 244;
static const uint8_t ROUTE_FRAME_HEADER_SIZE = sizeof(uint32_t);
static const uint16_t ROUTE_INPUT_BUFFER_SIZE = 512;
static const uint32_t ROUTE_NOTIFY_INTERVAL_MS = 1;

BLECharacteristic *routeDataCharacteristic = nullptr;
BLEServer *bleServer = nullptr;
volatile bool deviceConnected = false;
volatile bool routeStartRequested = false;
volatile bool routeTransferActive = false;
volatile bool routeTransferComplete = false;
volatile bool routeTransferFailed = false;

tdefl_compressor routeCompressor;
uint8_t routeInputBuffer[ROUTE_INPUT_BUFFER_SIZE];
uint8_t routeNotifyBuffer[ROUTE_MAX_FRAME_SIZE];
uint32_t routeSourceOffset = 0;
uint16_t routeInputLength = 0;
uint16_t routeInputOffset = 0;
uint32_t routeCompressedBytes = 0;
uint32_t routeNotifyCount = 0;
uint32_t routeNextSequence = 0;
uint32_t routeStartedAt = 0;
uint32_t routeLastNotifyAt = 0;
uint16_t routePayloadSize = ROUTE_MAX_FRAME_SIZE - ROUTE_FRAME_HEADER_SIZE;
bool routeInputExhausted = false;
bool routeCompressionFinished = false;
bool routeEndMarkerSent = false;

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
  return min((uint16_t)(ROUTE_MAX_FRAME_SIZE - ROUTE_FRAME_HEADER_SIZE), availablePayloadSize);
}

String makeRouteInfoJson() {
  uint16_t mtu = currentRouteMtu();
  routePayloadSize = currentRoutePayloadSize();
  char json[384];
  snprintf(json, sizeof(json),
           "{\"version\":\"%s\",\"encoding\":\"zlib-deflate\",\"transport\":\"notify-v2\",\"format\":\"nmea-csv\",\"points\":%lu,\"lines\":%lu,\"raw_bytes\":%lu,\"compressed_bytes\":%lu,\"crc32\":\"%08lX\",\"mtu\":%u,\"chunk_bytes\":%u,\"done\":%s,\"error\":%s}",
           FIRMWARE_VERSION,
           (unsigned long)GPS_ROUTE_POINT_COUNT,
           (unsigned long)GPS_ROUTE_LINE_COUNT,
           (unsigned long)GPS_ROUTE_RAW_SIZE,
           (unsigned long)routeCompressedBytes,
           (unsigned long)GPS_ROUTE_CRC32,
           mtu,
           routePayloadSize,
           routeTransferComplete ? "true" : "false",
           routeTransferFailed ? "true" : "false");
  return String(json);
}

void resetRouteCompression() {
  routeSourceOffset = 0;
  routeInputLength = 0;
  routeInputOffset = 0;
  routeCompressedBytes = 0;
  routeNotifyCount = 0;
  routeNextSequence = 0;
  routePayloadSize = currentRoutePayloadSize();
  routeInputExhausted = false;
  routeCompressionFinished = false;
  routeEndMarkerSent = false;
  routeTransferComplete = false;
  routeTransferFailed = false;

  int flags = TDEFL_DEFAULT_MAX_PROBES | TDEFL_WRITE_ZLIB_HEADER | TDEFL_COMPUTE_ADLER32;
  if (tdefl_init(&routeCompressor, nullptr, nullptr, flags) != TDEFL_STATUS_OKAY) {
    routeTransferFailed = true;
  }
}

bool refillRouteInput() {
  if (routeSourceOffset >= GPS_ROUTE_RAW_SIZE) return false;
  uint32_t remaining = GPS_ROUTE_RAW_SIZE - routeSourceOffset;
  routeInputLength = remaining > ROUTE_INPUT_BUFFER_SIZE ? ROUTE_INPUT_BUFFER_SIZE : (uint16_t)remaining;
  memcpy_P(routeInputBuffer, GPS_ROUTE_CSV + routeSourceOffset, routeInputLength);
  routeSourceOffset += routeInputLength;
  routeInputOffset = 0;
  return true;
}

uint16_t makeRoutePayload(uint8_t *output) {
  if (routeCompressionFinished) return 0;

  while (!routeTransferFailed) {
    if (routeInputOffset < routeInputLength) {
      size_t inputSize = routeInputLength - routeInputOffset;
      size_t outputSize = routePayloadSize;
      tdefl_status status = tdefl_compress(
          &routeCompressor,
          routeInputBuffer + routeInputOffset,
          &inputSize,
          output,
          &outputSize,
          TDEFL_NO_FLUSH);
      routeInputOffset += (uint16_t)inputSize;
      if (status == TDEFL_STATUS_BAD_PARAM || status == TDEFL_STATUS_PUT_BUF_FAILED ||
          (inputSize == 0 && outputSize == 0)) {
        routeTransferFailed = true;
        return 0;
      }
      if (outputSize > 0) return (uint16_t)outputSize;
      continue;
    }

    if (!routeInputExhausted) {
      routeInputExhausted = !refillRouteInput();
      continue;
    }

    size_t inputSize = 0;
    size_t outputSize = routePayloadSize;
    tdefl_status status = tdefl_compress(
        &routeCompressor,
        nullptr,
        &inputSize,
        output,
        &outputSize,
        TDEFL_FINISH);
    if (status == TDEFL_STATUS_BAD_PARAM || status == TDEFL_STATUS_PUT_BUF_FAILED) {
      routeTransferFailed = true;
      return 0;
    }
    if (status == TDEFL_STATUS_DONE) routeCompressionFinished = true;
    if (outputSize > 0) return (uint16_t)outputSize;
    if (routeCompressionFinished) return 0;
  }
  return 0;
}

void sendRouteFrame(uint16_t payloadLength) {
  memcpy(routeNotifyBuffer, &routeNextSequence, ROUTE_FRAME_HEADER_SIZE);
  routeDataCharacteristic->setValue(routeNotifyBuffer, ROUTE_FRAME_HEADER_SIZE + payloadLength);
  routeDataCharacteristic->notify();
  routeNextSequence += 1;
  routeNotifyCount += 1;
  routeLastNotifyAt = millis();
}

void pumpRouteNotifications() {
  if (!deviceConnected || !routeTransferActive || routeDataCharacteristic == nullptr) return;
  if (millis() - routeLastNotifyAt < ROUTE_NOTIFY_INTERVAL_MS) return;

  uint16_t payloadLength = makeRoutePayload(routeNotifyBuffer + ROUTE_FRAME_HEADER_SIZE);
  if (routeTransferFailed) {
    routeTransferActive = false;
    Serial.println("[BLE] ROUTE compression failed");
    return;
  }

  if (payloadLength > 0) {
    sendRouteFrame(payloadLength);
    routeCompressedBytes += payloadLength;
    return;
  }

  if (routeCompressionFinished && !routeEndMarkerSent) {
    sendRouteFrame(0);
    routeEndMarkerSent = true;
    routeTransferActive = false;
    routeTransferComplete = true;
    Serial.printf("[BLE] ROUTE v2 complete: %lu compressed bytes in %lu ms, %lu NOTIFY\n",
                  (unsigned long)routeCompressedBytes,
                  (unsigned long)(millis() - routeStartedAt),
                  (unsigned long)routeNotifyCount);
  }
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
    Serial.println("[BLE] Klient polaczony");
  }

  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
    routeStartRequested = false;
    routeTransferActive = false;
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
      routeStartRequested = true;
      routeTransferActive = false;
      routeTransferComplete = false;
      routeTransferFailed = false;
      Serial.println("[BLE] ROUTE START request queued (v2)");
      return;
    }

    if (command == "STOP") {
      routeStartRequested = false;
      routeTransferActive = false;
      Serial.println("[BLE] ROUTE STOP");
      return;
    }

    Serial.printf("[BLE] ROUTE command odrzucony: %s\n", command.c_str());
  }
};

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.printf("=== BleTestEsp32 GPS route test %s ===\n", FIRMWARE_VERSION);
  Serial.println("[SYS] Start BLE server");

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

  Serial.printf("[BLE] Firmware version: %s\n", FIRMWARE_VERSION);
  Serial.println("[BLE] Advertising: BleTestEsp32");
  Serial.printf("[BLE] Route source: %lu raw bytes, %lu points, %lu NMEA lines\n",
                (unsigned long)GPS_ROUTE_RAW_SIZE,
                (unsigned long)GPS_ROUTE_POINT_COUNT,
                (unsigned long)GPS_ROUTE_LINE_COUNT);
  Serial.printf("[BLE] Route CRC32: %08lX\n", (unsigned long)GPS_ROUTE_CRC32);
}

void loop() {
  if (routeStartRequested) {
    routeStartRequested = false;
    routeStartedAt = millis();
    routeLastNotifyAt = 0;
    resetRouteCompression();
    routeTransferActive = !routeTransferFailed;
    Serial.println("[BLE] ROUTE v2 compression started in loop (zlib-deflate)");
  }

  pumpRouteNotifications();
  delay(1);
}
