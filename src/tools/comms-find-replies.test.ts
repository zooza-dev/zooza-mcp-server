import { describe, expect, it } from "vitest";
import { runCommsFindReplies } from "./comms-find-replies.js";

const AUTH = { apiKey: "k", legacyToken: "t", company: "1" } as never;

describe("comms_find_replies — mode guards (pre-network)", () => {
  it("requires mark_state when mark_reply_id is given", async () => {
    const r = await runCommsFindReplies({ company_id: 1, mark_reply_id: 551 }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("mark_state is required");
  });

  it("refuses an unfiltered read so it never dumps every reply", async () => {
    const r = await runCommsFindReplies({ company_id: 1 }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("refusing to dump every reply");
  });
});
