#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "miniz.h"
#include "route_data.h"

static const char *FIRMWARE_VERSION = "v5";
static const char *ROUTE_PROTOCOL_VERSION = "v4";
static const char *SERVICE_UUID = "7e6d0001-7b9e-4f5b-a6c2-320000000001";
static const char *ROUTE_INFO_CHARACTERISTIC_UUID = "7e6d0006-7b9e-4f5b-a6c2-320000000006";
static const char *ROUTE_CONTROL_CHARACTERISTIC_UUID = "7e6d0007-7b9e-4f5b-a6c2-320000000007";
static const char *ROUTE_DATA_CHARACTERISTIC_UUID = "7e6d0008-7b9e-4f5b-a6c2-320000000008";

static const uint16_t ROUTE_MAX_FRAME_SIZE = 244;
static const uint8_t ROUTE_FRAME_HEADER_SIZE = sizeof(uint32_t);
static const uint16_t ROUTE_INPUT_BUFFER_SIZE = 512;
// 128 slots use about 32 KiB for frame data and leave a large heap margin.
static const uint8_t ROUTE_NOTIFY_ACK_BLOCK_SIZE = 32;
static const uint8_t ROUTE_NOTIFY_WINDOW_SIZE = 128;
static const uint8_t ROUTE_TEST_REPEATS = 10;
// 4 ms is the fastest confirmed stable pacing profile.
static const uint32_t ROUTE_NOTIFY_INTERVAL_MS = 4;
static const uint32_t ROUTE_ACK_TIMEOUT_MS = 500;
static const uint8_t ROUTE_ACK_RETRY_LIMIT = 3;

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
uint8_t routeWindowBuffer[ROUTE_NOTIFY_WINDOW_SIZE][ROUTE_MAX_FRAME_SIZE];
uint16_t routeWindowLengths[ROUTE_NOTIFY_WINDOW_SIZE];
uint32_t routeWindowSequences[ROUTE_NOTIFY_WINDOW_SIZE];
uint32_t routeSourceOffset = 0;
uint16_t routeInputLength = 0;
uint16_t routeInputOffset = 0;
uint32_t routeCompressedBytes = 0;
uint32_t routeNotifyCount = 0;
uint32_t routeNextSequence = 0;
uint32_t routeOldestUnackedSequence = 0;
uint8_t routeInFlightCount = 0;
uint32_t routeWindowRetrySequence = 0;
uint8_t routeWindowRetryCount = 0;
uint32_t routeStartedAt = 0;
uint32_t routeLastNotifyAt = 0;
uint32_t routeAckWaitStartedAt = 0;
uint32_t routeAckWaitStartedUs = 0;
uint32_t routeEndMarkerSequence = 0;
uint16_t routePayloadSize = ROUTE_MAX_FRAME_SIZE - ROUTE_FRAME_HEADER_SIZE;
bool routeInputExhausted = false;
bool routeCompressionFinished = false;
bool routeEndMarkerSent = false;
bool routeWindowRetrying = false;
bool routePendingNotify = false;
uint32_t routePendingNotifySequence = 0;
uint16_t routePendingNotifyLength = 0;
uint16_t routePendingNotifyPayloadLength = 0;
bool routePendingNotifyEndMarker = false;
uint32_t routeExpectedCrc32Value = 0;
bool routeExpectedCrc32Ready = false;
bool routeProfilePrinted = false;
uint32_t routeProfileStartedUs = 0;
uint32_t routeProfileFirstNotifyUs = 0;
uint32_t routeProfileEndMarkerUs = 0;
uint32_t routeProfileCompressionUs = 0;
uint32_t routeProfileCompressionCalls = 0;
uint32_t routeProfileCompressionMaxUs = 0;
uint32_t routeProfileNotifyUs = 0;
uint32_t routeProfileNotifyCalls = 0;
uint32_t routeProfileNotifyMaxUs = 0;
uint32_t routeProfileNormalFrames = 0;
uint32_t routeProfileReplayFrames = 0;
uint32_t routeProfileAckCount = 0;
uint32_t routeProfileNackCount = 0;
uint32_t routeProfileTimeoutCount = 0;
uint32_t routeProfileReplayCount = 0;
uint32_t routeProfileAckWaitUs = 0;

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

