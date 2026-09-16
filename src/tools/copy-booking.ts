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
 * change money. This tool sends five and refuses the rest, because a field the LLM
 * can set is a field the LLM can set wrong. `price_resolution`, `debt`,
 * `payment_schedule` and `segments` are NEVER sent — asserted by a test, not left to
 * convention. Anything needing them is a wizard job and the tool says so.
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
      return "Zooza rejected one or more term blocks for the target class.";
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
    .enum(["from_target_class", "do_not_change"])
    .optional()
    .describe(
      "Required on the FIRST call — NO default, ask the operator. from_target_class = price it by the " +
        "target class. do_not_change = on copy, no payments on the new booking; on move, leave existing " +
        "payments untouched (Zooza's help calls this the safest option).",
    ),
  status: z
    .enum(VALID_STATUSES)
    .optional()
    .describe("Omit to use what Zooza computes for the target class (usual choice)."),
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
    .describe("One-off (single-session) programmes only. Resolve with sessions_find_events."),
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
  "SIMPLE CASE ONLY. This tool cannot set up instalment plans, pick specific term blocks, or set a custom " +
  "amount owed. If the operator needs any of those, do not improvise with other tools — tell them to use " +
  "the Copy/Transfer wizard in the Zooza admin app (open the booking, then Transfer or Copy booking).";

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
        "preview call. `action` is copy or move; `payments` is from_target_class or do_not_change — ask " +
        "the operator rather than picking one for them.",
    );
  }

  const registration_id = input.registration_id!;
  const target_schedule_id = input.target_schedule_id!;
  const action = input.action!;
  const callAuth = withCompany(auth, input.company_id!);

  // Step 1 — preflight. Read-only; returns the same checks the admin wizard renders.
  let preflight: PreflightResponse;
  try {
    preflight = await zoozaFetch<PreflightResponse>(
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
          },
        },
      },
      callAuth,
    );
  } catch (error) {
    return zoozaError(error, "Could not check whether this copy/move is possible");
  }

  // Step 2 — classify. When a target class, programme, booking or current class/
  // programme cannot be loaded, api-v1 does a bare `return;` rather than returning
  // the preflight (registrations.php:3893, :3906, :3919, :3937, :3949) — the body
  // carries NO checks, so the failed *_exists check itself never reaches us. Treat
  // a check-less response as "not found" instead of letting it fall through to the
  // missing-status path, which would invite the model to retry with a guessed status.
  const checks = preflight && typeof preflight === "object" && !Array.isArray(preflight)
    ? preflight.checks
    : undefined;
  if (!checks || typeof checks !== "object" || Object.keys(checks).length === 0) {
    return errorResult(
      `Zooza will not ${action} this booking. Nothing has been changed.\n- Zooza could not load the ` +
        "target class, its programme, or the booking in this company (it does not say which). Re-resolve " +
        "the class with classes_find_classes and the booking with bookings_find, and use the ids they " +
        "return — do not guess an id.",
    );
  }

  // Properties may still be partial, so nothing below may assume a key is present.
  const props = new Map<string, unknown>();
  for (const p of Object.values(preflight.properties ?? {})) {
    if (p && typeof p.name === "string") props.set(p.name, p.value);
  }

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
  // booking; `do_not_change` leaves plans alone by definition.
  if (input.payments === "from_target_class") {
    if (props.get("current_has_payment_schedule") === true) {
      if (action === "move") {
        blockers.push(
          "This booking is on a payment plan (instalments). Repricing it from the target class means " +
            "rebuilding that plan, which this tool cannot do. Either preview again with payments: " +
            "\"do_not_change\" to move it and keep the plan exactly as it is, or send the operator to the " +
            "Copy/Transfer wizard in the Zooza admin app (open the booking, then Transfer).",
        );
      } else {
        warnings.push(
          "The original booking is on a payment plan, but the COPY will NOT get one — it will owe the " +
            "full target price at once. To split it, apply a plan afterwards with payments_add_plan, or use " +
            "the Copy/Transfer wizard in the Zooza admin app.",
        );
      }
    }
    if (props.get("payment_schedules_available") === true && blockers.length === 0) {
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
  // absent by construction, not by filtering: price_resolution, debt,
  // payment_schedule and segments never appear here.
  const status = input.status ?? stripPrePrefix(props.get("target_status"));
  if (status === undefined) {
    return errorResult(
      "Zooza did not return a status for the target class, so the tool cannot pick one safely. Pass " +
        `\`status\` explicitly (one of: ${VALID_STATUSES.join(", ")}).`,
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
  // Only ever sent as `false`. Omitting it lets api-v1's own `true` default stand,
  // which is what `from_target_class` means (class/Registration.php:2781).
  if (input.payments === "do_not_change") body.setup_payments = false;

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
  warnings.push(
    input.payments === "do_not_change"
      ? action === "copy"
        ? "You chose payments: do_not_change — the new booking will carry NO payments at all. Say this to " +
          "the operator and let them confirm it, rather than deciding for them."
        : "You chose payments: do_not_change — the booking keeps its current price and payment schedule " +
          "even though the target class may cost something different. Say this to the operator and let " +
          "them confirm it, rather than deciding for them."
      : "You chose payments: from_target_class — this re-prices the booking and can create real debt on " +
        "the client's account. Read the `money` block to the operator and let them confirm it.",
  );

  // The registration fee is REAL money api-v1 charges on top of the class price for
  // both copy and move (registrations.php:4480, :4979 → __resolve_registration_fee),
  // and the preflight does not expose it — `target_registration_fee` lives only inside
  // the internal price array (registrations.php:4271). Fetch it so the operator
  // approves the amount that will actually land on the booking. Only needed when this
  // tool is about to price anything; `do_not_change` charges nothing.
  const fee =
    input.payments === "from_target_class"
      ? await fetchTargetFee(target_schedule_id, callAuth)
      : { fee: null as number | null, unit_price: null as number | null };

  const money = buildMoney(props, action, input.payments!, fee);
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

/**
 * The one field the operator must actually read. Rendered as a sentence rather than
 * left as numbers, because the decision ("this creates a 240 EUR debt") is what needs
 * approving — not the arithmetic behind it.
 */
function buildMoney(
  props: Map<string, unknown>,
  action: "copy" | "move",
  payments: "from_target_class" | "do_not_change",
  fee: { fee: number | null; unit_price: number | null },
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
  const priced = payments === "from_target_class";
  const total = !priced || targetPrice === null ? null : targetPrice + (fee.fee ?? 0);

  let result: string;
  if (payments === "do_not_change") {
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
    currently_owed: owed,
    credit_on_account: credit,
    already_paid: paid,
    current_class_price_total: currentPrice,
    target_class_price_total: targetPrice,
    target_registration_fee: priced ? fee.fee : null,
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
 */
async function fetchTargetFee(
  scheduleId: number,
  auth: ZoozaAuth,
): Promise<{ fee: number | null; unit_price: number | null }> {
  interface ScheduleRow {
    course_id?: unknown;
    registration_fee?: unknown;
    unit_price?: unknown;
  }
  let schedule: ScheduleRow;
  try {
    schedule = await zoozaFetch<ScheduleRow>(`/schedules/${scheduleId}`, {}, auth);
  } catch {
    return { fee: null, unit_price: null };
  }
  const unit_price = numOrNull(schedule?.unit_price);
  const own = numOrNull(schedule?.registration_fee);
  if (own !== null && own !== 0) return { fee: own, unit_price };

  const courseId = numOrNull(schedule?.course_id);
  if (courseId === null) return { fee: own, unit_price };
  try {
    const course = await zoozaFetch<{ registration_fee?: unknown }>(`/courses/${courseId}`, {}, auth);
    return { fee: numOrNull(course?.registration_fee) ?? own, unit_price };
  } catch {
    return { fee: own, unit_price };
  }
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
