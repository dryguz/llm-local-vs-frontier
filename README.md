# Lokalnie czy w chmurze?

**🔗 Live page: https://dryguz.github.io/llm-local-vs-frontier/**

Statyczny dashboard (GitHub Pages) porównujący modele open-weight z modelami frontier w czterech wymiarach:

1. **Jakość**: Artificial Analysis Intelligence Index v5.0.2 oraz cztery widoki zadaniowe: Coding (FrontierCode 2.0 + Terminal-Bench 4.1), Agentic (AutomationBench), Long documents (GDP.pdf), Factual reliability (Omniscience net score).
2. **Sprzęt**: czy model się mieści (RAM/VRAM) albo czy da się go uruchomić ze strumieniowaniem ekspertów z SSD (colibri).
3. **Czas**: szacowana prędkość generowania i przetwarzania promptu → czas konkretnego zadania.
4. **Koszt**: prąd lokalnie vs tokeny w API (Anthropic, OpenAI, hosting modeli open-weight), w USD, EUR lub PLN (kursy ECB z Frankfurter, NBP jako zapas).

## Uruchomienie

```bash
python3 -m http.server 8000   # potem http://localhost:8000
node tests/calibrate.mjs      # porównanie silnika z pomiarami colibri
node tests/calibrate.mjs 8    # to samo z innym parametrem skew
```

GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.

## Struktura

| Plik | Zawartość |
|---|---|
| `data/models.json` | modele: indeks AA, parametry całkowite/aktywne, ceny API, wsparcie colibri |
| `data/hardware.json` | maszyny: warstwy pamięci (pojemność, przepustowość), SSD, FLOPS, pobór mocy |
| `data/calibration.json` | pomiary tok/s z README colibri |
| `assets/engine.js` | silnik szacunków (czyste funkcje, działa też w Node) |
| `assets/app.js` | interfejs |

## Model w skrócie

- **Generowanie** (ustalony mechanizm): czas/token ≈ Σ bajty aktywnych wag z warstwy pamięci / (przepustowość × 0,6) + narzut.
- **MoE + SSD** (spekulatywne): część gęsta trafia do najszybszej pamięci, eksperci do puli. Gorący cache obsługuje ułamek c puli jako `1-(1-c)^skew` odwołań; skew = 6,5 dopasowany do jednego pomiaru (GLM-5.2, Ryzen AI Max+ 395).
- **Prompt** (spekulatywne): 2 × aktywne parametry × tokeny / efektywne FLOPS, a w trybie SSD dodatkowo odczyt puli z SSD raz na fragment promptu (2048 tokenów).
- **Prąd**: moc × czas × cena kWh. Bez amortyzacji sprzętu.

## Znane ograniczenia (v0.1)

- Dla małych MoE na CPU silnik zawyża prędkość około 4–5× (reżim obliczeniowy i narzut silnika nie są modelowane).
- FLOPS i pobór mocy w `hardware.json` to szacunki. Warto je zastąpić pomiarami (`llama-bench`, watomierz).
- Brak amortyzacji sprzętu, multi-GPU, cache promptów i cen batch.
- Indeks AA jest jedną liczbą. Na najtrudniejszych zadaniach luka bywa większa.

## Do zrobienia

- [ ] Automatyczna aktualizacja danych z API Artificial Analysis (GitHub Action).
- [ ] Amortyzacja sprzętu (cena / lata użytkowania) jako opcjonalny składnik kosztu.
- [ ] Import własnych pomiarów (`llama-bench` JSON).
- [ ] Osobna kalibracja dla CPU (składnik obliczeniowy w decode).
