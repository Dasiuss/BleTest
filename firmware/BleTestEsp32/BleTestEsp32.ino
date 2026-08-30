#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include "miniz.h"

#include "route_data.h"

static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
static const char *ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
static const char *ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";

static const uint16_t ROUTE_MAX_CHUNK_SIZE = 244;
static const uint16_t ROUTE_INPUT_BUFFER_SIZE = 256;
static const uint8_t ROUTE_QUEUE_LENGTH = 8;

struct RouteChunk {
  uint16_t length;
  uint8_t data[ROUTE_MAX_CHUNK_SIZE];
};

BLECharacteristic *routeDataCharacteristic = nullptr;
BLEServer *bleServer = nullptr;
volatile bool deviceConnected = false;
volatile bool routeTransferActive = false;
volatile bool routeCompressionRequested = false;
volatile bool routeCompressionReady = false;
volatile bool routeCompressionDone = false;
volatile bool routeCompressionFailed = false;
tdefl_compressor routeCompressor;
uint8_t routeInputBuffer[ROUTE_INPUT_BUFFER_SIZE];
uint32_t routeSourceOffset = 0;
uint16_t routeInputLength = 0;
uint16_t routeInputOffset = 0;
uint32_t routeOutputBytes = 0;
uint32_t routeStartedAt = 0;
uint16_t routeChunkSize = 20;
uint16_t routeCompressionChunkSize = 20;
RouteChunk routeQueueStorage[ROUTE_QUEUE_LENGTH];
StaticQueue_t routeQueueControl;
QueueHandle_t routeChunkQueue = nullptr;
RouteChunk routeWriteChunk;
RouteChunk routeReadChunk;

uint16_t currentRouteMtu() {
  if (bleServer == nullptr || !deviceConnected) return 23;
  return bleServer->getPeerMTU(bleServer->getConnId());
}

String makeRouteInfoJson() {
  uint16_t mtu = currentRouteMtu();
  routeChunkSize = mtu >= 23 ? min((uint16_t)(mtu - 3), ROUTE_MAX_CHUNK_SIZE) : 20;
  char json[224];
  snprintf(json, sizeof(json),
           "{\"encoding\":\"zlib-deflate\",\"format\":\"csv\",\"points\":%lu,\"raw_bytes\":%lu,\"mtu\":%u,\"chunk_bytes\":%u,\"ready\":%s,\"done\":%s,\"error\":%s}",
           (unsigned long)GPS_ROUTE_POINT_COUNT,
           (unsigned long)GPS_ROUTE_RAW_SIZE,
           mtu,
           routeChunkSize,
           routeCompressionReady ? "true" : "false",
           routeCompressionDone ? "true" : "false",
           routeCompressionFailed ? "true" : "false");
  return String(json);
}

void resetRouteCompressor() {
  routeSourceOffset = 0;
  routeInputLength = 0;
  routeInputOffset = 0;
  routeOutputBytes = 0;
  routeCompressionFailed = false;
  routeCompressionDone = false;
  routeCompressionChunkSize = routeChunkSize;
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

bool enqueueRouteChunk(size_t length) {
  if (length == 0) return true;
  routeWriteChunk.length = (uint16_t)length;
  while (routeTransferActive) {
    if (xQueueSend(routeChunkQueue, &routeWriteChunk, pdMS_TO_TICKS(100)) == pdTRUE) {
      routeCompressionReady = true;
      return true;
    }
  }
  return false;
}

bool compressRouteToQueue() {
  resetRouteCompressor();
  if (routeCompressionFailed) return false;

  while (routeSourceOffset < GPS_ROUTE_RAW_SIZE) {
    if (!refillRouteInput()) return false;

    while (routeInputOffset < routeInputLength) {
      size_t inputSize = routeInputLength - routeInputOffset;
      size_t outputSize = routeCompressionChunkSize;
      tdefl_status status = tdefl_compress(
          &routeCompressor,
          routeInputBuffer + routeInputOffset,
          &inputSize,
          routeWriteChunk.data,
          &outputSize,
          TDEFL_NO_FLUSH);
      routeInputOffset += (uint16_t)inputSize;
      if (status == TDEFL_STATUS_BAD_PARAM || status == TDEFL_STATUS_PUT_BUF_FAILED ||
          (inputSize == 0 && outputSize == 0)) {
        Serial.printf("[BLE] ROUTE compression failed: status %d, input %lu, output %lu\n",
                      (int)status,
                      (unsigned long)inputSize,
                      (unsigned long)outputSize);
        return false;
      }
      if (!enqueueRouteChunk(outputSize)) return false;
    }
  }

  while (true) {
    size_t inputSize = 0;
    size_t outputSize = routeCompressionChunkSize;
    tdefl_status status = tdefl_compress(
        &routeCompressor,
        nullptr,
        &inputSize,
        routeWriteChunk.data,
        &outputSize,
        TDEFL_FINISH);
    if (outputSize > 0 && !enqueueRouteChunk(outputSize)) return false;
    if (status == TDEFL_STATUS_DONE) return true;
    if (status == TDEFL_STATUS_BAD_PARAM || status == TDEFL_STATUS_PUT_BUF_FAILED || outputSize == 0) {
      Serial.printf("[BLE] ROUTE compression finish failed: status %d, output %lu\n",
                    (int)status,
                    (unsigned long)outputSize);
      return false;
    }
  }
}

void routeCompressionTask(void *) {
  while (true) {
    if (routeCompressionRequested) {
      routeCompressionRequested = false;
      routeCompressionReady = false;
      routeCompressionFailed = !compressRouteToQueue();
      routeCompressionDone = !routeCompressionFailed;
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
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
      routeStartedAt = millis();
      routeCompressionReady = false;
      routeCompressionDone = false;
      routeCompressionFailed = false;
      routeTransferActive = true;
      xQueueReset(routeChunkQueue);
      routeCompressionRequested = true;
      Serial.println("[BLE] ROUTE START (miniz zlib stream)");
    } else if (command == "STOP") {
      routeTransferActive = false;
      routeCompressionRequested = false;
      Serial.println("[BLE] ROUTE STOP");
    } else {
      Serial.printf("[BLE] ROUTE command odrzucony: %s\n", command.c_str());
    }
  }
};

class RouteDataCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    if (!routeTransferActive || routeCompressionFailed || routeChunkQueue == nullptr) {
      characteristic->setValue("");
      return;
    }

    if (xQueueReceive(routeChunkQueue, &routeReadChunk, 0) != pdTRUE) {
      if (routeCompressionDone) {
        routeTransferActive = false;
        characteristic->setValue("");
        Serial.printf("[BLE] ROUTE READ complete: %lu bytes in %lu ms\n",
                      (unsigned long)routeOutputBytes,
                      (unsigned long)(millis() - routeStartedAt));
      } else {
        characteristic->setValue("");
      }
      return;
    }

    characteristic->setValue(routeReadChunk.data, routeReadChunk.length);
    routeOutputBytes += routeReadChunk.length;
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

  routeChunkQueue = xQueueCreateStatic(
      ROUTE_QUEUE_LENGTH,
      sizeof(RouteChunk),
      reinterpret_cast<uint8_t *>(routeQueueStorage),
      &routeQueueControl);
  service->start();
  xTaskCreate(routeCompressionTask, "route_compress", 4096, nullptr, 1, nullptr);
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
