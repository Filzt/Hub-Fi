// Data do despacho pelo histórico do envio (formato real do ML, envio 48087582754).
import { test } from "node:test";
import assert from "node:assert/strict";
import { despachoDoEnvio } from "../src/despacho.ts";

const hist = (...subs: Array<[string, string]>) => subs.map(([substatus, date]) => ({ substatus, date, status: "ready_to_ship" }));

test("despacho = 1º dropped_off (bipe na agência), não a data em que o SkyHub viu", () => {
  const s = {
    status: "shipped",
    status_history: { date_shipped: "2026-09-25T01:56:07.618-04:00" },
    substatus_history: hist(["ready_to_print", "2026-09-24T06:18:13.570-04:00"], ["dropped_off", "2026-09-24T08:37:51.986-04:00"], ["picked_up", "2026-09-24T09:35:00.000-04:00"]),
  };
  assert.equal(despachoDoEnvio(s), Date.parse("2026-09-24T08:37:51.986-04:00"));
});

test("impresso ou aguardando transportadora não conta como despachado", () => {
  assert.equal(despachoDoEnvio({ status: "ready_to_ship", substatus_history: hist(["waiting_for_carrier_authorization", "2026-09-24T06:18:11.844-04:00"], ["printed", "2026-09-24T07:00:00.000-04:00"]) }), null);
});

test("sem dropped_off/picked_up, usa a data de shipped; shipped sem data = 0", () => {
  assert.equal(despachoDoEnvio({ status: "shipped", status_history: { date_shipped: "2026-09-25T10:00:00.000-03:00" } }), Date.parse("2026-09-25T10:00:00.000-03:00"));
  assert.equal(despachoDoEnvio({ status: "delivered" }), 0);
});
