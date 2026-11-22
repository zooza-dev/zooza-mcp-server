import { z } from "zod";

import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import {
  getBookingCopyPlan,
  markBookingCopyPlanUsed,
  saveBookingCopyPlan,
  type BookingCopyPlan,
} from "./booking-copy-plan-store.js";
import { companyIdSchema, pickStr } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";

/**
 * bookings_copy_booking — spec ZMCP-20260901-001.
 *
 * Copies or moves an existing booking into a different class. Both actions are one
 * api-v1 endpoint (`POST /v1/registrations`, dispatching on a body field), backed by
 * the same `preflight_check` action the admin app's wizard uses.
 *
 * ── The design constraint that shapes this file ──────────────────────────────
 * api-v1's copy/move accepts eleven optional fields, several of which silently
 * change money. This tool sends a handful and refuses the rest, because a field the
 * LLM can set is a field the LLM can set wrong. `price_resolution` and
 * `payment_schedule` are NEVER sent; `debt` + `registration_fee` are sent only for
 * `payments: free | custom_amount` (spec ZMCP-20261121-002), and `segments` only with
 * `blocks`, as ids the tool resolved from names itself — asserted by a test, not left to convention. Anything needing more is a wizard job
 * and the tool says so.
 *
 * ── Why we do not fetch class or client names for the preview ────────────────
 * To call this tool at all, the model had to resolve `target_schedule_id` through
 * `classes_find_classes` and `registration_id` through `bookings_find` — both of
 * which return names. Re-fetching them here would spend tokens re-teaching the model
 * something already in its context. The preview echoes the ids so the model can bind
 * them to the names it already holds.
 */

// ─── api-v1 preflight response ────────────────────────────────────────────────
// class/Preflight.php:130 — { checks: {name: {name,result,severity}},
//                             properties: {name: {name,value}} }

interface PreflightCheck {
  name?: string;
  result?: string;
  severity?: string;
}

interface PreflightProperty {
  name?: string;
  value?: unknown;
}

interface PreflightResponse {
  checks?: Record<string, PreflightCheck>;
  properties?: Record<string, PreflightProperty>;
}

/** Registration statuses api-v1 accepts on copy/move (registrations.php:4912). */
const VALID_STATUSES = [
  "registered",
  "waitlist",
  "late",
  "trial_started",
  "trial_not_started",
] as const;

const PAYMENT_MODES = ["from_target_class", "do_not_change", "free", "custom_amount"] as const;
type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * Blocker text per ERROR check. These are the teaching messages from the spec's
 * error catalog: each says what is wrong AND what to do about it, because the model
 * reading them has no other channel to learn the domain rule.
 *
 * `{...}` placeholders are filled from preflight properties where available; a
 * missing property degrades to the plain sentence rather than printing "undefined".
 */
function blockerMessage(check: string, props: Map<string, unknown>): string {
  const num = (k: string): string => {
    const v = props.get(k);
    return v === undefined || v === null ? "?" : String(v);
  };

  switch (check) {
    case "registration_type_mismatch":
      return (
        "Cannot copy or move a booking between a recurring-course class and a one-off-session class — " +
        `Zooza tracks attendance differently for each (booking is '${num("current_registration_type")}', ` +
        `target class is '${num("target_registration_type")}'). Pick a target class of the same kind, ` +
        "or tell the operator this move is not possible."
      );
    case "schedule_full":
      return (
        `The target class is full (${num("target_registered")}/${num("target_capacity")} places taken). ` +
        "Zooza refuses copy and move into a full class. Find a class with free places, or ask the " +
        "operator to raise the capacity in the Zooza app first."
      );
    case "target_schedule_exists":
      return (
        "No such target class in this company. Re-resolve the class with classes_find_classes and use " +
        "the schedule_id it returns — do not guess an id."
      );
    case "registration_exists":
      return (
        "No such booking in this company. Re-resolve it with bookings_find and use the registration_id " +
        "it returns."
      );
    case "target_event_exists":
      return (
        "The target class is a one-off-session programme, and the session you picked does not exist. " +
        "List its sessions with sessions_find_events and pass a valid target_event_id."
      );
    case "user_exists":
      return (
        "The client account behind this booking could not be loaded. This is a data problem in Zooza — " +
        "report it to the operator rather than retrying."
      );
    case "target_course_exists":
    case "current_course_exists":
    case "current_schedule_exists":
      return (
        `Zooza could not load the programme or class behind this booking (${check}). The booking may be ` +
        "orphaned. Report it to the operator rather than retrying."
      );
    default:
      return `Zooza blocked this with '${check}'. Nothing has been changed.`;
  }
}

/** Warning text per non-ERROR check that did not pass. */
function warningMessage(check: string, props: Map<string, unknown>, action: "copy" | "move"): string | null {
  const str = (k: string): string => {
    const v = props.get(k);
    return v === undefined || v === null || v === "" ? "?" : String(v);
  };

  switch (check) {
    case "already_registered":
      return action === "copy"
        ? "This client ALREADY has an active booking in the target class. Copying creates a second, " +
            "duplicate booking — which also happens if the target class is the one they are already in. " +
            "Confirm with the operator that they really want a duplicate."
        : "Either this client already has another active booking in the target class, OR the target is " +
            "the class this booking is already in — in that second case Zooza will refuse the move when " +
            "applying (already_registered). Confirm the target class with the operator before applying.";
    case "events_over_capacity":
      return (
        "Some remaining sessions in the target class are already over capacity — the client will be " +
        "enrolled anyway, but those sessions are oversubscribed."
      );
    case "price_mismatch":
      return (
        `The two classes are priced differently: ${str("current_price")} now vs ${str("target_price")} ` +
        "in the target class. Read the `money` block below to the operator before applying."
      );
    case "billing_period_mismatch":
      return (
        `Different billing period: '${str("current_billing_period_name")}' → ` +
        `'${str("target_billing_period_name")}'.`
      );
    case "requested_segments_exists":
      return "Zooza rejected one or more blocks for the target class.";
    default:
      return null;
  }
}

