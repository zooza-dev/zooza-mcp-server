import { describe, expect, it } from "vitest";
import { runBookingsAddLead } from "./bookings-add-lead.js";

const AUTH = { apiKey: "k", legacyToken: "t", company: "1" } as never;

describe("bookings_add_lead — input validation (pre-network)", () => {
  it("refuses when the email is missing", async () => {
    const r = await runBookingsAddLead(
      { company_id: 1, schedule_id: 6529, first_name: "Jana", last_name: "Novak" },
      AUTH,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("first_name, last_name and email");
  });

  it("refuses when the schedule_id is missing", async () => {
    const r = await runBookingsAddLead(
      { company_id: 1, first_name: "Jana", last_name: "Novak", email: "jana@example.com" },
      AUTH,
    );
    expect(r.isError).toBe(true);
  });
});