uint32_t routeTotalRawSize() {
  return GPS_ROUTE_RAW_SIZE * (uint32_t)ROUTE_TEST_REPEATS;
}

uint32_t routeExpectedCrc32() {
  if (routeExpectedCrc32Ready) return routeExpectedCrc32Value;
  uint32_t crc = 0xFFFFFFFF;
  for (uint8_t repeat = 0; repeat < ROUTE_TEST_REPEATS; repeat += 1) {
    for (uint32_t index = 0; index < GPS_ROUTE_RAW_SIZE; index += 1) {
      crc ^= pgm_read_byte(GPS_ROUTE_CSV + index);
      for (uint8_t bit = 0; bit < 8; bit += 1) {
        crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
      }
    }
  }
  routeExpectedCrc32Value = ~crc;
  routeExpectedCrc32Ready = true;
  return routeExpectedCrc32Value;
}

String makeRouteInfoJson() {
  uint16_t mtu = currentRouteMtu();
  routePayloadSize = currentRoutePayloadSize();
  char json[384];
  snprintf(json, sizeof(json),
           "{\"version\":\"%s\",\"firmware\":\"%s\",\"encoding\":\"zlib-deflate\",\"transport\":\"notify-v4\",\"format\":\"nmea-csv\",\"points\":%lu,\"lines\":%lu,\"raw_bytes\":%lu,\"compressed_bytes\":%lu,\"crc32\":\"%08lX\",\"repeats\":%u,\"mtu\":%u,\"chunk_bytes\":%u,\"window_chunks\":%u,\"inflight_chunks\":%u,\"done\":%s,\"error\":%s}",
           ROUTE_PROTOCOL_VERSION,
           FIRMWARE_VERSION,
           (unsigned long)(GPS_ROUTE_POINT_COUNT * ROUTE_TEST_REPEATS),
           (unsigned long)(GPS_ROUTE_LINE_COUNT * ROUTE_TEST_REPEATS),
           (unsigned long)routeTotalRawSize(),
           (unsigned long)routeCompressedBytes,
           (unsigned long)routeExpectedCrc32(),
           ROUTE_TEST_REPEATS,
           mtu,
           routePayloadSize,
           ROUTE_NOTIFY_ACK_BLOCK_SIZE,
           ROUTE_NOTIFY_WINDOW_SIZE,
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
  routeOldestUnackedSequence = 0;
  routeInFlightCount = 0;
  routeWindowRetrySequence = 0;
  routeWindowRetryCount = 0;
  routeAckWaitStartedAt = 0;
  routeAckWaitStartedUs = 0;
  routePayloadSize = currentRoutePayloadSize();
  routeInputExhausted = false;
  routeCompressionFinished = false;
  routeEndMarkerSent = false;
  routeWindowRetrying = false;
  routePendingNotify = false;
  routePendingNotifySequence = 0;
  routePendingNotifyLength = 0;
  routePendingNotifyPayloadLength = 0;
  routePendingNotifyEndMarker = false;
  routeEndMarkerSequence = 0;
  routeTransferComplete = false;
  routeTransferFailed = false;
  routeProfilePrinted = false;
  routeProfileStartedUs = micros();
  routeProfileFirstNotifyUs = 0;
  routeProfileEndMarkerUs = 0;
  routeProfileCompressionUs = 0;
  routeProfileCompressionCalls = 0;
  routeProfileCompressionMaxUs = 0;
  routeProfileNotifyUs = 0;
  routeProfileNotifyCalls = 0;
  routeProfileNotifyMaxUs = 0;
  routeProfileNormalFrames = 0;
  routeProfileReplayFrames = 0;
  routeProfileAckCount = 0;
  routeProfileNackCount = 0;
  routeProfileTimeoutCount = 0;
  routeProfileReplayCount = 0;
  routeProfileAckWaitUs = 0;

  int flags = TDEFL_DEFAULT_MAX_PROBES | TDEFL_WRITE_ZLIB_HEADER | TDEFL_COMPUTE_ADLER32;
  if (tdefl_init(&routeCompressor, nullptr, nullptr, flags) != TDEFL_STATUS_OKAY) {
    routeTransferFailed = true;
  }
}

bool refillRouteInput() {
  if (routeSourceOffset >= routeTotalRawSize()) return false;
  uint32_t remaining = routeTotalRawSize() - routeSourceOffset;
  routeInputLength = remaining > ROUTE_INPUT_BUFFER_SIZE ? ROUTE_INPUT_BUFFER_SIZE : (uint16_t)remaining;
  uint16_t copied = 0;
  while (copied < routeInputLength) {
    uint32_t sourceOffset = routeSourceOffset % GPS_ROUTE_RAW_SIZE;
    uint32_t sourceRemaining = GPS_ROUTE_RAW_SIZE - sourceOffset;
    uint16_t segmentLength = sourceRemaining < (routeInputLength - copied)
                                 ? (uint16_t)sourceRemaining
                                 : (uint16_t)(routeInputLength - copied);
    memcpy_P(routeInputBuffer + copied, GPS_ROUTE_CSV + sourceOffset, segmentLength);
    copied += segmentLength;
    routeSourceOffset += segmentLength;
  }
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

void recordRouteNotifyAttempt(uint32_t startedUs) {
  uint32_t elapsedUs = micros() - startedUs;
  routeProfileNotifyUs += elapsedUs;
  routeProfileNotifyCalls += 1;
  if (elapsedUs > routeProfileNotifyMaxUs) routeProfileNotifyMaxUs = elapsedUs;
}

bool notifyRouteFrame(const uint8_t *frame, uint16_t frameLength) {
  uint32_t startedUs = micros();
  routeDataCharacteristic->setValue(frame, frameLength);
  routeDataCharacteristic->notify();
  recordRouteNotifyAttempt(startedUs);
  if (routeProfileFirstNotifyUs == 0) routeProfileFirstNotifyUs = micros();
  routeNotifyCount += 1;
  routeLastNotifyAt = millis();
  return true;
}

bool commitRouteFrame(uint32_t sequence, uint16_t payloadLength, bool endMarker) {
  routeProfileNormalFrames += 1;
  routeNextSequence += 1;
  routeInFlightCount += 1;
  if (payloadLength > 0) routeCompressedBytes += payloadLength;
  if (endMarker) {
    routeEndMarkerSequence = sequence;
    routeEndMarkerSent = true;
    routeProfileEndMarkerUs = micros();
    routeAckWaitStartedAt = millis();
    routeAckWaitStartedUs = micros();
  } else if (routeInFlightCount == ROUTE_NOTIFY_ACK_BLOCK_SIZE) {
    routeAckWaitStartedAt = millis();
    routeAckWaitStartedUs = micros();
  }
  return true;
}

bool sendNewRouteFrame(uint16_t payloadLength, bool endMarker = false) {
  uint32_t sequence = routeNextSequence;
  uint8_t slot = sequence % ROUTE_NOTIFY_WINDOW_SIZE;
  uint16_t frameLength = ROUTE_FRAME_HEADER_SIZE + payloadLength;
  memcpy(routeNotifyBuffer, &sequence, ROUTE_FRAME_HEADER_SIZE);
  memcpy(routeWindowBuffer[slot], routeNotifyBuffer, frameLength);
  routeWindowLengths[slot] = frameLength;
  routeWindowSequences[slot] = sequence;
  if (!notifyRouteFrame(routeWindowBuffer[slot], frameLength)) {
    routePendingNotify = true;
    routePendingNotifySequence = sequence;
    routePendingNotifyLength = frameLength;
    routePendingNotifyPayloadLength = payloadLength;
    routePendingNotifyEndMarker = endMarker;
    return false;
  }
  commitRouteFrame(sequence, payloadLength, endMarker);
  return true;
}

bool retryPendingRouteNotify() {
  if (!routePendingNotify) return true;
  uint8_t slot = routePendingNotifySequence % ROUTE_NOTIFY_WINDOW_SIZE;
  if (!notifyRouteFrame(routeWindowBuffer[slot], routePendingNotifyLength)) return false;
  uint32_t sequence = routePendingNotifySequence;
  uint16_t payloadLength = routePendingNotifyPayloadLength;
  bool endMarker = routePendingNotifyEndMarker;
  routePendingNotify = false;
  routePendingNotifyLength = 0;
  routePendingNotifyPayloadLength = 0;
  routePendingNotifyEndMarker = false;
  commitRouteFrame(sequence, payloadLength, endMarker);
  return true;
}

bool resendRouteFrame(uint32_t sequence) {
  uint8_t slot = sequence % ROUTE_NOTIFY_WINDOW_SIZE;
  if (routeWindowSequences[slot] != sequence) return false;
  if (!notifyRouteFrame(routeWindowBuffer[slot], routeWindowLengths[slot])) return false;
  routeProfileReplayFrames += 1;
  return true;
}

void startRouteReplay(uint32_t requestedSequence, bool countRetry) {
  if (requestedSequence < routeOldestUnackedSequence) requestedSequence = routeOldestUnackedSequence;
  if (requestedSequence >= routeNextSequence) return;
  routeWindowRetrySequence = requestedSequence;
  routeWindowRetrying = true;
  routeProfileReplayCount += 1;
  if (countRetry) routeWindowRetryCount += 1;
  routeLastNotifyAt = 0;
}

void pumpRouteReplay() {
  if (routeWindowRetrying) {
    if (millis() - routeLastNotifyAt < ROUTE_NOTIFY_INTERVAL_MS) return;
    if (routeWindowRetrySequence < routeOldestUnackedSequence) {
      routeWindowRetrySequence = routeOldestUnackedSequence;
    }
    if (routeWindowRetrySequence < routeNextSequence) {
      if (resendRouteFrame(routeWindowRetrySequence)) routeWindowRetrySequence += 1;
      return;
    }
    routeWindowRetrying = false;
    routeAckWaitStartedAt = millis();
    routeAckWaitStartedUs = micros();
    return;
  }

  if (routeInFlightCount == 0) return;
  if (millis() - routeAckWaitStartedAt < ROUTE_ACK_TIMEOUT_MS) return;
  if (routeWindowRetryCount >= ROUTE_ACK_RETRY_LIMIT) {
    routeTransferFailed = true;
    routeTransferActive = false;
    Serial.println("[BLE] ROUTE ACK timeout; transfer stopped");
    return;
  }

  routeProfileTimeoutCount += 1;
  startRouteReplay(routeOldestUnackedSequence, true);
  Serial.printf("[BLE] ROUTE ACK timeout; replay from sequence %lu (%u/%u)\n",
                (unsigned long)routeOldestUnackedSequence,
                (unsigned int)routeWindowRetryCount,
                (unsigned int)ROUTE_ACK_RETRY_LIMIT);
}

void pumpRouteNotifications() {
  if (!deviceConnected || !routeTransferActive || routeDataCharacteristic == nullptr) return;
  if (routeWindowRetrying) {
    pumpRouteReplay();
    return;
  }
  if (routeInFlightCount >= ROUTE_NOTIFY_WINDOW_SIZE) {
    pumpRouteReplay();
    return;
  }
  if (routePendingNotify) {
    if (millis() - routeLastNotifyAt < ROUTE_NOTIFY_INTERVAL_MS) return;
    retryPendingRouteNotify();
    return;
  }
  if ((routeInFlightCount >= ROUTE_NOTIFY_ACK_BLOCK_SIZE || routeEndMarkerSent) &&
      millis() - routeAckWaitStartedAt >= ROUTE_ACK_TIMEOUT_MS) {
    pumpRouteReplay();
    return;
  }
  if (millis() - routeLastNotifyAt < ROUTE_NOTIFY_INTERVAL_MS) return;

  if (routeCompressionFinished) {
    if (routeEndMarkerSent) return;
    routeEndMarkerSequence = routeNextSequence;
    sendNewRouteFrame(0, true);
    return;
  }

  uint32_t compressionStartedUs = micros();
  uint16_t payloadLength = makeRoutePayload(routeNotifyBuffer + ROUTE_FRAME_HEADER_SIZE);
  uint32_t compressionElapsedUs = micros() - compressionStartedUs;
  routeProfileCompressionUs += compressionElapsedUs;
  routeProfileCompressionCalls += 1;
  if (compressionElapsedUs > routeProfileCompressionMaxUs) routeProfileCompressionMaxUs = compressionElapsedUs;
  if (routeTransferFailed) {
    routeTransferActive = false;
    Serial.println("[BLE] ROUTE compression failed");
    return;
  }

  if (payloadLength > 0) {
    sendNewRouteFrame(payloadLength);
  }
}

void printRouteProfile() {
  if (routeProfilePrinted) return;
  routeProfilePrinted = true;
  uint32_t totalUs = micros() - routeProfileStartedUs;
  uint32_t notifySpanUs = routeProfileEndMarkerUs > routeProfileFirstNotifyUs
                              ? routeProfileEndMarkerUs - routeProfileFirstNotifyUs
                              : 0;
  Serial.println("[PROFILE] ROUTE summary");
  Serial.printf("[PROFILE] total=%lu ms first_notify=%lu us notify_span=%lu ms\n",
                (unsigned long)(totalUs / 1000UL),
                (unsigned long)(routeProfileFirstNotifyUs > routeProfileStartedUs
                                    ? routeProfileFirstNotifyUs - routeProfileStartedUs
                                    : 0),
                (unsigned long)(notifySpanUs / 1000UL));
  Serial.printf("[PROFILE] compression=%lu us calls=%lu max=%lu us\n",
                (unsigned long)routeProfileCompressionUs,
                (unsigned long)routeProfileCompressionCalls,
                (unsigned long)routeProfileCompressionMaxUs);
  Serial.printf("[PROFILE] notify=%lu us calls=%lu avg=%lu us max=%lu us normal=%lu replay=%lu interval=%lu ms\n",
                (unsigned long)routeProfileNotifyUs,
                (unsigned long)routeProfileNotifyCalls,
                (unsigned long)(routeProfileNotifyCalls ? routeProfileNotifyUs / routeProfileNotifyCalls : 0),
                (unsigned long)routeProfileNotifyMaxUs,
                (unsigned long)routeProfileNormalFrames,
                (unsigned long)routeProfileReplayFrames,
                 (unsigned long)ROUTE_NOTIFY_INTERVAL_MS);
  Serial.printf("[PROFILE] ack=%lu nack=%lu timeouts=%lu replays=%lu ack_wait=%lu ms\n",
                (unsigned long)routeProfileAckCount,
                (unsigned long)routeProfileNackCount,
                (unsigned long)routeProfileTimeoutCount,
                (unsigned long)routeProfileReplayCount,
                (unsigned long)(routeProfileAckWaitUs / 1000UL));
  Serial.printf("[PROFILE] output=%lu compressed_bytes=%lu notify_total=%lu repeats=%u\n",
                (unsigned long)routeTotalRawSize(),
                (unsigned long)routeCompressedBytes,
                (unsigned long)routeNotifyCount,
                (unsigned int)ROUTE_TEST_REPEATS);
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
    routeWindowRetrying = false;
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
      routeWindowRetrying = false;
      Serial.printf("[BLE] ROUTE START request queued (%s)\n", FIRMWARE_VERSION);
      return;
    }

    if (command == "STOP") {
      routeStartRequested = false;
      routeTransferActive = false;
      routeWindowRetrying = false;
      Serial.println("[BLE] ROUTE STOP");
      return;
    }

    if (command.startsWith("ACK:")) {
      uint32_t acknowledgedSequence = strtoul(command.substring(4).c_str(), nullptr, 10);
      if (!routeTransferActive || acknowledgedSequence <= routeOldestUnackedSequence ||
           acknowledgedSequence > routeNextSequence) return;

      routeProfileAckCount += 1;
      uint32_t acknowledgedAtUs = micros();
      if (routeAckWaitStartedUs != 0) {
        routeProfileAckWaitUs += acknowledgedAtUs - routeAckWaitStartedUs;
      }
      uint32_t acknowledgedCount = acknowledgedSequence - routeOldestUnackedSequence;
      routeOldestUnackedSequence = acknowledgedSequence;
      routeInFlightCount -= (uint8_t)acknowledgedCount;
      routeWindowRetryCount = 0;
      if (routeWindowRetrySequence < routeOldestUnackedSequence) {
        routeWindowRetrySequence = routeOldestUnackedSequence;
      }
      if (routeWindowRetrying && routeWindowRetrySequence >= routeNextSequence) {
        routeWindowRetrying = false;
      }
      if (routeInFlightCount > 0) {
        routeAckWaitStartedAt = millis();
        routeAckWaitStartedUs = micros();
      } else {
        routeAckWaitStartedAt = 0;
        routeAckWaitStartedUs = 0;
      }
      if (routeEndMarkerSent && acknowledgedSequence > routeEndMarkerSequence) {
        routeTransferActive = false;
        routeTransferComplete = true;
        Serial.printf("[BLE] ROUTE %s complete: %lu compressed bytes in %lu ms, %lu NOTIFY\n",
                      FIRMWARE_VERSION,
                      (unsigned long)routeCompressedBytes,
                      (unsigned long)(millis() - routeStartedAt),
                      (unsigned long)routeNotifyCount);
        printRouteProfile();
      }
      return;
    }

    if (command.startsWith("NACK:")) {
      routeProfileNackCount += 1;
      uint32_t requestedSequence = strtoul(command.substring(5).c_str(), nullptr, 10);
      if (routeTransferActive && requestedSequence >= routeOldestUnackedSequence &&
          requestedSequence < routeNextSequence) {
        routeWindowRetryCount = 0;
        startRouteReplay(requestedSequence, false);
        Serial.printf("[BLE] ROUTE NACK; replay from sequence %lu (replays=%lu)\n",
                      (unsigned long)requestedSequence,
                      (unsigned long)routeProfileReplayCount);
      }
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
  Serial.printf("[BLE] Route source: %lu raw bytes x %u, %lu total bytes, %lu points, %lu NMEA lines\n",
                (unsigned long)GPS_ROUTE_RAW_SIZE,
                (unsigned int)ROUTE_TEST_REPEATS,
                (unsigned long)routeTotalRawSize(),
                (unsigned long)(GPS_ROUTE_POINT_COUNT * ROUTE_TEST_REPEATS),
                (unsigned long)(GPS_ROUTE_LINE_COUNT * ROUTE_TEST_REPEATS));
  Serial.printf("[BLE] Route CRC32: %08lX\n", (unsigned long)routeExpectedCrc32());
}

void loop() {
  static uint32_t lastHeartbeatAt = 0;
  uint32_t now = millis();
  if ((uint32_t)(now - lastHeartbeatAt) >= 1000) {
    lastHeartbeatAt = now;
    Serial.printf("[HEARTBEAT] loop alive t=%lu connected=%u active=%u pending=%u inflight=%u\n",
                  (unsigned long)now,
                  deviceConnected ? 1U : 0U,
                  routeTransferActive ? 1U : 0U,
                  routePendingNotify ? 1U : 0U,
                  (unsigned int)routeInFlightCount);
  }

  if (routeStartRequested) {
    routeStartRequested = false;
    routeStartedAt = millis();
    routeLastNotifyAt = 0;
    resetRouteCompression();
    routeTransferActive = !routeTransferFailed;
  Serial.printf("[BLE] ROUTE %s compression started in loop (zlib-deflate), MTU %u, payload %u, window %u, interval %lu ms\n",
                  FIRMWARE_VERSION,
                  currentRouteMtu(),
                  routePayloadSize,
                  ROUTE_NOTIFY_WINDOW_SIZE,
                  (unsigned long)ROUTE_NOTIFY_INTERVAL_MS);
  }

  pumpRouteNotifications();
  delay(1);
}
