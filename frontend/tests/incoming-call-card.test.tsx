import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import IncomingCallCard from "../src/components/IncomingCallCard";

it("keeps desktop branding when the caller has not loaded or loading fails", () => {
  for (const caller of ["Подключаемся…", "Не удалось загрузить звонок", "3caller"]) {
    const html = renderToStaticMarkup(<IncomingCallCard showBrand caller={caller}
      busy onAccept={() => {}} onDecline={() => {}} />);
    expect(html).toContain('class="brand-mark"');
    expect(html).not.toMatch(/class="incoming-call-avatar">[ПН3]</);
  }
});

it("shows answer and decline controls for a loaded invitation", () => {
  const html = renderToStaticMarkup(<IncomingCallCard showBrand caller="Друг"
    busy={false} onAccept={() => {}} onDecline={() => {}} />);
  expect(html).toContain("Ответить");
  expect(html).toContain("Отклонить");
  expect(html).not.toContain("disabled");
});