// ─── input schema ─────────────────────────────────────────────────────────────

export const copyBookingInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  registration_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required on the FIRST call. The existing booking. Resolve with bookings_find."),
  target_schedule_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Required on the FIRST call. The class it goes into. Resolve with classes_find_classes.",
    ),
  action: z
    .enum(["copy", "move"])
    .optional()
    .describe("Required on the FIRST call. See the tool description for which to pick."),
  payments: z
    .enum(PAYMENT_MODES)
    .optional()
    .describe(
      "Required on the FIRST call — NO default, ask the operator. from_target_class = price it by the " +
        "target class. do_not_change = copy: no payments on the new booking; move: existing payments " +
        "untouched (safest). free = the booking costs nothing: no class price, no registration fee. " +
        "custom_amount = the amount and fee the operator gives, e.g. agreed with the parent. Only for a " +
        "booking that ends up enrolled (registered); any other status uses the computed price. Ask for " +
        "both numbers.",
    ),
  custom_balance: z
    .number()
    .nonnegative()
    .optional()
    .describe("custom_amount only, then required. Class price part, >= 0."),
  custom_registration_fee: z
    .number()
    .nonnegative()
    .optional()
    .describe("custom_amount only, then required. Fee, >= 0; 0 = no fee."),
  status: z
    .enum(VALID_STATUSES)
    .optional()
    .describe("Omit to use the status Zooza computes (usual)."),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD")
    .optional()
    .describe("Enrolment start, YYYY-MM-DD. Default today. Affects price and session count."),
  target_event_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("One-off programmes only. Resolve with sessions_find_events."),
  blocks: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Only when the operator names blocks ('Mondays only'). Names from the target class. The preview " +
        "lists the available ones if a name does not match.",
    ),
  send_confirmation: z
    .boolean()
    .optional()
    .describe("Default false. true emails the client — confirm intent with the operator first."),
};

const previewInput = z.object(copyBookingInputSchema);

export const copyBookingTitle = "Copy or move a booking to another class (preview, then apply)";

export const copyBookingDescription =
  "Copy or move a client's existing booking into a different class. COPY creates a second booking and " +
  "leaves the original in place — use it when the client is continuing into a new term or adding a class " +
  "alongside their current one. MOVE relocates the booking itself, carrying its payment history and debt, " +
  "and the client is no longer in the old class — use it when they are switching.\n\n" +
  "TWO CALLS. First WITHOUT `token`: returns both class prices, what the client currently owes, free places " +
  "in the target class, and any blockers, plus a single-use token. Show that to the operator — especially " +
  "the `money` line — and get explicit approval. Then call again with `token` + `confirmed: true` to apply; " +
  "send nothing else, the plan is frozen.\n\n" +
  "`payments` has no default on purpose: pricing the booking from the target class is what operators most " +
  "often get wrong, so ask rather than assume.\n\n" +
  "MONEY FIGURES ARE TOTALS. Every amount in the `money` block is for the WHOLE booking, never per session " +
  "— Zooza's per-session figure is `target_unit_price_per_session`, shown separately, and quoting it as the " +
  "price is how a booking ends up quoted ~20x too cheap. Read `target_will_owe_total` to the operator: it is " +
  "the class price PLUS the target class's registration fee, which Zooza charges on top of it.\n\n" +
  "ANOTHER PROGRAMME IS ALLOWED. The target class may belong to a different programme than the booking " +
  "(e.g. a free trial moving into a paid course). The preview then carries a `different_programme` warning: " +
  "the booking is priced by the TARGET programme, no instalment plan is applied (payments_add_plan " +
  "afterwards), and the old programme's booking-form answers are carried over — the target programme's own " +
  "required questions are NOT asked.\n\n" +
  "FREE, AGREED AMOUNT, SOME BLOCKS. `payments: \"free\"` when the client pays nothing for it (\"she " +
  "doesn't pay\"). `payments: \"custom_amount\"` with BOTH `custom_balance` and `custom_registration_fee` " +
  "when the operator gives the numbers (\"we agreed 200 plus the 20 fee\") — ask for both, 0 is allowed; " +
  "only for a booking that ends up enrolled (registered). `blocks` when the operator names blocks of the " +
  "target class (\"Mondays only\"); the preview prices only those blocks and lists the available names if " +
  "one does not match. Omit `blocks` and Zooza matches blocks by name.\n\n" +
  "SIMPLE CASE ONLY beyond that. This tool cannot set up a new instalment plan in the same call (copy, " +
  "then payments_add_plan), do a trial conversion (enrol a trial as converted, or book a trial session), " +
  "or write a custom confirmation email. If the operator needs one of those, do not improvise with other " +
  "tools — tell them to use the Copy/Transfer wizard in the Zooza admin app (open the booking, then " +
  "Transfer or Copy booking).";

// ─── preview phase ────────────────────────────────────────────────────────────

