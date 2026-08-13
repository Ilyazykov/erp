# ERP Portfolio Valuation Indicator

Исторический индикатор оценки российского портфеля акций.

## Портфель

| Тикер | Вес   | Тип    |
|-------|-------|--------|
| SBER  | 41.7% | Банк   |
| YDEX  | 31.5% | Рост   |
| T     | 17.4% | Банк   |
| OZON  | 7.6%  | Рост   |
| ROSN  | 1.0%  | Нефть  |
| VTBR  | 0.7%  | Банк   |

## Два слоя индикатора

### Layer 1 — аллокация акции/ОФЗ (`charts/composite_layer1.png`)

**Метрика:** Portfolio Earnings Yield − OFZ 10Y  
Earnings Yield = TTM Net Income / Market Cap для всех тикеров.

- ERP > 0 → акции доходнее ОФЗ
- ERP < 0 → ОФЗ доходнее акций

### Layer 2 — ребалансировка внутри портфеля (`charts/composite_layer2.png`)

**Метрика:** Rolling Z-score (окно 36 мес) по лучшей метрике каждого тикера:

| Тикер      | Метрика для z-score       |
|------------|---------------------------|
| SBER, T, VTBR | Earnings Yield (EY)    |
| ROSN       | FCF Yield                 |
| YDEX, OZON | Revenue Yield             |

- Z > +1.5 → бумага дешевле своей 3-летней нормы → докупать
- Z < −1.5 → бумага дороже своей нормы → сокращать

Нижний подграфик: Portfolio Z − OFZ Z = Composite ERP Z — сигнал аллокации через нормализованные данные.

## Источники данных

| Файл | Источник |
|------|----------|
| `data/prices_*.csv` | MOEX ISS |
| `data/quarterly_ni.csv` | Smart-Lab (`/q/{TICKER}/MSFO/net_income/`) |
| `data/annual_extra.csv` | Smart-Lab (FCF, Revenue — годовые) |
| `data/ofz10y_monthly.csv` | ЦБ РФ ZCYC (10Y точка кривой) |

## Корпоративные события

- **VTBR**: обратный сплит 1:4664, июль 2024
- **YNDX→YDEX**: редомициляция, июль 2024 (до этого используются цены YNDX)
- **TCSG→T**: редомициляция, ноябрь 2024 (до этого используются цены TCSG)
- **T**: сплит 1:9.58, апрель 2026

## Скрипты

- `erp_full.py` — базовый ERP (Earnings Yield для всех, CSV + Excel + PNG)
- `composite_valuation.py` — двухслойный индикатор (Layer 1 + Layer 2 z-score)

## Запуск

```bash
python3 composite_valuation.py
```

Выходные файлы сохраняются в `~/Downloads/`.

## Требования

```
matplotlib
openpyxl  # для Excel (опционально)
```
