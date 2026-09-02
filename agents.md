# BleTest - stan i ustalenia projektu

## Cel

Projekt mierzy transfer większego pliku NMEA CSV z Waveshare ESP32-S3-Zero do
Chrome na Androidzie wyłącznie przez BLE. Telefon nie przełącza się na Wi-Fi.

Wymagania docelowe:

- transfer przez BLE GATT NOTIFY,
- odbiór w Chrome na Androidzie przez Web Bluetooth,
- zachowanie danych NMEA bez zmian,
- wykrywanie utraconych ramek i retransmisja,
- zapis wyniku jako zwykłego CSV,
- pomiar czasu, przepływności i kosztu poszczególnych etapów.

## Aktualny stan

Ostatni potwierdzony test sprzętowy użytkownika został wykonany na firmware
`v4.5` i PWA `v4.6`, z trasą bazową wysłaną 10 razy:

- surowy wynik: `1 001 000 B` (`977.5 KiB`),
- skompresowany wire: `109 532 B` (`107.0 KiB`),
- redukcja: `9.14x`,
- czas strumienia BLE: około `3.44 s`,
- bitrate skompresowany: `30.5 KiB/s` (`249.6 kbit/s`),
- brak `NACK`, retransmisji i błędów NimBLE.

Firmware `v5` jest kandydatem opartym na najszybszym potwierdzonym profilu
z `BLECharacteristic::notify()`. Został skompilowany, ale nie ma jeszcze potwierdzenia
sprzętowego po tej zmianie. PWA `v5` jest zgodna z protokołem `v4` i została
wypchnięta na `main` razem z dokumentacją; po zmianie opisu finalnego mechanizmu
bieżąca wersja PWA to `v5`.

## Najważniejsze pliki

- `firmware/BleTestEsp32/BleTestEsp32.ino` - serwer BLE, kompresja, okno ramek i retransmisje.
- `firmware/BleTestEsp32/miniz.h` i `miniz.c` - lokalny kompresor zlib/DEFLATE.
- `firmware/BleTestEsp32/route_data.h` - wygenerowany bazowy NMEA CSV w `PROGMEM`.
- `tools/generate_route.js` - generator deterministycznych zdań NMEA.
- `web/app.js` - Web Bluetooth, odbiór, dekompresja, ACK/NACK, zapis i profil PWA.
- `web/index.html` - interfejs testu i szczegółowy log protokołu.
- `web/sw.js` - cache PWA; wersja cache musi być podbijana po zmianie assetów.
- `README.md` - skrócona instrukcja użytkownika.
- `agents.md` - pełny kontekst techniczny i historia prób.

## Sprzęt i kompilacja

- płytka: Waveshare ESP32-S3-Zero,
- Arduino FQBN: `esp32:esp32:esp32s3`,
- pakiet ESP32 używany podczas testów: `3.3.11`,
- port używany podczas testów: `COM6`,
- monitor szeregowy: `115200`, uruchamiany jako `arduino-cli monitor --port COM6 --config baudrate=115200,dtr=off,rts=off --quiet`.

Weryfikacja firmware:

```text
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/BleTestEsp32
```

Ostatni build firmware `v5`:

- program: `670396 B` (`51%` z `1310720 B`),
- zmienne globalne: `227976 B` (`69%` z `327680 B`),
- pozostały zapas RAM dla stosu i zmiennych lokalnych: `99704 B`.

Firmware jest wgrywany automatycznie po każdej zmianie firmware, zgodnie z
ustaleniem użytkownika. Przed uploadem należy zwolnić `COM6`, a po uploadzie
uruchomić w tle `arduino-cli monitor --port COM6 --config baudrate=115200,dtr=off,rts=off --quiet`.

## Architektura GATT

Urządzenie reklamuje `BleTestEsp32` i jedną usługę:

```text
Service:       7e6d0001-7b9e-4f5b-a6c2-320000000001
route info:    7e6d0006-7b9e-4f5b-a6c2-320000000006  READ
route control: 7e6d0007-7b9e-4f5b-a6c2-320000000007  WRITE
route data:    7e6d0008-7b9e-4f5b-a6c2-320000000008  NOTIFY
```

Firmware ustawia lokalny MTU na `517`. Rzeczywisty MTU jest negocjowany z
telefonem. Obecny limit aplikacyjny ramki to `244 B`:

- 4 bajty numeru sekwencyjnego little-endian,
- do 240 bajtów danych z ciągłego strumienia zlib/DEFLATE.

Przy MTU 23 dostępne jest tylko 16 bajtów danych. PWA wyświetla uzgodniony
MTU, ale obecna wersja nadal ogranicza ramkę do 244 bajtów.

## Źródło danych testowych

Generator tworzy pełne zdania `GPRMC` i `GPGGA` zakończone `CRLF`, z poprawnymi
sumami kontrolnymi NMEA. Bazowa trasa ma obecnie:

- `700` punktów,
- `1400` linii NMEA,
- `100 100 B` surowego CSV.

Firmware `v5` ma `ROUTE_TEST_REPEATS = 10`, więc w trybie testowym odczytuje
ten sam obszar flash dziesięć razy, tworząc logiczny wynik `1 001 000 B`. CRC,
liczba punktów, liczba linii i rozmiar w `route info` dotyczą całego wyniku.
Powtórzenia służą do wydłużenia testu; przyszły odczyt z karty SD nie będzie
potrzebował tego mechanizmu.

Większy plik bazowy można wygenerować na przykład tak:

```text
node tools/generate_route.js --duration-seconds 300 --frequency-hz 10
```

Plik jest kompilowany do `PROGMEM`; nie jest kopiowany w całości do RAM.
Firmware pobiera porcje po `512 B`, zasila nimi jeden ciągły kompresor i
wysyła wynik strumieniowo. Rozmiar pliku nie jest ograniczony rozmiarem okna
retransmisji.

## Kompresja

Kompresor używa:

```cpp
TDEFL_DEFAULT_MAX_PROBES | TDEFL_WRITE_ZLIB_HEADER | TDEFL_COMPUTE_ADLER32
```

PWA używa natywnego `DecompressionStream("deflate")`. Wynik po dekompresji
jest liczony do CRC32, liczby linii i rozmiaru przed udostępnieniem pobierania.

Nie należy zmieniać profilu kompresji bez pomiaru obu wartości:

- czasu CPU ESP32,
- liczby bajtów przesłanych przez BLE.

Szybsza kompresja może zwiększyć wire i ostatecznie wydłużyć transfer.

## Protokół transferu

1. PWA odkrywa charakterystyki GATT.
2. PWA włącza NOTIFY na `route data`.
3. PWA wysyła `START` przez `route control`.
4. Firmware kompresuje dane w `loop()` i numeruje ramki od zera.
5. PWA akceptuje tylko oczekiwaną sekwencję i przekazuje payload do dekompresora.
6. Co 32 zaakceptowane ramki PWA wysyła `ACK:<next_sequence>`.
7. Firmware może utrzymywać do 128 niepotwierdzonych ramek.
8. Przy luce PWA wysyła `NACK:<expected_sequence>`.
9. Firmware retransmituje ramki z pierścienia od żądanej sekwencji.
10. Pusta ramka jest end markerem; PWA zamyka strumień i potwierdza ją ACK-iem.
11. Firmware kończy transfer dopiero po ACK obejmującym end marker.

Komenda `STOP` przerywa transfer.

Metadane `route info` zawierają między innymi:

- protokół `v4`,
- wersję firmware,
- `raw_bytes`, `compressed_bytes` i `crc32`,
- `repeats`,
- MTU i `chunk_bytes`,
- `window_chunks = 32`,
- `inflight_chunks = 128`.

## Bufor retransmisji a bufory NimBLE

To są dwie niezależne warstwy.