async function runPreview(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = previewInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  const missing: string[] = [];
  if (input.registration_id === undefined) missing.push("registration_id");
  if (input.target_schedule_id === undefined) missing.push("target_schedule_id");
  if (input.action === undefined) missing.push("action");
  if (input.payments === undefined) missing.push("payments");
  if (missing.length > 0) {
    return errorResult(
      `${missing.map((m) => `\`${m}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} required on the ` +
        "preview call. `action` is copy or move; `payments` is from_target_class, do_not_change, free or " +
        "custom_amount — ask the operator rather than picking one for them.",
    );
  }

  // custom_amount's two numbers travel together, and only with custom_amount — both
  // required so a fee of 0 is said out loud rather than defaulted.
  const isCustom = input.payments === "custom_amount";
  const hasBalance = input.custom_balance !== undefined;
  const hasFee = input.custom_registration_fee !== undefined;
  if (isCustom && (!hasBalance || !hasFee)) {
    return errorResult(
      "custom_amount needs custom_balance and custom_registration_fee. Ask the operator for both (0 is allowed).",
    );
  }
  if (!isCustom && (hasBalance || hasFee)) {
    return errorResult(
      "custom_balance / custom_registration_fee only apply with payments: custom_amount.",
    );
  }

  if (input.blocks !== undefined && input.target_event_id !== undefined) {
    return errorResult(
      "blocks applies to classes sold in blocks; target_event_id is for one-off sessions. Send one or the other.",
    );
  }

  const registration_id = input.registration_id!;
  const target_schedule_id = input.target_schedule_id!;
  const action = input.action!;
  const payments = input.payments!;
  const callAuth = withCompany(auth, input.company_id!);

  // Step 1 — preflight. Read-only; returns the same checks the admin wizard renders.
  const runPreflight = (segments?: number[]) =>
    zoozaFetch<PreflightResponse>(
      "/registrations",
      {
        method: "POST",
        body: {
          action: "preflight_check",
          preflight_type: action,
          preflight_properties: {
            current_registration_id: registration_id,
            target_schedule_id,
            ...(input.start !== undefined ? { start: input.start } : {}),
            ...(input.target_event_id !== undefined ? { target_event_id: input.target_event_id } : {}),
            ...(segments !== undefined ? { segments } : {}),
          },
        },
      },
      callAuth,
    );
  let preflight: PreflightResponse;
  try {
    preflight = await runPreflight();
  } catch (error) {
    return zoozaError(error, "Could not check whether this copy/move is possible");
  }

  // Step 2 — classify. When a target class, programme, booking or current class/
  // programme cannot be loaded, api-v1 does a bare `return;` rather than returning
  // the preflight (registrations.php:3893, :3906, :3919, :3937, :3949) — the body
  // carries NO checks, so the failed *_exists check itself never reaches us. Treat
  // a check-less response as "not found" instead of letting it fall through to the
  // missing-status path, which would invite the model to retry with a guessed status.
  let parsedPreflight = readPreflight(preflight);
  if (!parsedPreflight) return notLoadedError(action);

  // Step 2b — blocks (spec ZMCP-20261121-002). The first preflight lists the target's
  // blocks still running from `start` (registrations.php:4747-4765); names resolve to
  // segment ids HERE, so the model never sees an id. A second preflight with those ids
  // then prices only those blocks (Registration_Copy::price_mismatch gets them,
  // registrations.php:4849) and counts only their sessions (:4807-4819), and its
  // `valid_segments` is what gets committed — the same thing the admin wizard submits.
  let chosenBlocks: SegmentRow[] | null = null;
  let segmentIds: number[] | null = null;
  if (input.blocks !== undefined) {
    const resolved = resolveBlocks(input.blocks, parsedPreflight.props);
    if (!resolved.ok) return errorResult(resolved.message);
    chosenBlocks = resolved.blocks;

    try {
      preflight = await runPreflight(chosenBlocks.map((b) => b.id));
    } catch (error) {
      return zoozaError(error, "Could not check the chosen blocks");
    }
    parsedPreflight = readPreflight(preflight);
    if (!parsedPreflight) return notLoadedError(action);

    const requested = parsedPreflight.checks.requested_segments_exists;
    const valid = segmentIdsOf(parsedPreflight.props.get("valid_segments"));
    if (
      requested?.result === "not_passed" ||
      chosenBlocks.some((b) => !valid.includes(b.id))
    ) {
      return errorResult(
        "Zooza rejected the chosen blocks for the target class. Nothing has been changed. Available: " +
          `${listBlocks(resolved.available)}. Ask the operator which block, using these names.`,
      );
    }
    // Commit what preflight vouched for, as the wizard does (handoff app-to-zooza-mcp, step 4).
    segmentIds = [...new Set(valid)];
  }

  const { checks, props } = parsedPreflight;

  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const c of Object.values(checks)) {
    if (!c || typeof c.name !== "string" || c.result !== "not_passed") continue;
    if (c.severity === "error") {
      blockers.push(blockerMessage(c.name, props));
    } else {
      const w = warningMessage(c.name, props, action);
      if (w) warnings.push(w);
    }
  }

  // Payment plans — the two flags the admin wizard branches on (handoff
  // app-to-api-v1-20260909-001). Absent on an api-v1 without that handoff, in which
  // case neither rule fires. Both only matter when the tool is about to price the
  // booking; `do_not_change` leaves plans alone by definition. `free` and
  // `custom_amount` reprice too, so a move off a plan is blocked for them as well; a
  // free copy owes nothing, so plan advice is moot there.
  if (payments !== "do_not_change") {
    if (props.get("current_has_payment_schedule") === true) {
      if (action === "move") {
        blockers.push(
          "This booking is on a payment plan (instalments). Repricing it " +
            (payments === "from_target_class" ? "from the target class" : `with payments: ${payments}`) +
            " means " +
            "rebuilding that plan, which this tool cannot do. Either preview again with payments: " +
            "\"do_not_change\" to move it and keep the plan exactly as it is, or send the operator to the " +
            "Copy/Transfer wizard in the Zooza admin app (open the booking, then Transfer).",
        );
      } else if (payments !== "free") {
        warnings.push(
          "The original booking is on a payment plan, but the COPY will NOT get one — it will owe the " +
            `full ${payments === "custom_amount" ? "amount set here" : "target price"} at once. To split it, ` +
            "apply a plan afterwards with payments_add_plan, or use the Copy/Transfer wizard in the Zooza " +
            "admin app.",
        );
      }
    }
    if (
      payments !== "free" &&
      props.get("payment_schedules_available") === true &&
      blockers.length === 0
    ) {
      warnings.push(
        "The target class offers payment plans, but this tool does not put the booking on one. If the " +
          "operator wants instalments, apply a plan afterwards with payments_add_plan.",
      );
    }
  }

  if (blockers.length > 0) {
    return errorResult(
      `Zooza will not ${action} this booking. Nothing has been changed.\n- ${blockers.join("\n- ")}`,
    );
  }

  // Step 3 — build the frozen request body. Everything this tool refuses to send is
  // absent by construction, not by filtering: price_resolution and payment_schedule
  // never appear here, debt/registration_fee only for free/custom_amount, and
  // segments only with `blocks`.
  const status = input.status ?? stripPrePrefix(props.get("target_status"));
  if (status === undefined) {
    return errorResult(
      "Zooza did not return a status for the target class, so the tool cannot pick one safely. Pass " +
        `\`status\` explicitly (one of: ${VALID_STATUSES.join(", ")}).`,
    );
  }

  // api-v1 honours an admin-set price only when the booking ends up (pre_)registered;
  // for late, waitlist or trial it computes the price itself and silently ignores the
  // posted debt/registration_fee (audited `registration_admin_price_ignored`, agreed in
  // handoff zooza-mcp-to-api-v1-20261121-002). Refuse rather than preview a price that
  // will not be applied.
  if ((payments === "free" || payments === "custom_amount") && status !== "registered") {
    return errorResult(
      "Zooza applies a set price only to an enrolled booking. This one would become " +
        `'${status}', so Zooza will compute the price itself. Use from_target_class, or book it as registered.`,
    );
  }

  const body: Record<string, unknown> = {
    action,
    registration_id,
    schedule_id: target_schedule_id,
    status,
  };
  if (input.start !== undefined) body.start = input.start;
  if (input.target_event_id !== undefined) body.event_id = input.target_event_id;
  if (input.send_confirmation === true) body.send_confirmation = true;
  // Only with `blocks`: the ids preflight confirmed as valid (Registration_Copy.php:400
  // takes ids). Without it api-v1 auto-matches blocks by name (:377-388), as before.
  if (segmentIds !== null) body.segments = segmentIds;
  // Only ever sent as `false`. Omitting it lets api-v1's own `true` default stand,
  // which is what `from_target_class` means (class/Registration.php:2781).
  if (payments === "do_not_change") body.setup_payments = false;
  // An explicit debt makes api-v1 take the price as given: `isset($debt)` honours 0
  // (registrations.php:5168-5177), and with the agreed fix the fee is exactly what was
  // sent — the target's own fee is never added (zooza-mcp-to-api-v1-20261121-002).
  if (payments === "free") {
    body.debt = 0;
    body.registration_fee = 0;
  } else if (payments === "custom_amount") {
    body.debt = input.custom_balance!;
    body.registration_fee = input.custom_registration_fee!;
  }

  if (input.send_confirmation === true) {
    warnings.push("send_confirmation: true — applying will email the client a booking confirmation.");
  }

  // A target class with nothing left to attend still charges its registration fee, so
  // the client can end up paying for zero sessions. api-v1 permits it (the class is
  // active, it is simply over), and the operator may genuinely be booking into next
  // term — but they should see it before approving, not after.
  const remaining = numOrNull(props.get("remaining_events_count"));
  if (remaining === 0 && input.target_event_id === undefined) {
    warnings.push(
      "The target class has NO sessions left from this start date — the client would be enrolled in a " +
        "class that is already over. Check the start date, or pick a class that still has sessions.",
    );
  }

  // The `payments` choice is the one decision the operator must make themselves, and
  // nothing stops a model from picking one silently — so the preview states which was
  // picked, in the text the operator actually reads.
  warnings.push(paymentsChoiceWarning(payments, action));

  // The registration fee is REAL money api-v1 charges on top of the class price for
  // both copy and move (registrations.php:4480, :4979 → __resolve_registration_fee),
  // and the preflight does not expose it — `target_registration_fee` lives only inside
  // the internal price array (registrations.php:4271). Fetch it so the operator
  // approves the amount that will actually land on the booking. Only needed when this
  // tool is about to price anything; `do_not_change` charges nothing. The same schedule
  // GET yields the target `course_id` for the cross-programme check below, so it is
  // made in both cases (one call, never two).
  // `free` and `custom_amount` carry their own fee, so only from_target_class reads it.
  const fee = await fetchTargetFee(target_schedule_id, callAuth, payments === "from_target_class");

  // A past `start` into a class that has already started: the preflight prices from
  // that start (class/Registration_Copy.php:107), but the create prices from NOW once
  // the class has started (class/Registration.php:1990-1996). Live on local, 174405:
  // preview 69, booked debt 50. Decided 2026-11-21: refuse rather than show a figure
  // that will not land. The admin app never hits this, because it always posts an explicit debt
  // taken from the preflight's target_price. free/custom_amount post an explicit debt and
  // do_not_change prices nothing, so only from_target_class is affected. Fails closed
  // when the class start cannot be read.
  if (
    payments === "from_target_class" &&
    input.start !== undefined &&
    input.start < todayDate() &&
    fee.started !== false
  ) {
    return errorResult(
      `start ${input.start} is in the past and the target class has already started. Zooza would price ` +
        "this booking from today, not from that date, so the preview cannot show the amount that will " +
        "land. Use a start of today or later, or payments: custom_amount with the amount the operator " +
        "gives (or free).",
    );
  }

  // Cross-programme copy/move (#28). api-v1's preflight never compares courses
  // (registrations.php:4327-4369), so the MCP does: the target course comes from the
  // schedule GET above, the source course from the booking. If either cannot be read
  // the check stays silent rather than guessing.
  const currentCourseId = await fetchBookingCourseId(registration_id, callAuth);
  if (currentCourseId !== null && fee.course_id !== null && currentCourseId !== fee.course_id) {
    warnings.push(...differentProgrammeWarnings(props, action, payments, fee));
  }

  const money = buildMoney(props, action, payments, fee, {
    balance: typeof body.debt === "number" ? body.debt : null,
    registration_fee: typeof body.registration_fee === "number" ? body.registration_fee : null,
  });
  if (chosenBlocks !== null) {
    // Names and dates only — the segment ids stay in the frozen body.
    money.blocks = chosenBlocks.map((b) => ({ name: b.name, start: b.start, end: b.end }));
    money.sessions_remaining = numOrNull(props.get("remaining_events_count"));
    money.result =
      `${String(money.result)} Booked into these blocks only: ${chosenBlocks.map((b) => b.name).join(", ")}; ` +
      (payments === "from_target_class"
        ? "the target price and session count are for those blocks."
        : "the session count is for those blocks.");
  }
  const summary = {
    action,
    registration_id,
    target_schedule_id,
    status,
    start: pickStr(props.get("start")) ?? input.start ?? "today",
    money,
    target: {
      free_places: freePlaces(props),
      sessions_remaining: numOrNull(props.get("remaining_events_count")),
      billing_period: pickStr(props.get("target_billing_period_name")) ?? null,
    },
    warnings,
  };

  const plan: BookingCopyPlan = {
    company_id: input.company_id!,
    action,
    body,
    registration_id,
    summary,
  };
  const { token, expires_in_seconds } = saveBookingCopyPlan(plan);

  return {
    content: [{ type: "text", text: JSON.stringify({ token, expires_in_seconds, ...summary }) }],
  };
}

