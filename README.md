# BleTest

Test BLE dla Waveshare ESP32-S3-Zero i telefonu z Androidem.

## Co robi system

- ESP32 reklamuje urządzenie BLE o nazwie `BleTestEsp32`.
- Usługa GATT udostępnia metadane trasy, komendę sterującą oraz dane trasy przez `READ`.
- ESP32 przechowuje surowy CSV w pamięci flash i kompresuje go podczas odczytu standardowym zlib/DEFLATE przez `miniz`.
- PWA wykonuje serię pojedynczych odczytów fragmentów, mierzy transfer i dekoduje trasę z powrotem do CSV.
- ESP32 ustawia lokalny MTU na 517; po negocjacji z telefonem używany fragment ma do 244 bajtów zamiast 20 przy domyślnym MTU 23.

## Firmware w Arduino IDE

1. W Arduino IDE zainstaluj pakiet płytek **esp32 by Espressif Systems**.
2. Otwórz `firmware/BleTestEsp32/BleTestEsp32.ino`.
3. Wybierz płytkę `ESP32S3 Dev Module` (Waveshare ESP32-S3-Zero nie musi mieć osobnej pozycji).
4. Ustaw port płytki i prędkość monitora portu szeregowego na `115200`.
5. Wygeneruj dane trasy poleceniem `node tools/generate_route.js`.
6. Wgraj program. Jeśli upload przez USB nie działa, włącz `USB CDC On Boot` albo użyj trybu bootloadera zgodnie z instrukcją Waveshare.
6. Otwórz Serial Monitor. Powinien pojawić się komunikat `Advertising: BleTestEsp32`.

Nie trzeba instalować dodatkowej biblioteki BLE. `BLEDevice` i `BLEServer` są częścią pakietu ESP32 dla Arduino. `miniz.c` i `miniz.h` znajdują się lokalnie w katalogu szkicu i Arduino IDE skompiluje je razem z programem.

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
4. Naciśnij **Pobierz trasę**. PWA wyśle `START`, a następnie wykona kolejne `READ` danych aż do pobrania całego zakodowanego pliku.
5. Po zakończeniu PWA pokaże czas, liczbę odczytów, kbit/s, współczynnik kompresji i próbkę odtworzonego CSV.
6. **Zatrzymaj** przerywa test. **Pobierz zlib** zapisuje odebrane bajty do dalszej analizy.

## UUID

- Service: `7e6d0001-7b9e-4f5b-a6c2-320000000001`
- `route info` (`READ`, metadane): `7e6d0006-7b9e-4f5b-a6c2-320000000006`
- `route control` (`WRITE`, `START`/`STOP`): `7e6d0007-7b9e-4f5b-a6c2-320000000007`
- `route data` (`READ`, kolejne fragmenty zlib/DEFLATE): `7e6d0008-7b9e-4f5b-a6c2-320000000008`

## Generator trasy

Generator wymaga tylko Node.js:

```text
node tools/generate_route.js
```

Domyślnie tworzy 72 000 punktów, czyli 2 godziny przy 10 Hz. Aktualizuje `firmware/BleTestEsp32/route_data.h` i tworzy `route_gps.csv` do porównania. Krótszy test można wygenerować tak:

```text
node tools/generate_route.js --duration-seconds 60 --frequency-hz 10
```

Wynik jest standardowym strumieniem zlib/DEFLATE, więc można go otworzyć zwykłym narzędziem zlib po pobraniu. Rozmiar skompresowany jest ustalany podczas testu. Kompresja jest wykonywana na ESP32, nie w generatorze.

Wymiana MTU jest negocjacją obu stron. `BLEDevice::setMTU(517)` ustawia maksimum po stronie ESP32, ale klient GATT musi zainicjować wymianę. Jeśli Chrome/Android jej nie wykona, PWA pokaże MTU 23 i test pozostanie przy fragmentach 20 B.