Nasz `routeWindowBuffer[128][244]` przechowuje kopie ramek potrzebne do
retransmisji. Zajmuje około `32 KiB`. Nie jest to kolejka nadawcza BLE.

NimBLE tworzy własne `os_mbuf` dla każdej próby wysłania. W używanym pakiecie
ESP32-S3 pula `MSYS_1` ma rozmiar bloku około `292 B`, a konfiguracja korzysta
z około 20 takich bloków (`12` skonfigurowanych bloków plus zapas portu ESP32).
Pula jest współdzielona z innym ruchem BLE, więc 20 nie oznacza bezpiecznej
liczby równoległych NOTIFY.

Wniosek z eksperymentów: zwiększenie naszego okna pozwalało ukryć opóźnienie
ACK, ale przy zbyt szybkim wywoływaniu `notify()` przepełniało wewnętrzną
pulę NimBLE. Błąd obserwowany na urządzeniu:

```text
E (...) NimBLE: ble_att_svr_pkt rc=6
```

W NimBLE `6` oznacza `BLE_HS_ENOMEM`.

## Kontrola wysyłania

Arduino `BLECharacteristic::notify()` jest niewystarczające jako interfejs
produkcyjny, ponieważ:

- nie zwraca wyniku,
- ukrywa `ble_gatts_notify_custom()`,
- wrapper tworzy mbuf przez `ble_hs_mbuf_from_flat()` bez udostępnienia stanu,
- nie można bezpiecznie rozróżnić przyjęcia ramki od braku pamięci.

Wydanie V5 wraca do sprawdzonej ścieżki Arduino BLE:

```text
routeDataCharacteristic->setValue(frame, frameLength)
routeDataCharacteristic->notify()
```

Ta ścieżka nie zwraca wyniku przyjęcia przez NimBLE. Stabilność zapewnia
sprawdzony stały pacing, a bufor okna i ACK/NACK nadal zapewniają odzyskiwanie
ramek utraconych radiowo.

Pacing pozostaje stały:

```text
ROUTE_NOTIFY_INTERVAL_MS = 4
```

4 ms jest najszybszym potwierdzonym odstępem między próbami. Nie jest
gwarancją, że NimBLE przyjmie ramkę, ale profil V4.5 przeszedł pełny test bez
błędów, NACK i retransmisji. Jeśli warunki radiowe się pogorszą, bufor okna
oraz ACK/NACK obsługują utratę ramek; przy całkowitym zaniku połączenia transfer
ma zakończyć się przez istniejące timeouty.

## Okno i pamięć

Aktualne wartości:

```text
ROUTE_NOTIFY_WINDOW_SIZE = 128
ROUTE_NOTIFY_ACK_BLOCK_SIZE = 32
ROUTE_MAX_FRAME_SIZE = 244
```

128 slotów używa około `32 KiB`, a build pozostawia około `100 KiB` zapasu.
Okno przechowuje kopie ramek potrzebne do retransmisji i nie ogranicza rozmiaru
całego pliku. V5 nie próbuje sterować tempem przez licznik puli NimBLE; stabilność
zapewnia stały pacing `4 ms`, a ACK/NACK i bufor okna obsługują utratę ramek.

Wersja `v4.8` próbowała zachować rezerwę `6` bloków MSYS, ale nie poprawiło to
stabilności. V5 nie używa tego licznika jako regulatora, ponieważ nie opisuje
czasu opróżniania wewnętrznej kolejki ATT.

Nie należy utożsamiać `inflight_chunks` z liczbą pakietów, które można
bezwarunkowo przekazać do `notify()`. V5 polega na sprawdzonym stałym pacingu,
a odzyskiwanie utraconych ramek zapewniają ACK/NACK i bufor okna.

## Profilowanie

Firmware wypisuje po sukcesie:

```text
[PROFILE] ROUTE summary
[PROFILE] total=... first_notify=... notify_span=...
[PROFILE] compression=... calls=... max=...
[PROFILE] notify=... calls=... avg=... max=... normal=... replay=... interval=4 ms
[PROFILE] ack=... nack=... timeouts=... replays=... ack_wait=...
[PROFILE] output=... compressed_bytes=... notify_total=... repeats=...
```

Znaczenie:

- `compression` - czas CPU w `tdefl_compress`; nie jest to cały czas transferu.
- `notify` - koszt wywołań `setValue()` i `notify()`.
- `notify_span` - czas od pierwszej przyjętej ramki do end markeru.
- `ack_wait` - czas oczekiwania na ACK po rozpoczęciu bloków.
- `nack` i `replays` - odzyskiwanie utraconych ramek.
- `timeouts` - retransmisje uruchomione przez timeout ACK.

PWA pokazuje:

- czas strumienia BLE,
- czas callbacków NOTIFY w JS,
- kolejkę i czas `writeValue()` ACK/NACK,
- duplikaty i NACK,
- batching buforów wyjściowych,
- zapis OPFS,
- dekompresję po end markerze,
- walidację końcowego pliku.

Do benchmarku szczegółowy log ramek powinien być wyłączony, bo tworzenie
elementów DOM dla każdej ramki zmienia wynik.

## Historia prób i pomiarów

### Wczesny transfer delta

Pierwsza wersja projektu przesyłała tekstowy `delta-v1` zamiast pełnego NMEA:

- około `3000` punktów,
- redukcja `2.67x`,
- potwierdzony transfer `1.65 s`,
- `17.7 KiB/s`, `145.0 kbit/s`.

Pierwsza wersja PWA zapisywała niemal każdy rekord osobno do OPFS i osiągała
około `3.25 s`. Batching zapisów do jednego zapisu na okno poprawił wynik.

### Surowy CSV i DEFLATE

Bezpośredni surowy CSV przez NOTIFY osiągał w jednym teście około
`21.3 KiB/s`, ale wymagał większej liczby ramek. Zastąpiono go ciągłym
zlib/DEFLATE generowanym w `loop()` ESP32 i dekompresowanym przez PWA.

### Okno 16, ACK co 8

Przy firmware `v4` i małym teście uzyskano około `9.2 KiB/s`. Profil pokazał,
że PWA i OPFS pracują szybko, natomiast `WRITE` ACK trwał około `157 ms` na
komendę, a firmware długo czekał na zwalnianie okna.

### Okno 64, ACK co 32

Zwiększenie okna do 64 i ACK co 32 dało około `28.5 KiB/s` dla krótkiego
testu. Był to duży skok, ponieważ opóźnienia ACK przestały zatrzymywać
produkcję ramek.

### Okno 128, interwał 1 ms

Po włączeniu trasy `10x` i interwału 1 ms wystąpiło:

```text
NimBLE: ble_att_svr_pkt rc=6
ROUTE ACK timeout; transfer stopped
```

To było przepełnienie puli mbufów NimBLE przez fire-and-forget `notify()`,
a nie wyczerpanie pamięci naszego bufora 128 ramek.

### Interwał 8 ms

Firmware `v4.4` ograniczył próby do 8 ms:

- około `5.39 s` dla trasy `10x`,
- około `28.5 KiB/s`,
- `compression` około `1.17 s`,
- brak błędów NimBLE.

8 ms okazało się bezpieczne, ale nie było celem wydajnościowym.

### Interwał 4 ms

Firmware `v4.5` przy 4 ms osiągnął:

- około `3.53 s`,
- `30.5 KiB/s`,
- `467` ramek,
- `0` błędów, `0` NACK i `0` retransmisji.

Średni odstęp między przyjętymi ramkami wynosił około `7.4 ms`, mimo
ustawionego minimum 4 ms. To wskazywało na harmonogram BLE/telefonu oraz
kompresję, a nie na PWA.

### Wersja v4.8 z rezerwą mbufów