/** The `payments` choice is the one decision the operator must make themselves, and
 *  nothing stops a model from picking one silently — so the preview states which was
 *  picked, in the text the operator actually reads. */
function paymentsChoiceWarning(payments: PaymentMode, action: "copy" | "move"): string {
  switch (payments) {
    case "do_not_change":
      return action === "copy"
        ? "You chose payments: do_not_change — the new booking will carry NO payments at all. Say this to " +
            "the operator and let them confirm it, rather than deciding for them."
        : "You chose payments: do_not_change — the booking keeps its current price and payment schedule " +
            "even though the target class may cost something different. Say this to the operator and let " +
            "them confirm it, rather than deciding for them.";
    case "free":
      return (
        "You chose payments: free — the booking will cost nothing (no class price, no registration fee), " +
        "whatever the target class normally costs. Say this to the operator and let them confirm it."
      );
    case "custom_amount":
      return (
        "You chose payments: custom_amount — the booking is priced at the amount and fee given in this " +
        "call, not by the target class. Read the `money` block to the operator and let them confirm it."
      );
    default:
      return (
        "You chose payments: from_target_class — this re-prices the booking and can create real debt on " +
        "the client's account. Read the `money` block to the operator and let them confirm it."
      );
  }
}

/**
 * The one field the operator must actually read. Rendered as a sentence rather than
 * left as numbers, because the decision ("this creates a 240 EUR debt") is what needs
 * approving — not the arithmetic behind it.
 */
