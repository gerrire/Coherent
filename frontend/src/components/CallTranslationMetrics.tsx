import { useEffect, useState } from "react";
import { readBrowserResources, type TranslationMetrics } from "../lib/translation/metrics";
import { getModelProfile, type TranslationModelId } from "../lib/translation/models";

interface Props {
  id: string;
  metrics: TranslationMetrics;
  model: TranslationModelId;
  recognize: boolean;
}

function seconds(milliseconds: number | null): string {
  return milliseconds === null ? "—" : `${(milliseconds / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с`;
}

function memory(bytes: number | null): string {
  return bytes === null ? "Недоступно" : `${(bytes / 1_048_576).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МиБ`;
}

/** Browser-visible measurements only; no guesses about whole-PC CPU or RAM. */
export default function CallTranslationMetrics({ id, metrics, model, recognize }: Props) {
  const sample = () => ({ processing: metrics.getSnapshot(), browser: readBrowserResources() });
  const [snapshot, setSnapshot] = useState(sample);
  useEffect(() => {
    setSnapshot(sample());
    const timer = setInterval(() => setSnapshot(sample()), 1_000);
    return () => clearInterval(timer);
  }, [metrics]);
  const { processing, browser } = snapshot;
  const profile = getModelProfile(model);
  const stages = [
    { label: "Распознавание", value: processing.recognition },
    { label: "Перевод текста", value: processing.translation },
    { label: "Синтез голоса", value: processing.speech },
  ];
  const ratio = processing.recognition.lastRealtimeFactor;

  return <div id={id} className="call-translation-metrics" role="region" aria-label="Метрики ресурсов перевода">
    <strong>Ресурсы и скорость на этом устройстве</strong>
    <dl className="call-translation-resource-grid">
      <div><dt>Память JavaScript</dt><dd>{memory(browser.jsHeapUsedBytes)}</dd></div>
      <div><dt>Логические процессоры</dt><dd>{browser.logicalProcessors ?? "Недоступно"}</dd></div>
      <div><dt>ОЗУ устройства, оценка браузера</dt><dd>{browser.deviceMemoryGB === null ? "Недоступно" : `≈ ${browser.deviceMemoryGB} ГБ`}</dd></div>
      <div><dt>Фоновые обработчики ИИ</dt><dd>{processing.activeWorkers}</dd></div>
      <div><dt>Выбрано для распознавания</dt><dd>{recognize ? profile.label : "Только приём"}</dd></div>
      <div><dt>Веса распознавания для загрузки</dt><dd>{recognize ? `≈ ${Math.round(profile.weightBytes / 1_000_000)} МБ` : "Не требуются"}</dd></div>
    </dl>
    <div className="call-translation-metrics-table-wrap">
      <table className="call-translation-metrics-table">
        <caption>Время локальной обработки фраз</caption>
        <thead><tr><th scope="col">Этап</th><th scope="col">Сейчас</th><th scope="col">Последняя фраза</th><th scope="col">Готово</th></tr></thead>
        <tbody>{stages.map(({ label, value }) => <tr key={label}>
          <th scope="row">{label}</th>
          <td>{value.phase === "loading" ? `Загрузка · ${seconds(value.currentMs)}` : value.phase === "inference" ? `Обработка · ${seconds(value.currentMs)}` : "Ожидание"}</td>
          <td>{seconds(value.lastInferenceMs)}</td><td>{value.completed}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {ratio !== null && <p className="call-translation-hint">Распознавание / длина аудио: {ratio.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}×. {ratio <= 1
      ? "Последний фрагмент обработан быстрее его длительности."
      : "Последний фрагмент обработан медленнее его длительности. Попробуй модель поменьше."}</p>}
    <p className="call-translation-hint">Пропущено задач при перегрузке или устаревании: {processing.dropped}. Обновление раз в секунду, пока эта панель открыта.</p>
    <p className="call-translation-hint">Измерения накапливаются за звонок. После смены модели время последней фразы обновится при следующем расчёте.</p>
    <p className="call-translation-hint">Браузер не предоставляет общую загрузку CPU и память всего ПК. Память JavaScript не включает всю память моделей и WebAssembly; размер весов — это объём загрузки, а не расход ОЗУ. Системный голос не учитывается как синтез ИИ. Отсутствующие данные показаны как «Недоступно».</p>
  </div>;
}
