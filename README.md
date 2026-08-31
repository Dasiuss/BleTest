# BleTest

Test BLE dla Waveshare ESP32-S3-Zero i telefonu z Androidem.

## Co robi system

- ESP32 reklamuje urządzenie BLE o nazwie `BleTestEsp32`.
- Usługa GATT udostępnia metadane trasy, komendę sterującą oraz dane trasy przez `NOTIFY`.
- ESP32 v2 przechowuje surowe wiersze NMEA w pamięci flash, kompresuje je strumieniowo zlib/DEFLATE w `loop()` i udostępnia przez BLE NOTIFY.
- PWA v2 dekompresuje dane do identycznego CSV i zapisuje transfer strumieniowo do OPFS, gdy przeglądarka je udostępnia.
- ESP32 ustawia lokalny MTU na 517; po negocjacji z telefonem payload ma do 240 bajtów zamiast 16 przy domyślnym MTU 23.

## Firmware w Arduino IDE

1. W Arduino IDE zainstaluj pakiet płytek **esp32 by Espressif Systems**.
2. Otwórz `firmware/BleTestEsp32/BleTestEsp32.ino`.
3. Wybierz płytkę `ESP32S3 Dev Module` (Waveshare ESP32-S3-Zero nie musi mieć osobnej pozycji).
4. Ustaw port płytki i prędkość monitora portu szeregowego na `115200`.
5. Wygeneruj dane trasy poleceniem `node tools/generate_route.js`.
6. Wgraj program. Jeśli upload przez USB nie działa, włącz `USB CDC On Boot` albo użyj trybu bootloadera zgodnie z instrukcją Waveshare.
6. Otwórz Serial Monitor. Powinien pojawić się komunikat `GPS route test v2` oraz `Advertising: BleTestEsp32`.

Nie trzeba instalować dodatkowej biblioteki BLE. `BLEDevice` i `BLEServer` są częścią pakietu ESP32 dla Arduino.
Kompresor `miniz` jest dołączony lokalnie w katalogu szkicu, więc nie wymaga osobnej instalacji w Arduino IDE.

## PWA na GitHub Pages

Workflow `.github/workflows/deploy-pages.yml` publikuje katalog `web` po każdym pushu do `main`.

1. W repozytorium GitHub otwórz **Settings > Pages**.
2. W polu **Source** wybierz **GitHub Actions**.
3. Zrób push zmian do gałęzi `main`.
4. Otwórz adres `https://dasiuss.github.io/BleTest/` w Chrome na Androidzie.

Web Bluetooth wymaga bezpiecznego kontekstu HTTPS. Lokalny plik `index.html` otwarty przez `file://` nie będzie działał do testu BLE.

## Test na telefonie

1. Włącz Bluetooth i zasil ESP32.
2. Otwórz PWA w Chrome. Nie paruj ESP32 wcześniej z poziomu ustawień Androida.
3. Naciśnij **Połącz urządzenie** i wybierz `BleTestEsp32`.
4. Naciśnij **Pobierz NMEA CSV**. PWA włączy `NOTIFY`, wyśle `START`, a ESP32 rozpocznie kompresję w `loop()`.
5. Po zakończeniu PWA pokaże czas, liczbę pakietów, bitrate skompresowany, średni bitrate CSV, redukcję, CRC32 i próbkę odebranego CSV.
6. **Zatrzymaj** przerywa test. **Pobierz CSV** zapisuje odebrane dane.

## UUID

- Service: `7e6d0001-7b9e-4f5b-a6c2-320000000001`
- `route info` (`READ`, metadane): `7e6d0006-7b9e-4f5b-a6c2-320000000006`
- `route control` (`WRITE`, `START`/`STOP`): `7e6d0007-7b9e-4f5b-a6c2-320000000007`
- `route data` (`NOTIFY`, ramki DEFLATE z numerem sekwencyjnym): `7e6d0008-7b9e-4f5b-a6c2-320000000008`

## Generator trasy

Generator wymaga tylko Node.js:

```text
node tools/generate_route.js
```

Domyślnie tworzy 600 punktów GPS, czyli 70 sekund przy 10 Hz i około 100 KiB surowych pełnych wierszy NMEA. Aktualizuje `firmware/BleTestEsp32/route_data.h` i tworzy `route_gps.csv` do porównania. Krótszy lub dłuższy test można wygenerować tak:

```text
node tools/generate_route.js --duration-seconds 60 --frequency-hz 10
```

Wynik jest surowym plikiem CSV zawierającym pełne zdania `GPRMC` i `GPGGA` zakończone `CRLF`, z poprawnymi sumami kontrolnymi NMEA. Firmware nie parsuje ani nie kompresuje danych w callbacku BLE: callback ustawia żądanie, a `loop()` odczytuje kolejne porcje z flash i zasila jeden ciąg zlib/DEFLATE. PWA używa `DecompressionStream("deflate")`, zapisuje zdekompresowany CSV do OPFS lub bufora `Blob` i weryfikuje CRC32.

Wymiana MTU jest negocjacją obu stron. `BLEDevice::setMTU(517)` ustawia maksimum po stronie ESP32, ale klient GATT musi zainicjować wymianę. Ramka NOTIFY ma 4 bajty numeru sekwencyjnego i do 240 bajtów skompresowanego strumienia. Pusta ramka kończy transfer. PWA wykrywa lukę numerów i zgłasza błąd, ponieważ retransmisja środka ciągłego strumienia DEFLATE nie jest bezpieczna. Po transferze PWA weryfikuje rozmiar, liczbę linii i CRC32 odtworzonego pliku.
