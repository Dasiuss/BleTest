#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <rom/miniz.h>

#include "route_data.h"

static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
static const char *ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
static const char *ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";

static const uint16_t ROUTE_MAX_CHUNK_SIZE = 244;
static const uint16_t ROUTE_INPUT_BUFFER_SIZE = 256;

BLECharacteristic *routeDataCharacteristic = nullptr;
BLEServer *bleServer = nullptr;
volatile bool deviceConnected = false;
bool routeTransferActive = false;
bool routeCompressionFinished = false;
bool routeCompressionFailed = false;
tdefl_compressor routeCompressor;
uint8_t routeInputBuffer[ROUTE_INPUT_BUFFER_SIZE];
uint32_t routeSourceOffset = 0;
uint16_t routeInputLength = 0;
uint16_t routeInputOffset = 0;
uint32_t routeOutputBytes = 0;
uint32_t routeStartedAt = 0;
uint16_t routeChunkSize = 20;

uint16_t currentRouteMtu() {
  if (bleServer == nullptr || !deviceConnected) return 23;
  return bleServer->getPeerMTU(bleServer->getConnId());
}

String makeRouteInfoJson() {
  uint16_t mtu = currentRouteMtu();
  routeChunkSize = mtu >= 23 ? min((uint16_t)(mtu - 3), ROUTE_MAX_CHUNK_SIZE) : 20;
  char json[192];
  snprintf(json, sizeof(json),
           "{\"encoding\":\"zlib-deflate\",\"format\":\"csv\",\"points\":%lu,\"raw_bytes\":%lu,\"mtu\":%u,\"chunk_bytes\":%u}",
           (unsigned long)GPS_ROUTE_POINT_COUNT,
           (unsigned long)GPS_ROUTE_RAW_SIZE,
           mtu,
           routeChunkSize);
  return String(json);
}

void resetRouteCompressor() {
  routeSourceOffset = 0;
  routeInputLength = 0;
  routeInputOffset = 0;
  routeOutputBytes = 0;
  routeCompressionFinished = false;
  routeCompressionFailed = false;
  int flags = TDEFL_DEFAULT_MAX_PROBES | TDEFL_WRITE_ZLIB_HEADER | TDEFL_COMPUTE_ADLER32;
  if (tdefl_init(&routeCompressor, nullptr, nullptr, flags) != TDEFL_STATUS_OKAY) {
    routeCompressionFailed = true;
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

uint16_t makeRouteChunk(uint8_t *output) {
  uint8_t outputLength = 0;
  while (outputLength == 0 && !routeCompressionFinished && !routeCompressionFailed) {
    if (routeInputOffset >= routeInputLength && !refillRouteInput()) {
      size_t inputSize = 0;
      size_t availableOutput = routeChunkSize;
      tdefl_status status = tdefl_compress(
          &routeCompressor, routeInputBuffer, &inputSize, output, &availableOutput, TDEFL_FINISH);
      outputLength = (uint8_t)availableOutput;
      if (status == TDEFL_STATUS_DONE) routeCompressionFinished = true;
      if (status == TDEFL_STATUS_BAD_PARAM || status == TDEFL_STATUS_PUT_BUF_FAILED) routeCompressionFailed = true;
    } else {
      size_t inputSize = routeInputLength - routeInputOffset;
      size_t availableOutput = routeChunkSize;
      tdefl_status status = tdefl_compress(
          &routeCompressor,
          routeInputBuffer + routeInputOffset,
          &inputSize,
          output,
          &availableOutput,
          TDEFL_NO_FLUSH);
      routeInputOffset += (uint16_t)inputSize;
      outputLength = (uint8_t)availableOutput;
      if (status == TDEFL_STATUS_BAD_PARAM || status == TDEFL_STATUS_PUT_BUF_FAILED) routeCompressionFailed = true;
    }
  }
  routeOutputBytes += outputLength;
  return outputLength;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
    Serial.println("[BLE] Klient polaczony");
  }

  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
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
      resetRouteCompressor();
      routeStartedAt = millis();
      routeTransferActive = !routeCompressionFailed;
      Serial.println("[BLE] ROUTE START (miniz zlib stream)");
    } else if (command == "STOP") {
      routeTransferActive = false;
      Serial.println("[BLE] ROUTE STOP");
    } else {
      Serial.printf("[BLE] ROUTE command odrzucony: %s\n", command.c_str());
    }
  }
};

class RouteDataCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    if (!routeTransferActive) {
      characteristic->setValue("");
      return;
    }

    uint8_t chunk[ROUTE_MAX_CHUNK_SIZE];
    uint16_t mtu = currentRouteMtu();
    routeChunkSize = mtu >= 23 ? min((uint16_t)(mtu - 3), ROUTE_MAX_CHUNK_SIZE) : 20;
    uint16_t chunkSize = makeRouteChunk(chunk);
    characteristic->setValue(chunk, chunkSize);

    if (chunkSize == 0) {
      routeTransferActive = false;
      Serial.printf("[BLE] ROUTE READ complete: %lu bytes in %lu ms\n",
                    (unsigned long)routeOutputBytes,
                    (unsigned long)(millis() - routeStartedAt));
    }
  }
};

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== BleTestEsp32 GPS route test ===");
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
      ROUTE_DATA_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_READ);
  routeDataCharacteristic->setCallbacks(new RouteDataCallbacks());

  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising: BleTestEsp32");
  Serial.printf("[BLE] Route source: %lu raw bytes, %lu points\n",
                (unsigned long)GPS_ROUTE_RAW_SIZE,
                (unsigned long)GPS_ROUTE_POINT_COUNT);
}

void loop() {
  delay(10);
}
