# BleTest - podsumowanie projektu

## Status

Projekt osiągnął działający prototyp transferu archiwalnej trasy GPS z
Waveshare ESP32-S3-Zero do telefonu z Androidem przez Web Bluetooth.

Ostatni potwierdzony pomiarem użytkownika transfer:

- czas: `1.65 s`,
- redukcja danych na łączu: `2.67x`,
- prędkość transferu delta: `17.7 KiB/s`,
- przepływność: `145.0 kbit/s`.

Kod znajduje się na `main` i jest zsynchronizowany z GitHubem.

## Cel

Pierwotny cel był prosty: sprawdzić, jak szybko można przesłać większy plik
CSV z ESP32 do aplikacji webowej na telefonie, bez przełączania telefonu na
Wi-Fi. Dane mają docelowo pochodzić z karty SD i przypominać typowy ślad GPS,
czyli kolejne punkty są położone blisko siebie.

Wymagania praktyczne:

- komunikacja wyłącznie przez BLE,
- odbiór w Chrome na Androidzie,
- brak ręcznego przełączania sieci telefonu,
- zachowanie precyzji współrzędnych,
- wykrywanie zgubionych ramek,
- możliwość zapisania wyniku jako zwykłego CSV,
- pomiar rzeczywistego czasu i przepływności.

## Obecna architektura

### Firmware

Plik: `firmware/BleTestEsp32/BleTestEsp32.ino`

ESP32 reklamuje urządzenie `BleTestEsp32` z jedną usługą GATT i trzema
charakterystykami:

- `route info` - `READ`, metadane transferu,
- `route control` - `WRITE`, komendy sterujące,
- `route data` - `NOTIFY`, strumień danych.

UUID-y są zdefiniowane w firmware i PWA. Usługa ma identyfikator
`7e6d0001-7b9e-4f5b-a6c2-320000000001`.

ESP32 ustawia lokalny MTU na `517`. Rzeczywisty MTU jest negocjowany z
telefonem. Ramka NOTIFY ma:

- 4 bajty numeru sekwencyjnego little-endian,
- do 240 bajtów danych, gdy klient pozwala na większy MTU.

Przy domyślnym MTU 23 payload danych wynosi 16 bajtów.

### Protokół transferu

Cykl transferu wygląda tak:

1. PWA włącza NOTIFY na `route data`.
2. PWA wysyła `START` przez `route control`.
3. ESP32 wysyła maksymalnie 8 ramek w jednym oknie.
4. PWA zapisuje i dekoduje dane.
5. Po całym oknie PWA wysyła `ACK:<next_sequence>`.
6. Jeżeli PWA wykryje lukę w numerach, wysyła `NACK:<expected_sequence>`.
7. ESP32 oblicza offset i retransmituje dane od żądanej sekwencji.
8. Po ostatniej ramce i potwierdzeniu ESP32 oznacza transfer jako zakończony.

Komenda `STOP` przerywa transfer.

### Kodowanie `delta-v1`

Finalny transfer nie przesyła bezpośrednio tekstu CSV. Generator tworzy drugą
reprezentację danych:

```text
t_ms,latitude,longitude
0,52229700,21033200
100,13,0
100,12,0
100,13,-1
```

Pierwszy punkt zawiera wartości absolutne. Każdy następny rekord zawiera
różnicę czasu oraz różnice współrzędnych zapisanych jako liczby całkowite w
milionowych częściach stopnia. PWA sumuje różnice i formatuje współrzędne z
powrotem do sześciu miejsc po przecinku.

Dla domyślnej trasy testowej:

- 3000 punktów,
- surowy CSV: `79 912 B` około `78.0 KiB`,
- strumień delta: `29 926 B`,
- redukcja: `2.67x`.

Generator weryfikuje, że odtworzony CSV jest identyczny z wygenerowanym CSV.
Firmware przechowuje w wygenerowanym `route_data.h` strumień delta, rozmiar
docelowego CSV i CRC32 docelowego CSV.

### PWA

Plik: `web/app.js`

PWA:

- wyszukuje urządzenie po UUID usługi,
- odkrywa charakterystyki GATT,
- włącza NOTIFY,
- dekoduje ramki i obsługuje sekwencje,
- wysyła ACK/NACK,
- odtwarza CSV z `delta-v1`,
- liczy CRC32 odtworzonego CSV,
- sprawdza liczbę punktów i rozmiar pliku,
- zapisuje dane strumieniowo do OPFS,
- używa bufora `Blob`, gdy OPFS nie jest dostępne,
- pozwala zatrzymać transfer i pobrać wynikowy CSV.

Zapis do OPFS jest buforowany do jednego zapisu na całe okno 8 ramek. To jest
istotne dla wydajności.

### Deployment

Plik: `.github/workflows/deploy-pages.yml`

Każdy push do `main` publikuje katalog `web` na GitHub Pages:

`https://dasiuss.github.io/BleTest/`

Service Worker cache jest wersjonowany w `web/sw.js`, aby telefon nie używał
starego `app.js` po wdrożeniu zmian.

## Co udało się zrobić

- Zbudowano działający serwer BLE na ESP32-S3.
- Dodano PWA z Web Bluetooth i diagnostyką połączenia.
- Dodano pomiar READ/NOTIFY i osobny benchmark transferu trasy.
- Zwiększono użyteczny payload przez negocjację MTU.
- Zastąpiono serię pojedynczych READ strumieniem NOTIFY.
- Dodano numery sekwencyjne, okna, ACK, NACK i retransmisję.
- Dodano walidację ramki, rozmiaru, liczby punktów i CRC32.
- Dodano zapis strumieniowy do OPFS z fallbackiem do Blob.
- Dodano kodowanie różnic kolejnych punktów GPS.
- Zachowano dokładność sześciu miejsc po przecinku.
- Uzyskano działający test telefonu bez przełączania na Wi-Fi.
- Skrócono potwierdzony czas transferu do `1.65 s`.
- Zmniejszono ilość danych przesyłanych BLE o `2.67x`.
- Naprawiono problem kompilacji Arduino z wywołaniem `min(uint16_t, int)`.
- Naprawiono problem wydajności PWA spowodowany tysiącami małych zapisów OPFS.
- Wersjonowanie Service Workera zapobiega użyciu starej wersji aplikacji.

## Podejścia, które nie zostały w finalnej wersji

### Runtime zlib/DEFLATE na ESP32

Przetestowano kilka wariantów kompresji z użyciem vendored `miniz`:

- dodanie `miniz.c` i `miniz.h`,
- przeniesienie kompresji poza stos NimBLE,
- kolejkowanie skompresowanych danych przez BLE.

To podejście zostało wycofane. Finalny firmware nie zawiera `miniz`, nie
kompresuje danych w czasie transferu i nie używa zlib po stronie PWA.
Dokładny, porównywalny wynik wydajnościowy tych wariantów nie został zapisany
w dokumentacji, dlatego nie należy traktować ich jako działającej ścieżki.

### Bezpośredni transfer surowego CSV

Bezpośredni CSV przez NOTIFY działał i osiągnął około `21.3 KiB/s` w jednym z
testów. Był jednak ograniczony większą liczbą ramek, dlatego zastąpiono go
`delta-v1`.

### Pierwsza wersja delta

Pierwsza implementacja delta przesyłała mniej danych, ale PWA wykonywała
osobny zapis OPFS dla praktycznie każdego z około 3000 rekordów. Firmware
czekał na zakończenie zapisów przed ACK, więc wynik był paradoksalnie gorszy:

- czas: `3.25 s`,
- delta wire: `9.0 KiB/s`,
- przepływność: `73.7 kbit/s`.

Buforowanie do jednego zapisu na okno rozwiązało problem. Po poprawce wynik
wyniósł `1.65 s`, `17.7 KiB/s` i `145.0 kbit/s`.

## Znane ograniczenia

- Firmware nie został jeszcze podłączony do karty SD. Obecnie dane testowe są
  generowane przez `tools/generate_route.js` i kompilowane do `PROGMEM`.
