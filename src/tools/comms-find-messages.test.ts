import { describe, expect, it } from "vitest";
import { htmlToText, projectMessage, runCommsFindMessages } from "./comms-find-messages.js";

// Row shapes copied from api-test GET /messages (2026-10-09): one union row per
// message, the real fields nested under outbound / inbound / sms.
describe("projectMessage", () => {
  it("projects a sent course email with template, status and opened", () => {
    expect(
      projectMessage({
        type: "outbound",
        outbound: {
          id: 166410,
          order_id: 52816,
          order_type: "course",
          email: "parent@example.com",
          status: "sent",
          tag: "event_notification",
          subject: "Termín - *|EVENT_COURSE|*",
          sent_by: "martin@zooza.sk",
          created: "2026-10-06 12:05:02",
          opened: null,
        },
      }),
    ).toEqual({
      type: "email",
      id: 166410,
      registration_id: 52816,
      created: "2026-10-06 12:05:02",
      contact: "parent@example.com",
      subject: "Termín - *|EVENT_COURSE|*",
      template: "event_notification",
      status: "sent",
      opened: undefined,
      sent_by: "martin@zooza.sk",
    });
  });

  it("drops emails that are not about a course booking (system mails, product orders)", () => {
    expect(projectMessage({ type: "outbound", outbound: { id: 1, order_type: "", tag: "zooza_login" } })).toBeNull();
    expect(projectMessage({ type: "outbound", outbound: { id: 2, order_type: "product" } })).toBeNull();
  });

  it("keeps the rejection reason with the status", () => {
    const row = projectMessage({
      type: "outbound",
      outbound: { id: 3, order_type: "course", status: "rejected", reject_reason: "hard-bounce" },
    });
    expect(row?.status).toBe("rejected: hard-bounce");
  });

  it("shortens reply and sms text", () => {
    const long = "word ".repeat(200);
    const reply = projectMessage({ type: "inbound", inbound: { id: 9, order_id: 5, from: "a@b.c", message: long } });
    expect(reply?.type).toBe("reply");
    expect(reply?.text?.length).toBe(301);
    const sms = projectMessage({ type: "sms", sms: { id: 7, registration_id: 5, phone: "+421", message: "Ahoj", status: "delivered" } });
    expect(sms).toMatchObject({ type: "sms", registration_id: 5, text: "Ahoj", status: "delivered" });
  });
});

describe("htmlToText", () => {
  it("drops style blocks and tags, keeps line breaks and merge tags", () => {
    const html = "<html><head><style>td{color:red}</style></head><body><p>Dobrý deň&nbsp;*|FNAME|*</p><div>Zajtra o *|EVENT_TIME|*</div></body></html>";
    expect(htmlToText(html)).toBe("Dobrý deň *|FNAME|*\nZajtra o *|EVENT_TIME|*");
  });
});

describe("runCommsFindMessages guards", () => {
  const auth = { mode: "legacy", apiKey: "", company: "", legacyToken: "", baseUrl: "http://unused" } as never;

  it("requires a client", async () => {
    const r = await runCommsFindMessages({ company_id: 1 }, auth);
    expect(r.isError).toBe(true);
  });

  it("requires registration_id with message_id", async () => {
    const r = await runCommsFindMessages({ company_id: 1, user_id: 5, message_id: 9 }, auth);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("registration_id");
  });
});
