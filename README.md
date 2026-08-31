# BleTest

Test BLE dla Waveshare ESP32-S3-Zero i telefonu z Androidem.

## Co robi system

- ESP32 reklamuje urządzenie BLE o nazwie `BleTestEsp32`.
- Usługa GATT udostępnia metadane trasy, komendę sterującą oraz dane trasy przez `NOTIFY`.
- ESP32 v4.7 przechowuje surowe wiersze NMEA w pamięci flash, kompresuje je strumieniowo zlib/DEFLATE w `loop()` i udostępnia przez BLE NOTIFY. W trybie testowym wysyła tę trasę 10 razy, używa pacingu NOTIFY 4 ms oraz jawnie sprawdza mbuf NimBLE przed każdym wysłaniem. Protokół pozostaje kompatybilny z v4.
- PWA v4.8 dekompresuje dane do identycznego CSV, zapisuje transfer strumieniowo do OPFS, gdy przeglądarka je udostępnia, i raportuje profil czasowy całego transferu. Przed podsumowaniem czeka również na zakończenie wszystkich zapisów ACK/NACK.
- ESP32 ustawia lokalny MTU na 517; po negocjacji z telefonem payload ma do 240 bajtów zamiast 16 przy domyślnym MTU 23.

## Firmware w Arduino IDE

1. W Arduino IDE zainstaluj pakiet płytek **esp32 by Espressif Systems**.
2. Otwórz `firmware/BleTestEsp32/BleTestEsp32.ino`.
3. Wybierz płytkę `ESP32S3 Dev Module` (Waveshare ESP32-S3-Zero nie musi mieć osobnej pozycji).
4. Ustaw port płytki i prędkość monitora portu szeregowego na `115200`.
5. Wygeneruj dane trasy poleceniem `node tools/generate_route.js`.
6. Wgraj program. Jeśli upload przez USB nie działa, włącz `USB CDC On Boot` albo użyj trybu bootloadera zgodnie z instrukcją Waveshare.
7. Otwórz Serial Monitor. Powinien pojawić się komunikat `GPS route test v4.7` oraz `Advertising: BleTestEsp32`.

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
4. Naciśnij **Pobierz NMEA CSV**. PWA v4.8 włączy `NOTIFY`, wyśle `START`, a ESP32 v4.7 rozpocznie dziesięciokrotną kompresję w `loop()`.
5. Po zakończeniu PWA v4.8 pokaże czas, liczbę pakietów, bitrate skompresowany, średni bitrate CSV, redukcję, CRC32, profil PWA i próbkę odebranego CSV. Dla dokładnego benchmarku pozostaw wyłączony szczegółowy log ramek.
6. **Zatrzymaj** przerywa test. **Pobierz CSV** zapisuje odebrane dane.

## UUID

- Service: `7e6d0001-7b9e-4f5b-a6c2-320000000001`
- `route info` (`READ`, metadane): `7e6d0006-7b9e-4f5b-a6c2-320000000006`
- `route control` (`WRITE`, `START`/`STOP`/`ACK`/`NACK`): `7e6d0007-7b9e-4f5b-a6c2-320000000007`
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

Wymiana MTU jest negocjacją obu stron. `BLEDevice::setMTU(517)` ustawia maksimum po stronie ESP32, ale klient GATT musi zainicjować wymianę. Ramka NOTIFY ma 4 bajty numeru sekwencyjnego i do 240 bajtów skompresowanego strumienia. ESP32 utrzymuje maksymalnie 128 ramek w locie, a PWA wysyła skumulowany `ACK:<next_sequence>` co 32 ramki, zwalniając kolejne sloty bez zatrzymywania kompresora. Bufor ramek zajmuje około 32 KiB i nie ogranicza rozmiaru całego pliku, który jest przesyłany strumieniowo. Przed wysłaniem firmware wywołuje `ble_hs_mbuf_from_flat()`, a następnie `ble_gatts_notify_custom()` i sprawdza oba wyniki. Przy braku mbufa ramka pozostaje pending i nie przesuwa sekwencji. Przy luce PWA wysyła `NACK:<expected_sequence>`, a ESP32 powtarza niepotwierdzone ramki z bufora. Pusta ramka kończy transfer. Po transferze PWA weryfikuje rozmiar, liczbę linii i CRC32 odtworzonego pliku.

## Profilowanie transferu

Po zakończonym transferze firmware wypisuje w Serial Monitorze blok `[PROFILE] ROUTE summary`. Zawiera on między innymi:

- `compression` - czas CPU spędzony w `tdefl_compress`; jeśli jest mały względem `total`, kompresja nie jest wąskim gardłem.
- `notify` - czas kontrolowanych prób alokacji mbuf i wysłania przez NimBLE.
- `ack_wait` - czas oczekiwania firmware na potwierdzenia PWA.
- `replay`, `nack`, `timeouts` - koszt utraty ramek lub ACK.

PWA pokazuje analogiczny blok `PROFILOWANIE PWA`: czas obsługi callbacków `NOTIFY`, opóźnienia komend ACK/NACK, dekompresję oraz zapis OPFS. Firmware raportuje także `no_mbuf` i błędy zwrócone przez NimBLE. Do porównywania prędkości należy wyłączyć szczegółowy log ramek, ponieważ tworzenie wielu elementów DOM wpływa na wynik.