- `delta-v1` jest przygotowywane offline przez generator. Nie ma jeszcze
  uniwersalnego enkodera, który czytałby dowolne rekordy GPS z SD i kodował je
  strumieniowo na ESP32.
- Obecne delta encoding jest tekstowe. Format binarny z varintami mógłby
  jeszcze zmniejszyć transfer, ale nie jest obecnie potrzebny do osiągnięcia
  celu.
- Nie wykonano pełnych testów na wielu modelach telefonów, różnych wersjach
  Chrome ani przy wymuszonym MTU 23.
- Nie ma jeszcze osobnego timeoutu dla przypadku, w którym zaginie ostatnia
  ramka lub końcowy ACK. Taki przypadek może pozostawić transfer w oczekiwaniu.
- Nie ma automatycznego testu sprzętowego i CI nie kompiluje szkicu Arduino.
- CRC jest generowane dla aktualnych danych testowych. Przy przejściu na SD
  trzeba będzie liczyć CRC podczas odczytu albo uzyskać metadane pliku z innego
  źródła.
- Po zmianie firmware i PWA trzeba uważać na cache Service Workera; obecne
  wersjonowanie rozwiązuje typowy przypadek, ale wdrożenie Pages może chwilę
  propagować się na telefon.

## Najważniejsze pliki

- `firmware/BleTestEsp32/BleTestEsp32.ino` - serwer BLE i protokół transferu.
- `firmware/BleTestEsp32/route_data.h` - wygenerowany strumień delta testowej trasy.
- `tools/generate_route.js` - generator CSV, delta encoding i walidacja generatora.
- `web/app.js` - PWA, odbiór NOTIFY, ACK/NACK, dekoder i walidacja CSV.
- `web/index.html` - interfejs testu transferu.
- `web/styles.css` - wygląd PWA.
- `web/sw.js` - cache offline i wersjonowanie assetów.
- `web/manifest.webmanifest` - manifest PWA.
- `.github/workflows/deploy-pages.yml` - wdrożenie GitHub Pages.
- `README.md` - instrukcja instalacji i testu.

## Uruchomienie obecnego testu

1. Wygeneruj dane: `node tools/generate_route.js`.
2. W Arduino IDE wybierz `ESP32S3 Dev Module`.
3. Wgraj `firmware/BleTestEsp32/BleTestEsp32.ino`.
4. Otwórz `https://dasiuss.github.io/BleTest/` w Chrome na Androidzie.
5. Połącz się z `BleTestEsp32`.
6. Naciśnij **Pobierz trasę**.
7. Sprawdź status `OK`, CRC32, liczbę punktów, redukcję i czas transferu.

## Następne kroki

1. Zintegrować odczyt rekordów z karty SD.
2. Oddzielić format źródłowy GPS od testowego generatora.
3. Dodać enkoder `delta-v1` działający przy odczycie z SD.
4. Dodać timeout i automatyczne ponowienie końcowego okna/ACK.
5. Przetestować MTU 23, MTU 247 i kilka modeli Androida.
6. Dodać automatyczny test dekodera PWA dla celowo pociętych ramek i
   retransmisji.
7. Dopiero później rozważyć binarne delta/varint, jeśli pomiary z karty SD
   będą tego wymagały.

## Historia najważniejszych commitów

- `e72f725` - rozbudowa laboratorium charakterystyk BLE.
- `7f2c3b0` - dodanie benchmarku transferu trasy GPS.
- `7f895fe` - dodanie vendored `miniz`.
- `52543d1` - przeniesienie kompresji poza stos NimBLE.
- `16e5d29` - kolejkowanie kompresowanego transferu BLE.
- `38b3648` - usunięcie runtime compression i powrót do prostszego transportu.
- `1a63c0e` - strumień trasy przez BLE NOTIFY.
- `18a9f7f` - poprawka dedukcji typów w `min()`.
- `566d3aa` - dodanie `delta-v1`.
- `e93eeb3` - buforowanie zapisów odtworzonego CSV.
- `2e1a198` - odświeżenie cache PWA po batching zapisów.