Dodanie sprawdzania `os_msys_num_free()` i rezerwy `6` bloków nie usunęło
problemu. Przy pacingu 4 ms wystąpiło ponownie:

```text
NimBLE: ble_att_svr_pkt rc=6
ROUTE ACK timeout; replay from sequence 32 (1/3)
```

To pokazuje, że próg wolnych mbufów nie jest wystarczającym regulatorem
przepustowości ścieżki ATT. Wersja `v5` wraca do najszybszego profilu `4 ms`,
który w wydaniu `v4.5` przechodził pełny test trasy `10x`.

### Wydanie V5

V5 wraca do najszybszego potwierdzonego profilu: protokół wire `v4`,
ciągły zlib/DEFLATE, ramka `244 B` z payloadem `240 B`, okno `128`, ACK co
`32` ramki i stały odstęp NOTIFY `4 ms`. Ten profil osiągnął około `30.5 KiB/s`
przy `0` błędów, `0` NACK i `0` retransmisji w potwierdzonym teście `v4.5`.

## Wersjonowanie

Wersja protokołu i wersja wydania są rozdzielone:

- `ROUTE_PROTOCOL_VERSION = "v4"` - kompatybilność wire protocol,
- `FIRMWARE_VERSION` - wersja firmware,
- `APP_VERSION` - wersja PWA.

PWA sprawdza `routeInfo.version` względem protokołu `v4`, a nie względem
własnej wersji wydania. Dzięki temu PWA `v5` może działać z firmware `v5`.

Po każdej zmianie PWA trzeba:

1. podbić `APP_VERSION`,
2. podbić nazwę cache w `web/sw.js`,
3. zaktualizować widoczną wersję,
4. wykonać `node --check web/app.js`,
5. zacommitować i wypchnąć zmianę na `main`.

Firmware jest wgrywany po każdej zmianie firmware i wymaga zwolnienia `COM6`
przed uploadem. Po uploadzie monitor `arduino-cli monitor --port COM6 --config baudrate=115200,dtr=off,rts=off --quiet` ma być
uruchomiony w tle.

## Deployment

GitHub Actions publikuje katalog `web` po pushu do `main`:

```text
https://dasiuss.github.io/BleTest/
```

Po deploymencie Pages i Service Workera telefon może przez krótki czas używać
starego assetu. Pomaga pełne odświeżenie/reopen strony.

## Obecne ograniczenia

- Brak integracji z kartą SD.
- Brak uniwersalnego enkodera dla dowolnego źródła GPS.
- Testowe `ROUTE_TEST_REPEATS = 10` jest specjalnym trybem benchmarkowym.
- `ROUTE_MAX_FRAME_SIZE = 244`, mimo MTU 517; większe ramki wymagają osobnego testu.
- Nie ma jeszcze pełnych testów na wielu modelach Androida, Chrome i MTU 23.
- Ścieżka `BLECharacteristic::notify()` nie zwraca wyniku przyjęcia przez NimBLE; stabilność V5 opiera się na potwierdzonym pacingu `4 ms`.
- CI nie kompiluje szkicu Arduino.
- Przy całkowitym zaniku połączenia istnieją timeouty ACK, ale nie ma osobnego raportu przyczyny na poziomie radia.

## Następne kroki po walidacji v5

1. Wgrać firmware `v5` i wykonać test trasy `10x` z PWA `v5`.
2. Potwierdzić brak błędów NimBLE, `nack=0`, `timeouts=0` i poprawne CRC.
3. Wymusić kontrolowane opóźnienie/zakłócenie i potwierdzić, że pending frame nie przesuwa sekwencji.
4. Przetestować MTU 23, 247 i obecne MTU 517.
5. Zmierzyć większy rozmiar payloadu, np. 480-500 B, jako osobny eksperyment.
6. Dopiero po stabilizacji transportu podłączyć odczyt z karty SD.
7. Rozważyć szybszy profil miniz tylko przez porównanie czasu CPU i rozmiaru wire.