function buildMoney(
  props: Map<string, unknown>,
  action: "copy" | "move",
  payments: PaymentMode,
  fee: { fee: number | null; unit_price: number | null },
  set: { balance: number | null; registration_fee: number | null },
): Record<string, unknown> {
  // NOT `current_debt`: api-v1 fills that property from `$debt['debt']`
  // (registrations.php:3925), a key `Registration::get_debt( true )` never returns —
  // its array has order/paid/balance/total (class/Registration.php:5364-5375). So
  // `current_debt` is floatval(null) = 0 on EVERY preflight, and reporting it would
  // tell the operator the client owes nothing no matter what they owe.
  // `current_balance` is real: paid + order debt, on the append-only ledger's
  // convention where debt rows are negative — so a negative balance is money still owed.
  const balance = numOrNull(props.get("current_balance"));
  const owed = balance === null ? null : balance < 0 ? -balance : 0;
  const credit = balance === null ? null : balance > 0 ? balance : 0;
  const paid = numOrNull(props.get("current_paid"));
  const currentPrice = numOrNull(props.get("current_price"));
  const targetPrice = numOrNull(props.get("target_price"));
  // Both prices come from Schedule::price( false, … ) — `false` meaning WITHOUT the
  // registration fee (registrations.php:4259-4262, class/Schedule.php:274). They are
  // the whole booking's price from `start`, already aliquot-adjusted — NOT per-session.
  // `do_not_change` prices nothing, so every target-side figure stays null. Reporting
  // a "will owe" total there would describe money that this call does not create — the
  // exact confusion the preview exists to prevent.
  // `free` / `custom_amount` price the booking at the numbers frozen into the body:
  // debt B + fee F, which api-v1 books as debt −(B+F), fee −F (spec Notes, live check).
  const priced = payments === "from_target_class";
  const setPrice = payments === "free" || payments === "custom_amount";
  const setBalance = set.balance ?? 0;
  const setFee = set.registration_fee ?? 0;
  const total = setPrice
    ? setBalance + setFee
    : !priced || targetPrice === null
      ? null
      : targetPrice + (fee.fee ?? 0);

  let result: string;
  if (payments === "free") {
    result =
      action === "copy"
        ? "The new booking is FREE: the client will owe 0, registration fee 0. The original booking is unchanged."
        : "The booking becomes FREE: it is repriced to 0, registration fee 0, and its existing debt reconciled against it.";
  } else if (payments === "custom_amount") {
    const parts = `${setBalance} for the classes plus a ${setFee} registration fee, as set by the operator`;
    result =
      action === "copy"
        ? `The new booking will owe ${total} in total: ${parts}. The original booking is unchanged.`
        : `The booking is repriced to ${total} in total: ${parts}. Its existing debt is reconciled against it.`;
  } else if (payments === "do_not_change") {
    result =
      action === "copy"
        ? "The new booking will have NO payments — the operator adds them afterwards."
        : "Existing payments and payment schedule stay exactly as they are.";
  } else if (targetPrice === null) {
    result =
      "Priced by the target class. Zooza did not return the target price — check it in the app before applying.";
  } else {
    const feePart =
      fee.fee === null
        ? " Zooza's registration fee for this class could not be read — check it in the app, it is charged ON TOP of this price."
        : fee.fee > 0
          ? ` That is ${targetPrice} for the classes plus a ${fee.fee} registration fee.`
          : "";
    result =
      action === "copy"
        ? `The new booking will owe ${total} in total.${feePart} The original booking is unchanged.`
        : `The booking is repriced to ${total} in total${feePart ? "." + feePart : ""} and its existing debt reconciled against it.`;
  }

  return {
    // Every figure below is a TOTAL for the whole booking in the company's currency —
    // never a per-session unit price. Zooza stores per-session `unit_price` on the
    // class and multiplies it by the billable sessions; mixing the two up is the
    // classic way to be off by a factor of ~20.
    amounts_are: "totals for the whole booking, not per-session unit prices",
    payments_mode: payments,
    currently_owed: owed,
    credit_on_account: credit,
    already_paid: paid,
    current_class_price_total: currentPrice,
    target_class_price_total: targetPrice,
    target_registration_fee: setPrice ? setFee : priced ? fee.fee : null,
    // Only for free/custom_amount: the class-price part the operator set (the `debt` sent).
    ...(setPrice ? { set_balance: setBalance } : {}),
    target_will_owe_total: total,
    target_unit_price_per_session: priced ? fee.unit_price : null,
    result,
  };
}

