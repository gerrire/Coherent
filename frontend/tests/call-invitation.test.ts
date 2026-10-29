import { expect, it } from "vitest";
import { isCallInvitation } from "../src/lib/callInvitation";
it("dismisses accepted/ended invitations even when other group members are still invited", () => {
  const participants = [{ user_id: "self", state: "invited" }, { user_id: "other", state: "invited" }];
  expect(isCallInvitation({ status: "ringing", participants }, "self")).toBe(true);
  expect(isCallInvitation({ status: "active", participants }, "self")).toBe(true);
  expect(isCallInvitation({ status: "ended", participants }, "self")).toBe(false);
  expect(isCallInvitation({ status: "active", participants: [{ user_id: "self", state: "joined" }, participants[1]] }, "self")).toBe(false);
  expect(isCallInvitation({ status: "active", participants: [{ user_id: "self", state: "left" }, participants[1]] }, "self")).toBe(false);
});
