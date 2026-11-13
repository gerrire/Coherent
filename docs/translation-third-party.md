# Сторонние компоненты локального перевода

В этом файле указаны источники, авторство и лицензии компонентов функции живого перевода. Веса загружаются клиентом отдельно; среда выполнения и фонемизатор входят в ресурсы веб-приложения. Лицензии моделей, кода и данных учитываются отдельно. Это перечень используемых источников и уведомлений, а не заключение о лицензировании всего проекта.

## Распознавание и перевод

| Компонент | Авторство и источник | Лицензия по карточке / репозиторию |
| --- | --- | --- |
| Whisper Tiny, Base и Small, q8 ONNX | [Xenova/whisper-tiny](https://huggingface.co/Xenova/whisper-tiny), [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base), [Xenova/whisper-small](https://huggingface.co/Xenova/whisper-small/blob/2d67713f236afa48a18992566e7647f6ca848e13/README.md); исходная модель и код [OpenAI Whisper](https://github.com/openai/whisper) | Карточки ONNX-конверсий: Apache-2.0; исходный Whisper: [MIT](https://github.com/openai/whisper/blob/main/LICENSE) |
| OPUS-MT en → ru / fr / es | Helsinki-NLP / OPUS-MT; конверсии [Xenova/en-ru](https://huggingface.co/Xenova/opus-mt-en-ru), [en-fr](https://huggingface.co/Xenova/opus-mt-en-fr), [en-es](https://huggingface.co/Xenova/opus-mt-en-es) | Apache-2.0 |
| OPUS-MT en → de | [Helsinki-NLP/opus-mt-en-de](https://huggingface.co/Helsinki-NLP/opus-mt-en-de); [ONNX-конверсия Xenova](https://huggingface.co/Xenova/opus-mt-en-de) | CC-BY-4.0 |
| OPUS-MT ru → en | [Helsinki-NLP/opus-mt-ru-en](https://huggingface.co/Helsinki-NLP/opus-mt-ru-en); [ONNX-конверсия Xenova](https://huggingface.co/Xenova/opus-mt-ru-en) | CC-BY-4.0 |
| OPUS-MT de / fr / es → en | Helsinki-NLP / OPUS-MT: [de-en](https://huggingface.co/Helsinki-NLP/opus-mt-de-en), [fr-en](https://huggingface.co/Helsinki-NLP/opus-mt-fr-en), [es-en](https://huggingface.co/Helsinki-NLP/opus-mt-es-en); конверсии [Xenova/de-en](https://huggingface.co/Xenova/opus-mt-de-en), [fr-en](https://huggingface.co/Xenova/opus-mt-fr-en), [es-en](https://huggingface.co/Xenova/opus-mt-es-en) | Apache-2.0 |

Для моделей CC-BY-4.0: авторы — Helsinki-NLP / OPUS-MT; в приложении используется квантованная ONNX-конверсия Xenova для локального вывода. Coherent не дообучает и не изменяет скачиваемые файлы весов. [Условия CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). SHA-ревизии Whisper закреплены в `frontend/src/lib/translation/models.ts` (Small: `2d67713f236afa48a18992566e7647f6ca848e13`), каждого направления Marian — в `frontend/src/lib/translation/model.worker.ts`. Выбор «Авто» меняет только локальный выбор Tiny / Base; пользовательский выбор Small не меняет источники и лицензии моделей.

## Русский голос и фонемизация

- Голос **Denis medium**: модель Piper из [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), ревизия `2f358b6a560e3a913ebf509b2f3344f20b367f94`. [Карточка Denis](https://huggingface.co/rhasspy/piper-voices/blob/2f358b6a560e3a913ebf509b2f3344f20b367f94/ru/ru_RU/denis/medium/MODEL_CARD) указывает **CC0** и дообучение от базового rdh. [Карточка rdh](https://huggingface.co/rhasspy/piper-voices/blob/2f358b6a560e3a913ebf509b2f3344f20b367f94/nl/nl_BE/rdh/medium/MODEL_CARD) указывает **CC0 1.0 Universal**. [Текст CC0](https://creativecommons.org/publicdomain/zero/1.0/).
- `@mintplex-labs/piper-tts-web@1.0.5`: [Mintplex Labs](https://github.com/Mintplex-Labs/piper-tts-web), MIT. Используется JS-модуль фонемизации; отображение входов ONNX основано на реализации этого проекта.
- `@diffusionstudio/piper-wasm@1.0.0`: [diffusionstudio/piper-wasm](https://github.com/diffusionstudio/piper-wasm), автор Konstantin Paulus; npm-пакет указывает MIT. Используются WASM и данные фонемизатора. Репозиторий описывает сборку из [wide-video/piper-phonemize](https://github.com/wide-video/piper-phonemize) и [rhasspy/espeak-ng](https://github.com/rhasspy/espeak-ng).
- Исходный **Piper Phonemize**: Michael Hansen, 2023, [rhasspy/piper-phonemize](https://github.com/rhasspy/piper-phonemize), [MIT](https://github.com/rhasspy/piper-phonemize/blob/master/LICENSE.md).
- В фонемизаторе используется **eSpeak NG**: проект [eSpeak NG](https://github.com/espeak-ng/espeak-ng), [GNU GPL v3](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING). MIT-лицензии обёрток не заменяют лицензию этого компонента. Исходники варианта eSpeak и шаги сборки WASM доступны по ссылкам выше; сведения о лицензии eSpeak относятся к коду и данным фонемизатора отдельно от CC0-весов голоса.

## Среда выполнения

- [Transformers.js](https://github.com/huggingface/transformers.js), Hugging Face и участники проекта: Apache-2.0, версия `3.8.1`.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime), Microsoft и участники проекта: [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). Для голоса используется `onnxruntime-web@1.31.1`, для распознавания и перевода — совместимая версия из зависимостей Transformers.js; JS/WASM-ресурсы разрешаются из соответствующего установленного пакета.

## Материал проверки

Для двух локальных проверок русского распознавания использовались записи **MINDS-14**, авторы PolyAI: [PolyAI/minds14](https://huggingface.co/datasets/PolyAI/minds14), **CC-BY-4.0**. Для проверки записи были декодированы и преобразованы из 8 кГц в моно PCM 16 кГц; текст эталона и язык взяты из набора. Записи не входят в ресурсы приложения и не используются для дообучения моделей. [Условия CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