/**
 * Read the target class's registration fee, mirroring `Schedule::registration_fee()`
 * (class/Schedule.php:839-851): the schedule's own fee, falling back to the course's
 * when the schedule's is 0. Returns nulls rather than throwing — a preview that cannot
 * read the fee says so in `money.result` instead of quietly implying there is none.
 * Also returns the schedule's `course_id` (for the cross-programme check); the fee
 * lookup is skipped when `needFee` is false.
 */
async function fetchTargetFee(
  scheduleId: number,
  auth: ZoozaAuth,
  needFee: boolean,
): Promise<TargetInfo> {
  interface ScheduleRow {
    course_id?: unknown;
    registration_fee?: unknown;
    unit_price?: unknown;
    start?: unknown;
    total_events?: unknown;
  }
  let schedule: ScheduleRow;
  try {
    schedule = await zoozaFetch<ScheduleRow>(`/schedules/${scheduleId}`, {}, auth);
  } catch {
    return { fee: null, unit_price: null, course_id: null, started: null };
  }
  const course_id = numOrNull(schedule?.course_id);
  const started = scheduleStarted(schedule?.start, schedule?.total_events);
  if (!needFee) return { fee: null, unit_price: null, course_id, started };
  const unit_price = numOrNull(schedule?.unit_price);
  const own = numOrNull(schedule?.registration_fee);
  if (own !== null && own !== 0) return { fee: own, unit_price, course_id, started };

  if (course_id === null) return { fee: own, unit_price, course_id, started };
  try {
    const course = await zoozaFetch<{ registration_fee?: unknown }>(`/courses/${course_id}`, {}, auth);
    return { fee: numOrNull(course?.registration_fee) ?? own, unit_price, course_id, started };
  } catch {
    return { fee: own, unit_price, course_id, started };
  }
}

interface TargetInfo {
  fee: number | null;
  unit_price: number | null;
  course_id: number | null;
  /** Mirrors `Schedule::started()` (class/Schedule.php:1061-1082) at day precision:
   *  false with no sessions, else first-session date <= today. Null = unreadable. */
  started: boolean | null;
}

function scheduleStarted(start: unknown, totalEvents: unknown): boolean | null {
  if (numOrNull(totalEvents) === 0) return false;
  const day = typeof start === "string" ? start.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day <= todayDate();
}

/** Local-date YYYY-MM-DD, as find-events' todayDate (no per-company tz handling yet). */
function todayDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The booking's programme. Null when the booking cannot be read — the cross-programme
 *  check then stays silent (the preflight already vouched the booking exists). */
async function fetchBookingCourseId(registrationId: number, auth: ZoozaAuth): Promise<number | null> {
  try {
    const raw = await zoozaFetch<{ data?: unknown } | unknown>(`/registrations/${registrationId}`, {}, auth);
    const row = (raw as { data?: unknown })?.data ?? raw;
    const first = Array.isArray(row) ? row[0] : row;
    return numOrNull((first as { course_id?: unknown } | undefined)?.course_id);
  } catch {
    return null;
  }
}

/**
 * Warnings for a target class in a DIFFERENT programme than the booking (#28).
 * Facts (api-v1/registrations.php): price comes from the target programme
 * (`price_resolution` default `target`, :5350); no payment plan is applied unless
 * `payment_schedule` is in the POST body (:5602-5658), which this tool never sends;
 * booking-form answers are copied as-is (:5594), so the target programme's required
 * questions are not asked.
 */
