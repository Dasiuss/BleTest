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

Firmware `v4.8` jest finalnym kandydatem z bezpośrednim sprawdzaniem mbufów
NimBLE przed wysłaniem. Został skompilowany, ale nie ma jeszcze potwierdzenia
sprzętowego po tej zmianie. PWA `v4.9` jest zgodna z protokołem `v4` i została
wypchnięta na `main` razem z dokumentacją; po zmianie opisu finalnego mechanizmu
bieżąca wersja PWA to `v4.9`.

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
- monitor szeregowy: `115200`.

Weryfikacja firmware:

```text
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/BleTestEsp32
```

Ostatni build firmware `v4.8`:

- program: `669340 B` (`51%` z `1310720 B`),
- zmienne globalne: `227984 B` (`69%` z `327680 B`),
- pozostały zapas RAM dla stosu i zmiennych lokalnych: `99696 B`.

Firmware użytkownik wgrywa ręcznie przez Arduino IDE. Nie należy wykonywać
automatycznego uploadu bez wyraźnej prośby.

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

Firmware `v4.8` ma `ROUTE_TEST_REPEATS = 10`, więc w trybie testowym odczytuje
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

## Finalna kontrola wysyłania

Arduino `BLECharacteristic::notify()` jest niewystarczające jako interfejs
produkcyjny, ponieważ:

- nie zwraca wyniku,
- ukrywa `ble_gatts_notify_custom()`,
- wrapper tworzy mbuf przez `ble_hs_mbuf_from_flat()` bez udostępnienia stanu,
- nie można bezpiecznie rozróżnić przyjęcia ramki od braku pamięci.

Firmware `v4.8` używa bezpośrednio API NimBLE:

```text
ble_hs_mbuf_from_flat(frame, length)
ble_gatts_notify_custom(conn_handle, characteristic_handle, mbuf)
```

Przed alokacją sprawdzane jest także `os_msys_num_free()`. Firmware utrzymuje
`ROUTE_NIMBLE_MBUF_RESERVE = 6` wolnych bloków dla odpowiedzi ATT i innego ruchu
BLE. Sam odczyt licznika nie jest traktowany jako gwarancja, ponieważ między
sprawdzeniem a alokacją może wystąpić wyścig; dlatego zawsze sprawdzany jest
również wynik `ble_hs_mbuf_from_flat()` i `ble_gatts_notify_custom()`.

Reguły:

- jeśli liczba wolnych bloków MSYS jest nie większa niż rezerwa, ramka pozostaje pending,
- jeśli `ble_hs_mbuf_from_flat()` zwróci `nullptr`, ramka pozostaje pending,
- jeśli `ble_gatts_notify_custom()` zwróci błąd, ramka pozostaje pending,
- w żadnym z tych przypadków nie zwiększa się numer sekwencyjny,
- nie zwiększa się liczba ramek in-flight,
- skompresowany payload pozostaje w buforze ramki,
- kolejna próba następuje po normalnym interwale pacingu,
- `ble_gatts_notify_custom()` zużywa mbuf także przy błędzie, więc nie wolno
  zwalniać go drugi raz.

`BLECharacteristic::getHandle()` i `BLEServer::getConnId()` są publicznie
dostępne i wystarczają do tego wywołania dla jednego połączenia.

Nie używamy prywatnego `ble_hs_hci_avail_pkts` jako głównego mechanizmu. Jest
to informacja o kredytach kontrolera, a nie pełny obraz dostępności mbufów
GATT. Ostatecznym sprawdzeniem jest wynik alokacji mbuf i wynik wysłania.

Pacing pozostaje stały:

```text
ROUTE_NOTIFY_INTERVAL_MS = 4
```

4 ms jest tylko minimalnym odstępem między próbami. Nie jest gwarancją, że
NimBLE przyjmie ramkę. Kontrola zasobów odbywa się niezależnie przed każdym
wysłaniem. Jeśli warunki radiowe się pogorszą, firmware może próbować później
bez nadpisania pending frame; przy całkowitym zaniku połączenia transfer ma
zakończyć się przez istniejące timeouty.

## Okno i pamięć

Aktualne wartości:

