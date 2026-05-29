/**
 * MCP App view for the interactive attendance roster (ZMCP-20260529-001, EXPERIMENTAL).
 *
 * Runs inside the host's sandboxed iframe. Receives the `get_attendance_roster`
 * tool result (its `structuredContent`), renders one row per attendee with a
 * toggle per `allowed_statuses[]`, and writes via the existing `mark_attendance`
 * tool through the host bridge. After a successful write it pushes a one-line
 * summary back into the model's context.
 *
 * Deliberately dependency-light: no framework, plain DOM. esbuild bundles this
 * (with the App bridge) into a single self-contained HTML file at build time —
 * see scripts/compile-ui.ts. Nothing here fetches over the network, so it stays
 * CSP-friendly for the sandbox.
 */
import { App } from "@modelcontextprotocol/ext-apps";

type RosterPerson = { name?: string };
type RosterAttendee = {
  registration_id: number;
  display_name: string;
  status: string;
  is_trial?: boolean;
  allowed_statuses: string[];
  attendee?: RosterPerson;
  client?: RosterPerson;
};
type RosterResult = {
  event_id: number;
  totals?: { enrolled?: number; marked?: number; trial?: number };
  attendees?: RosterAttendee[];
};

const STATUS_LABELS: Record<string, string> = {
  attended: "Present",
  noshow: "No-show",
  canceled: "Cancelled",
  going: "Going",
  ignore: "Ignore",
};

const app = new App();
const root = document.getElementById("root")!;

function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids) el.append(kid);
  return el;
}

function render(roster: RosterResult): void {
  root.replaceChildren();
  const t = roster.totals ?? {};
  root.append(
    h(
      "div",
      { class: "summary" },
      `${t.enrolled ?? roster.attendees?.length ?? 0} enrolled · ${t.marked ?? 0} marked` +
        (t.trial ? ` · ${t.trial} trial` : ""),
    ),
  );

  for (const a of roster.attendees ?? []) {
    const row = h("div", { class: "row" });
    const label = h("div", { class: "name" }, a.display_name || a.attendee?.name || `#${a.registration_id}`);
    if (a.is_trial) label.append(h("span", { class: "badge" }, "trial"));
    row.append(label);

    const actions = h("div", { class: "actions" });
    for (const status of a.allowed_statuses ?? []) {
      const btn = h("button", {
        class: "btn" + (a.status === status ? " active" : ""),
        "data-reg": String(a.registration_id),
        "data-status": status,
      }, STATUS_LABELS[status] ?? status) as HTMLButtonElement;
      btn.onclick = () => void mark(roster.event_id, a, status, btn);
      actions.append(btn);
    }
    row.append(actions);
    root.append(row);
  }
}

async function mark(
  eventId: number,
  attendee: RosterAttendee,
  status: string,
  btn: HTMLButtonElement,
): Promise<void> {
  const siblings = btn.parentElement?.querySelectorAll("button") ?? [];
  siblings.forEach((b) => ((b as HTMLButtonElement).disabled = true));
  try {
    const result = await app.callServerTool({
      name: "mark_attendance",
      arguments: {
        event_id: eventId,
        attendees: [{ registration_id: attendee.registration_id, attendance: status }],
      },
    });
    if (result.isError) throw new Error("mark_attendance returned an error");

    // Confirmed-on-success: only flip the row once the server accepted the write.
    attendee.status = status;
    btn.parentElement?.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `Marked ${attendee.display_name} as ${STATUS_LABELS[status] ?? status} on event ${eventId}.`,
        },
      ],
    });
  } catch (err) {
    root.prepend(
      h("div", { class: "error" }, `Could not mark ${attendee.display_name}: ${String(err)}`),
    );
  } finally {
    siblings.forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}

app.ontoolresult = (params) => {
  const sc = params.structuredContent as RosterResult | undefined;
  if (sc?.attendees) render(sc);
};

void app.connect().then(() => {
  root.append(h("div", { class: "summary" }, "Waiting for roster…"));
});