function differentProgrammeWarnings(
  props: Map<string, unknown>,
  action: "copy" | "move",
  payments: PaymentMode,
  target: TargetInfo,
): string[] {
  const out: string[] = [];
  const targetPrice = numOrNull(props.get("target_price"));
  const priceText =
    targetPrice === null
      ? "target price not returned by Zooza"
      : `target class price ${targetPrice}` +
        (payments === "from_target_class" && target.fee ? ` plus a ${target.fee} registration fee` : "");
  out.push(
    "different_programme: the target class belongs to a DIFFERENT programme than this booking " +
      `(e.g. trial to paid course). ${
        payments === "from_target_class"
          ? `It is priced by the target programme (${priceText}).`
          : payments === "do_not_change"
            ? `Pricing would come from the target programme (${priceText}), but payments: do_not_change leaves it unpriced.`
            : `The target programme's pricing (${priceText}) is replaced by the amount set with payments: ${payments}.`
      }${
        action === "move" && payments === "do_not_change"
          ? ""
          : " No instalment plan is applied — if the target programme bills in instalments, add one afterwards " +
            "with payments_add_plan."
      } The old programme's booking-form answers are carried over as they are; the ` +
      "target programme's own required questions are NOT asked, so check them in the Zooza app. This does " +
      "not mark a trial as converted.",
  );
  if (action === "move" && payments === "do_not_change") {
    out.push(
      "different_programme: this is a MOVE across programmes with payments: do_not_change — the old " +
        "programme's payments and payment schedule stay on the booking unchanged, now attached to the " +
        "target programme's class. Confirm with the operator that this is intended.",
    );
  }
  return out;
}

/** A preflight's checks + flattened properties, or null when it carries no checks
 *  (api-v1's bare `return;` on a not-found entity — see Step 2). Properties may
 *  still be partial, so callers must not assume a key is present. */
function readPreflight(
  preflight: PreflightResponse,
): { checks: Record<string, PreflightCheck>; props: Map<string, unknown> } | null {
  const checks = preflight && typeof preflight === "object" && !Array.isArray(preflight)
    ? preflight.checks
    : undefined;
  if (!checks || typeof checks !== "object" || Object.keys(checks).length === 0) return null;
  const props = new Map<string, unknown>();
  for (const p of Object.values(preflight.properties ?? {})) {
    if (p && typeof p.name === "string") props.set(p.name, p.value);
  }
  return { checks, props };
}

function notLoadedError(action: "copy" | "move") {
  return errorResult(
    `Zooza will not ${action} this booking. Nothing has been changed.\n- Zooza could not load the ` +
      "target class, its programme, or the booking in this company (it does not say which). Re-resolve " +
      "the class with classes_find_classes and the booking with bookings_find, and use the ids they " +
      "return — do not guess an id.",
  );
}

/** One block (schedule segment) of the target class. Dates are YYYY-MM-DD. */
interface SegmentRow {
  id: number;
  name: string;
  start: string | null;
  end: string | null;
}

/** Preflight segment rows (`$target_schedule->get_segments()`, columns from
 *  Zooza/Resource/Schedule_Segment.php:37) → id, name and the `__calc__start/end`
 *  dates, trimmed from DATE_FORMAT_FULL to the day. Rows without an id or name are
 *  dropped: a block that cannot be named cannot be picked. */
function segmentRows(v: unknown): SegmentRow[] {
  if (!Array.isArray(v)) return [];
  const day = (x: unknown): string | null => {
    const s = pickStr(x);
    return s ? s.slice(0, 10) : null;
  };
  const out: SegmentRow[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const id = numOrNull(row.id);
    const name = pickStr(row.name)?.trim();
    if (id === null || !name) continue;
    out.push({ id, name, start: day(row.__calc__start), end: day(row.__calc__end) });
  }
  return out;
}

/** `valid_segments` holds serialised Schedule_Segments objects (registrations.php:4791),
 *  whose public `id` is what the admin wizard submits (app registration_change.js:975-995). */
function segmentIdsOf(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => (r && typeof r === "object" ? numOrNull((r as { id?: unknown }).id) : null))
    .filter((id): id is number => id !== null);
}

function listBlocks(rows: SegmentRow[]): string {
  if (rows.length === 0) return "none from this start date";
  return rows.map((b) => `${b.name} (${b.start ?? "?"} – ${b.end ?? "?"})`).join(", ");
}

/** Resolve the operator's block names, case-insensitively, against the first
 *  preflight's `remaining_segments` — the blocks still running from `start`. */
function resolveBlocks(
  names: string[],
  props: Map<string, unknown>,
): { ok: true; blocks: SegmentRow[]; available: SegmentRow[] } | { ok: false; message: string } {
  const available = segmentRows(props.get("remaining_segments"));
  if (available.length === 0 && segmentRows(props.get("all_segments")).length === 0) {
    return { ok: false, message: "The target class is not divided into blocks. Remove blocks." };
  }
  const key = (s: string) => s.trim().toLowerCase();
  const wanted = [...new Map(names.map((n) => [key(n), n.trim()])).entries()];

  const unknown = wanted.filter(([k]) => !available.some((b) => key(b.name) === k)).map(([, n]) => n);
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `The target class has no block named ${unknown.map((n) => `'${n}'`).join(", ")}. ` +
        `Available: ${listBlocks(available)}.`,
    };
  }

  const blocks: SegmentRow[] = [];
  for (const [k, n] of wanted) {
    const matches = available.filter((b) => key(b.name) === k);
    if (matches.length > 1) {
      return {
        ok: false,
        message:
          `The target class has ${matches.length} blocks named '${n}' (${listBlocks(matches)}), so the ` +
          "name does not say which one. Ask the operator to rename them in the Zooza app first.",
      };
    }
    blocks.push(matches[0]);
  }
  return { ok: true, blocks, available };
}