```text
ROUTE_NOTIFY_WINDOW_SIZE = 128
ROUTE_NOTIFY_ACK_BLOCK_SIZE = 32
ROUTE_MAX_FRAME_SIZE = 244
```

128 slotów używa około `32 KiB`, a build pozostawia około `100 KiB` zapasu.
Okno jest celowo większe od puli NimBLE, ponieważ nie służy do jej
bezpośredniego zapełniania. Dzięki pending frame liczba przyjętych przez
NimBLE mbufów jest ograniczona przez faktyczne zasoby stosu, a nie przez
rozmiar naszego pierścienia.

Rezerwa `6` nie jest utożsamiana z pełną pulą `MSYS_1`. W używanym pakiecie
ESP32-S3 konfiguracja ma `12` bloków bazowych, port ESP32 dodaje zapas, a
`MYNEWT_VAL_MSYS_1_BLOCK_COUNT` wynosi około `20`. Pula jest współdzielona,
dlatego rezerwa jest konserwatywna i nadal weryfikowana wynikiem alokacji.

Nie należy utożsamiać `inflight_chunks` z liczbą pakietów, które można
bezwarunkowo przekazać do `notify()`. Każda próba musi przejść przez ścieżkę
kontrolowaną.

## Profilowanie

Firmware wypisuje po sukcesie:

```text
[PROFILE] ROUTE summary
[PROFILE] total=... first_notify=... notify_span=...
[PROFILE] compression=... calls=... max=...
[PROFILE] notify=... calls=... avg=... max=... normal=... replay=... no_mbuf=... errors=... interval=4 ms
[PROFILE] ack=... nack=... timeouts=... replays=... ack_wait=...
[PROFILE] output=... compressed_bytes=... notify_total=... repeats=...
```

Znaczenie:

- `compression` - czas CPU w `tdefl_compress`; nie jest to cały czas transferu.
- `notify` - koszt kontrolowanej próby alokacji mbuf i przekazania ramki do NimBLE.
- `no_mbuf` - próba zatrzymana przed wywołaniem GATT z powodu braku mbufa.
- `errors` - niezerowy wynik `ble_gatts_notify_custom()`.
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

## Wersjonowanie

Wersja protokołu i wersja wydania są rozdzielone:

- `ROUTE_PROTOCOL_VERSION = "v4"` - kompatybilność wire protocol,
- `FIRMWARE_VERSION` - wersja firmware,
- `APP_VERSION` - wersja PWA.

PWA sprawdza `routeInfo.version` względem protokołu `v4`, a nie względem
własnej wersji wydania. Dzięki temu PWA `v4.9` może działać z firmware `v4.8`.

Po każdej zmianie PWA trzeba:

1. podbić `APP_VERSION`,
2. podbić nazwę cache w `web/sw.js`,
3. zaktualizować widoczną wersję,
4. wykonać `node --check web/app.js`,
5. zacommitować i wypchnąć zmianę na `main`.

Firmware użytkownik wgrywa ręcznie i nie wymaga osobnego commita, chyba że
jest to jawnie potrzebne.

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
- Bezpośrednia ścieżka NimBLE jest finalnym kandydatem, ale wymaga potwierdzenia sprzętowego po wgraniu.
- CI nie kompiluje szkicu Arduino.
- Przy całkowitym zaniku połączenia istnieją timeouty ACK, ale nie ma osobnego raportu przyczyny na poziomie radia.

## Następne kroki po walidacji v4.8

1. Wgrać firmware `v4.8` i wykonać test trasy `10x` z PWA `v4.9`.
2. Potwierdzić `no_mbuf=0`, `errors=0`, `nack=0` i poprawne CRC.
3. Wymusić kontrolowane opóźnienie/zakłócenie i potwierdzić, że pending frame nie przesuwa sekwencji.
4. Przetestować MTU 23, 247 i obecne MTU 517.
5. Zmierzyć większy rozmiar payloadu, np. 480-500 B, jako osobny eksperyment.
6. Dopiero po stabilizacji transportu podłączyć odczyt z karty SD.
7. Rozważyć szybszy profil miniz tylko przez porównanie czasu CPU i rozmiaru wire.
