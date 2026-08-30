# BleTest

Test BLE dla Waveshare ESP32-S3-Zero i telefonu z Androidem.

## Co robi system

- ESP32 reklamuje urządzenie BLE o nazwie `BleTestEsp32`.
- Usługa GATT zawiera charakterystykę `millis` z właściwościami `READ` i `NOTIFY`.
- `READ` zwraca aktualny licznik `millis()` w JSON, np. `{"millis":12345}`.
- `NOTIFY` wysyła ten sam JSON mniej więcej co sekundę, gdy telefon jest połączony.
- PWA pokazuje etapy połączenia, ostatni pakiet, liczniki READ/NOTIFY i dziennik diagnostyczny.

## Firmware w Arduino IDE

1. W Arduino IDE zainstaluj pakiet płytek **esp32 by Espressif Systems**.
2. Otwórz `firmware/BleTestEsp32/BleTestEsp32.ino`.
3. Wybierz płytkę `ESP32S3 Dev Module` (Waveshare ESP32-S3-Zero nie musi mieć osobnej pozycji).
4. Ustaw port płytki i prędkość monitora portu szeregowego na `115200`.
5. Wgraj program. Jeśli upload przez USB nie działa, włącz `USB CDC On Boot` albo użyj trybu bootloadera zgodnie z instrukcją Waveshare.
6. Otwórz Serial Monitor. Powinien pojawić się komunikat `Advertising: BleTestEsp32`.

Nie trzeba instalować dodatkowej biblioteki BLE. `BLEDevice`, `BLEServer` i `BLE2902` są częścią pakietu ESP32 dla Arduino.

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
3. Naciśnij **Połącz i pobierz** i wybierz `BleTestEsp32`.
4. PWA przejdzie przez urządzenie, usługę i charakterystykę, automatycznie włączy NOTIFY i wykona READ.
5. W panelu zobaczysz aktualny `millis()`, surowy JSON oraz kolejne powiadomienia co około sekundę.

Jeżeli powiadomienia są wyłączone, przycisk **Włącz powiadomienia** pozwala uruchomić je ponownie. **Pobierz millis()** wykonuje pojedynczy odczyt READ.

## UUID

- Service: `7e6d0001-7b9e-4f5b-a6c2-320000000001`
- Characteristic: `7e6d0002-7b9e-4f5b-a6c2-320000000002`