function freePlaces(props: Map<string, unknown>): number | null {
  const capacity = numOrNull(props.get("target_capacity"));
  const registered = numOrNull(props.get("target_registered"));
  if (capacity === null || registered === null) return null;
  return capacity - registered;
}

/** api-v1 returns the computed status pre-prefixed (`pre_registered`); the write
 *  endpoint wants it bare and re-adds the prefix itself (registrations.php:4924). */
function stripPrePrefix(v: unknown): (typeof VALID_STATUSES)[number] | undefined {
  const s = pickStr(v);
  if (!s) return undefined;
  const bare = s.startsWith("pre_") ? s.slice(4) : s;
  return (VALID_STATUSES as readonly string[]).includes(bare)
    ? (bare as (typeof VALID_STATUSES)[number])
    : undefined;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── apply phase ──────────────────────────────────────────────────────────────

async function runApply(
  token: string,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const lookup = getBookingCopyPlan(token);
  if (!lookup.ok) {
    return errorResult(
      "This copy/move plan is no longer valid (tokens are single-use and expire after 15 minutes — this " +
        `one is ${lookup.reason}). Call bookings_copy_booking again without a token and re-confirm with ` +
        "the operator.",
    );
  }
  const plan = lookup.plan;
  // Company comes from the stored plan, never from args — a caller passing
  // company_id alongside a token cannot redirect the write (dual-phase.ts:38-43).
  const callAuth = withCompany(auth, plan.company_id);

  let created: unknown;
  try {
    created = await zoozaFetch<unknown>("/registrations", { method: "POST", body: plan.body }, callAuth);
  } catch (error) {
    // A 4xx is api-v1 refusing the request before writing — nothing changed. The token
    // stays valid, but the plan is frozen, so resending it would only repeat the refusal.
    if (error instanceof ZoozaApiError && error.status >= 400 && error.status < 500) {
      return zoozaError(
        error,
        `Zooza refused to ${plan.action} the booking. Nothing was changed. Explain the reason to the ` +
          "operator; to try different inputs, preview again without a token",
      );
    }
    // A 2xx whose body failed to parse: the write went through.
    if (error instanceof ZoozaApiError && error.status >= 200 && error.status < 300) {
      markBookingCopyPlanUsed(token);
      return applied(plan, null);
    }
    // 5xx, timeout, dropped connection: the write MAY have happened, and `copy` is not
    // idempotent — a blind retry would create a second booking. Burn the token so the
    // only way forward is to check first.
    markBookingCopyPlanUsed(token);
    const verify =
      plan.action === "copy"
        ? `check with bookings_find (schedule_id: ${String(plan.body.schedule_id)}) whether a new booking for this client now exists`
        : `check with bookings_find whether booking ${plan.registration_id} is now in class ${String(plan.body.schedule_id)}`;
    const detail =
      error instanceof ZoozaApiError
        ? `api-v1 ${error.status}: ${error.humanMessage}`
        : error instanceof Error
          ? error.message
          : String(error);
    return errorResult(
      `Zooza did not confirm the ${plan.action} (${detail}). It is UNKNOWN whether it was applied. ` +
        `Do not retry blindly — first ${verify}. This token is now used; if nothing was applied, preview ` +
        "again and re-confirm with the operator.",
    );
  }
  markBookingCopyPlanUsed(token);

  // Step 5 failure mode is `continue`: the write already succeeded, so a response we
  // cannot parse must not be reported as a failure.
  return applied(plan, extractRegistrationId(created));
}

function applied(
  plan: BookingCopyPlan,
  returnedId: number | null,
): { content: Array<{ type: "text"; text: string }> } {
  // On `move` the id is unchanged by definition (class/Registration.php:2815) — say so
  // rather than implying a new booking.
  let registration_id: number | null;
  let note: string;
  if (plan.action === "move") {
    registration_id = plan.registration_id;
    note = "Same booking id — a move relocates the booking rather than creating one.";
  } else {
    registration_id = returnedId;
    note =
      "New booking created; the original is unchanged. Attendance history and make-up credits stay " +
      "with the original booking, and discounts do not carry over.";
    if (returnedId === null) {
      note += " Zooza did not return the new booking id — find it with bookings_find before referring to it.";
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          applied: plan.action,
          registration_id,
          note,
          money: plan.summary.money,
        }),
      },
    ],
  };
}

/** api-v1 returns the written registration as `$response->json( 0 )`
 *  (registrations.php:4700, :5216), and `Collection::json()` with an index returns
 *  that ONE row as a flat object (class/Collection.php:142-147) — not an array or a
 *  `{data:[...]}` envelope. The envelope shapes are still accepted defensively. */
function extractRegistrationId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : [raw];
  const first = rows[0];
  if (!first || typeof first !== "object") return null;
  const r = first as { registration_id?: unknown; id?: unknown };
  return numOrNull(r.registration_id) ?? numOrNull(r.id);
}

// ─── dual-phase entry point ───────────────────────────────────────────────────

export async function runCopyBooking(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") {
    return errorResult(decision.message);
  }
  if (decision.kind === "preview") {
    return runPreview(rawInput, auth);
  }
  return runApply(decision.token, auth);
}

function zoozaError(error: unknown, prefix: string) {
  if (error instanceof ZoozaApiError) {
    return errorResult(`${prefix} (api-v1 ${error.status}: ${error.humanMessage}).`);
  }
  return errorResult(error instanceof Error ? error.message : String(error));
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
