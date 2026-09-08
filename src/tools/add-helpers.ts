import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import {
  loadTrainerDirectory,
  type TrainerDirectory,
} from "./trainer-directory.js";
import {
  getUpdatePlan,
  type HelpersPlan,
  markUpdatePlanUsed,
  saveUpdatePlan,
} from "./update-plan-store.js";
import type { ApiListResponse, RawEventRecord, RawScheduleRecord } from "./types.js";

/**
 * trainers_add_helpers — spec ZMCP-20260908-001.
 *
 * ── The domain fact everything here rests on ────────────────────────────────
 * There are TWO tables and they are not a cascade of one fact:
 *   trainers_schedules — the class's ELIGIBILITY ROSTER
 *   trainers_events    — the ACTUAL per-session assignment
 *
 * The normal arrangement is that a lecturer registered on a class works EVERY
 * session of it. Restricting someone to certain weekdays is the exception.
 *
 * ── The ordering rule (non-negotiable) ──────────────────────────────────────
 * The class-level row MUST exist before any session-level write for the same
 * trainer+class. api-v1 does NOT enforce this: Event::add_trainer_to_event()
 * copies `role` from trainers_schedules, gets nothing when the trainer is not
 * on the class, and inserts anyway — producing a row with role NULL. Verified
 * live 2026-09-08 (event 65459 / trainer 11145, api-v1 class/Event.php:840-865).
 * So: roster PUT first, and if it fails, that trainer's session writes in that
 * class are SKIPPED, not attempted.
 *
 * ── Why unrestricted assignments cost no event calls ────────────────────────
 * Schedule::set_trainer() (class/Schedule.php:1370-1409) reads `update_mode`:
 *   "all"      → also write trainers_events for EVERY event
 *   "upcoming" → ... for events with date > now
 *   anything else (the app sends "schedule") → class row only, no events
 * So an unrestricted assignment is one PUT per class per trainer and zero event
 * PUTs — the server fans out. Only restricted assignments need the per-session
 * loop, and they use update_mode "schedule".
 */

const ROLES = ["secondary", "assistant", "helper", "trainer"] as const;
type Role = (typeof ROLES)[number];

/** App default for a newly added class-level trainer
 *  (app pages/courses/schedules_detail.js:850). */
const DEFAULT_ROLE: Role = "secondary";

/** Operator-facing EN labels come from the APP (lib/str_en3.js:1121-1124), which
 *  disagrees with api-v1's locale_text_content.php on `helper`. The app is what
 *  operators actually read, so it wins. */
const ROLE_LABELS: Record<Role, string> = {
  secondary: "Secondary instructor",
  assistant: "Assistant",
  helper: "Assistant instructor",
  trainer: "Instructor",
};

const SESSION_SCOPES = ["all", "upcoming", "class_only"] as const;
type SessionScope = (typeof SESSION_SCOPES)[number];

/** session_scope → api-v1 update_mode. `class_only` maps to the app's spelling
 *  "schedule"; api-v1 treats any unrecognised value as class-only, but we never
 *  rely on that — always send a value api-v1 explicitly handles or the app uses. */
const UPDATE_MODE: Record<SessionScope, "all" | "upcoming" | "schedule"> = {
  all: "all",
  upcoming: "upcoming",
  class_only: "schedule",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const addHelpersTitle = "Add additional lecturers to classes and sessions";

export const addHelpersDescription =
  "Register **additional lecturers** — a second instructor, assistant, or helper — on one or more classes, and " +
  "control which of their sessions each one actually works. This is NOT how you set or change a class's main " +
  "instructor (that is `classes_update`, or `sessions_update` for one-off substitutions); additional lecturers are " +
  "extra people who work *alongside* the main instructor. By default a lecturer you add here works **every** session " +
  "of the class — that is the normal arrangement. Restrict one to certain days by giving that assignment `weekdays` " +
  "(1=Monday … 7=Sunday), or to hand-picked sessions with `event_ids`. This handles the whole \"Martin works Mondays, " +
  "Peter works Tuesdays, both on Wednesdays\" pattern across a programme's classes in one action. Select classes with " +
  "`schedule_ids`, or the way operators say it — `course_id` plus `billing_period_id` (\"the Junior classes in Winter " +
  "2026\"). Resolve `trainer_id` first with `classes_find_resource kind:\"trainer\"`, and the programme and billing " +
  "period with `classes_find_courses` and `classes_find_resource kind:\"billing_period\"`. `role` is one of " +
  "`secondary` (\"Secondary instructor\", the default), `assistant` (\"Assistant\"), `helper` (\"Assistant instructor\") " +
  "or `trainer` (\"Instructor\"), and is per CLASS — Zooza cannot give someone one role on Mondays and another on " +
  "Wednesdays. This writes across every class and session you select, so it is a two-step tool: call it once with no " +
  "token to get a plan naming every class and session count, show that to the operator, then call it again with the " +
  "returned token and `confirmed: true`. To SEE who is currently assigned, use `sessions_find_events` (per session) " +
  "or `classes_find_classes` (the class roster).";

const assignmentSchema = z
  .object({
    trainer_id: z
      .number()
      .int()
      .positive()
      .describe('The lecturer to add. Resolve with classes_find_resource kind:"trainer".'),
    role: z
      .enum(ROLES)
      .optional()
      .describe("Role on the class, default `secondary`. One role per person per class; cannot vary by session."),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .optional()
      .describe(
        "Restrict to these weekdays, 1=Mon … 7=Sun. OMIT for the normal case — no restriction means EVERY " +
          "session of the class, and then `session_scope` is required.",
      ),
    event_ids: z
      .array(z.number().int().positive())
      .min(1)
      .optional()
      .describe(
        "Restrict to these exact sessions instead of weekdays; must be in the selected classes.",
      ),
    from: z
      .string()
      .optional()
      .describe("YYYY-MM-DD. Only sessions on or after this date."),
    to: z
      .string()
      .optional()
      .describe("YYYY-MM-DD. Only sessions on or before this date."),
  })
  .strict();

const deactivateSchema = z
  .object({
    trainer_id: z.number().int().positive().describe("The lecturer to switch off."),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .optional()
      .describe("Switch them off on these weekdays, 1=Mon … 7=Sun."),
    event_ids: z
      .array(z.number().int().positive())
      .min(1)
      .optional()
      .describe("Switch them off on these exact sessions."),
    from: z.string().optional().describe("YYYY-MM-DD. Only sessions on or after this date."),
    to: z.string().optional().describe("YYYY-MM-DD. Only sessions on or before this date."),
  })
  .strict();

export const addHelpersInputSchema = {
  company_id: companyIdSchema,
  schedule_ids: z
    .array(z.number().int().positive())
    .min(1)
    .optional()
    .describe("Classes to act on, by id (resolve with classes_find_classes). Use this OR course_id."),
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Programme whose classes to act on. Requires billing_period_id. Resolve with classes_find_courses.",
    ),
  billing_period_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Term block narrowing the programme. classes_find_resource kind:"billing_period".'),
  assignments: z
    .array(assignmentSchema)
    .optional()
    .describe(
      "Who to put on these classes. Entries for one trainer merge, so \"Martin Mondays, Peter Tuesdays, both " +
        "Wednesdays\" is two entries: Martin [1,3], Peter [2,3].",
    ),
  session_scope: z
    .enum(SESSION_SCOPES)
    .optional()
    .describe(
      "REQUIRED when an assignment has no weekdays/event_ids — that person lands on every session otherwise. " +
        "`upcoming` (usual) / `all` (incl. past) / `class_only` (roster only). Ignored when restricted.",
    ),
  deactivate: z
    .array(deactivateSchema)
    .optional()
    .describe("Turn someone OFF on specific sessions, leaving them on the class roster."),
  remove_from_class: z
    .array(z.number().int().positive())
    .min(1)
    .optional()
    .describe(
      "Remove these lecturers from the selected classes ENTIRELY — roster row AND every session assignment. " +
        "Not reversible in one step; the preview states the session count.",
    ),
  clear_unlisted: z
    .boolean()
    .optional()
    .describe(
      "Default false: sessions in `existing_outside_rules` are left alone. True only once the operator " +
        "confirms they meant \"these days and nothing else\".",
    ),
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
};

const previewInput = z
  .object({
    company_id: z.number().int().positive().optional(),
    schedule_ids: z.array(z.number().int().positive()).min(1).optional(),
    course_id: z.number().int().positive().optional(),
    billing_period_id: z.number().int().positive().optional(),
    assignments: z.array(assignmentSchema).optional(),
    session_scope: z.enum(SESSION_SCOPES).optional(),
    deactivate: z.array(deactivateSchema).optional(),
    remove_from_class: z.array(z.number().int().positive()).min(1).optional(),
    clear_unlisted: z.boolean().optional(),
  })
  .strict();

// ── date helpers ──────────────────────────────────────────────────────────────

/** ISO weekday (1=Mon … 7=Sun) for an api-v1 `Y-m-d H:i:s` string.
 *  Computed in UTC from the DATE PART ONLY — `new Date("2026-11-10 17:30:00")`
 *  is parsed in the host timezone and can shift the weekday across a date
 *  boundary, which would silently put a lecturer on the wrong day. */
export function isoWeekday(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? "");
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return day === 0 ? 7 : day;
}

/** `YYYY-MM-DD` part of an api-v1 datetime, for from/to comparison. */
function datePart(dateStr: string): string {
  return (dateStr ?? "").slice(0, 10);
}

interface Rule {
  weekdays?: number[];
  event_ids?: number[];
  from?: string;
  to?: string;
}

function isRestricted(r: Rule): boolean {
  return Boolean(r.weekdays?.length || r.event_ids?.length || r.from || r.to);
}

/** Does this rule select this session? */
function matches(rule: Rule, ev: { id: number; date: string }): boolean {
  if (rule.event_ids?.length) return rule.event_ids.includes(ev.id);
  const d = datePart(ev.date);
  if (rule.from && d < rule.from) return false;
  if (rule.to && d > rule.to) return false;
  if (rule.weekdays?.length) {
    const wd = isoWeekday(ev.date);
    if (wd === null || !rule.weekdays.includes(wd)) return false;
  }
  return true;
}

// ── phase dispatch ────────────────────────────────────────────────────────────

export async function runAddHelpers(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") return errorResult(decision.message);
  if (decision.kind === "preview") return runPreview(rawInput, auth);
  return runApply(decision.token, auth);
}

// ── preview ───────────────────────────────────────────────────────────────────

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

  // ── selector ──
  const bySchedule = (input.schedule_ids?.length ?? 0) > 0;
  const byCourse = input.course_id !== undefined;
  if (bySchedule === byCourse) {
    return errorResult(
      "Specify which classes: either schedule_ids, or course_id together with billing_period_id. Resolve a " +
        "programme with classes_find_courses and a billing period with classes_find_resource " +
        'kind:"billing_period".',
    );
  }
  if (byCourse && input.billing_period_id === undefined) {
    return errorResult(
      "course_id needs billing_period_id alongside it, otherwise this would touch every class in the programme " +
        'across every term. Resolve the term with classes_find_resource kind:"billing_period" — or pass ' +
        "schedule_ids if you really mean specific classes.",
    );
  }
  for (const d of [
    ...(input.assignments ?? []),
    ...(input.deactivate ?? []),
  ]) {
    for (const key of ["from", "to"] as const) {
      const v = d[key];
      if (v !== undefined && !ISO_DATE.test(v)) {
        return errorResult(`\`${key}\` must be YYYY-MM-DD; got "${v}".`);
      }
    }
  }

  // ── merge assignments per trainer ──
  const merged = new Map<number, { role: Role; explicitRole: boolean; rules: Rule[] }>();
  for (const a of input.assignments ?? []) {
    const existing = merged.get(a.trainer_id);
    const rule: Rule = {
      weekdays: a.weekdays,
      event_ids: a.event_ids,
      from: a.from,
      to: a.to,
    };
    if (!existing) {
      merged.set(a.trainer_id, {
        role: a.role ?? DEFAULT_ROLE,
        explicitRole: a.role !== undefined,
        rules: [rule],
      });
      continue;
    }
    if (a.role !== undefined && existing.explicitRole && a.role !== existing.role) {
      return errorResult(
        `trainer_id ${a.trainer_id} was given two different roles ("${existing.role}" and "${a.role}"). A ` +
          "lecturer has ONE role per class in Zooza — it cannot vary by day. Pick one and put all their " +
          "weekdays in a single assignment.",
      );
    }
    if (a.role !== undefined && !existing.explicitRole) {
      existing.role = a.role;
      existing.explicitRole = true;
    }
    existing.rules.push(rule);
  }

  const hasUnrestricted = [...merged.values()].some((m) => m.rules.some((r) => !isRestricted(r)));
  if (hasUnrestricted && input.session_scope === undefined) {
    const who = [...merged.entries()]
      .filter(([, m]) => m.rules.some((r) => !isRestricted(r)))
      .map(([id]) => `trainer_id ${id}`)
      .join(", ");
    return errorResult(
      `${who} has no weekdays or event_ids, so they would be added to every session of every selected class. Set ` +
        "session_scope: 'all' (every session, past included), 'upcoming' (future sessions only — usual), or " +
        "'class_only' (register on the class but activate no sessions yet).",
    );
  }

  const nothingToDo =
    merged.size === 0 &&
    (input.deactivate?.length ?? 0) === 0 &&
    (input.remove_from_class?.length ?? 0) === 0;
  if (nothingToDo) {
    return errorResult(
      "Nothing to do: give at least one of `assignments` (who to add), `deactivate` (turn someone off on " +
        "specific sessions), or `remove_from_class` (take someone off the class entirely).",
    );
  }

  const callAuth = withCompany(auth, input.company_id!);

  // ── 1. resolve classes ──
  let schedules: RawScheduleRecord[];
  try {
    const query: Record<string, string | number | undefined> = {
      filter: "filter",
      page_size: 200,
      load_trainers: 1,
    };
    if (bySchedule) query.ids = input.schedule_ids!.join("|");
    else {
      query.course_id = input.course_id;
      query.billing_period_id = input.billing_period_id;
    }
    const raw = await zoozaFetch<ApiListResponse<RawScheduleRecord> | RawScheduleRecord[]>(
      "/schedules",
      { query },
      callAuth,
    );
    schedules = unwrapList<RawScheduleRecord>(raw).records;
  } catch (error) {
    return zoozaError(error, "Could not resolve the classes to act on");
  }

  if (schedules.length === 0) {
    return errorResult(
      bySchedule
        ? `No classes found for schedule_ids ${input.schedule_ids!.join(", ")}. Resolve them with ` +
            "classes_find_classes."
        : `No classes found for course_id ${input.course_id} in billing_period_id ${input.billing_period_id}. ` +
            "Check the programme and term with classes_find_courses / classes_find_resource, or pass " +
            "schedule_ids directly.",
    );
  }
  const scheduleIds = schedules.map((s) => s.id);

  // ── 2. read sessions + current assignments (ONE call for every class) ──
  let events: RawEventRecord[];
  try {
    const raw = await zoozaFetch<ApiListResponse<RawEventRecord> | RawEventRecord[]>(
      "/events",
      {
        // filter=filter is mandatory or schedule_id is silently ignored and this
        // would diff against the wrong sessions (the sessions_update bug).
        query: { filter: "filter", schedule_id: scheduleIds.join("|"), page_size: 2000, status: "any" },
      },
      callAuth,
    );
    events = unwrapList<RawEventRecord>(raw).records;
  } catch (error) {
    // Abort: a plan built on a partial session read would silently under-write.
    return zoozaError(error, "Could not read the sessions of the selected classes");
  }

  // ── validate ids against what we actually selected ──
  const knownEventIds = new Set(events.map((e) => e.id));
  const namedEventIds = [
    ...(input.assignments ?? []).flatMap((a) => a.event_ids ?? []),
    ...(input.deactivate ?? []).flatMap((d) => d.event_ids ?? []),
  ];
  const strayEventIds = [...new Set(namedEventIds.filter((id) => !knownEventIds.has(id)))];
  if (strayEventIds.length > 0) {
    return errorResult(
      `event_ids [${strayEventIds.join(", ")}] do not belong to the selected classes. Additional lecturers are ` +
        "assigned per class; find the class first with classes_find_classes, then its sessions with " +
        "sessions_find_events.",
    );
  }

  const dir = await loadTrainerDirectory(callAuth);
  const namedTrainers = [
    ...merged.keys(),
    ...(input.deactivate ?? []).map((d) => d.trainer_id),
    ...(input.remove_from_class ?? []),
  ];
  if (dir.complete) {
    const unknown = [...new Set(namedTrainers.filter((id) => dir.name(id) === null))];
    if (unknown.length > 0) {
      return errorResult(
        `trainer_id ${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not a trainer in this company. ` +
          'Resolve trainers with classes_find_resource kind:"trainer" — do not guess ids.',
      );
    }
  }

  // ── 3. diff, per class ──
  const scope: SessionScope = input.session_scope ?? "class_only";
  const planClasses: HelpersPlan["classes"] = [];
  const summaryClasses: unknown[] = [];
  const existingOutsideRules: unknown[] = [];
  let totalActivate = 0;
  let totalDeactivate = 0;

  for (const sched of schedules) {
    const sessions = events
      .filter((e) => (e.schedule_id ?? 0) === sched.id)
      .map((e) => ({
        id: e.id,
        date: pickStr(e.date) ?? "",
        assigned: new Set((e.trainers_events ?? []).map((t) => t.trainer_id ?? 0)),
      }));

    const rosterWrites: HelpersPlan["classes"][number]["roster_writes"] = [];
    // event_id → trainer toggles for that session
    const eventToggles = new Map<number, Map<number, boolean>>();
    const toggle = (eventId: number, trainerId: number, active: boolean) => {
      let m = eventToggles.get(eventId);
      if (!m) {
        m = new Map();
        eventToggles.set(eventId, m);
      }
      m.set(trainerId, active);
    };

    const changes: unknown[] = [];

    for (const [trainerId, spec] of merged) {
      const unrestricted = spec.rules.some((r) => !isRestricted(r));
      const onRoster = (sched.trainers_schedules ?? []).some((t) => t.trainer_id === trainerId);

      // The roster write is ALWAYS issued, even when the trainer is already on
      // the class: Schedule::set_trainer() is an upsert, so it is idempotent and
      // also repairs a drifted role.
      const update_mode = unrestricted ? UPDATE_MODE[scope] : "schedule";
      rosterWrites.push({ trainer_id: trainerId, role: spec.role, update_mode });

      let activate = 0;
      let clearedOutsideRules = 0;
      if (unrestricted) {
        // No event calls — update_mode all/upcoming fans out server-side.
        // Report what the server will do so the operator sees the real count.
        if (scope === "all") activate = sessions.filter((s) => !s.assigned.has(trainerId)).length;
        else if (scope === "upcoming") {
          const today = new Date().toISOString().slice(0, 10);
          activate = sessions.filter(
            (s) => datePart(s.date) > today && !s.assigned.has(trainerId),
          ).length;
        }
      } else {
        const wanted = sessions.filter((s) => spec.rules.some((r) => isRestricted(r) && matches(r, s)));
        for (const s of wanted) {
          if (!s.assigned.has(trainerId)) {
            toggle(s.id, trainerId, true);
            activate += 1;
          }
        }
        // Sessions where they are assigned today but no rule mentions — reported
        // always, acted on only with clear_unlisted.
        const stray = sessions.filter(
          (s) => s.assigned.has(trainerId) && !spec.rules.some((r) => isRestricted(r) && matches(r, s)),
        );
        if (stray.length > 0) {
          const weekdays = [...new Set(stray.map((s) => isoWeekday(s.date)).filter((d): d is number => d !== null))].sort();
          existingOutsideRules.push({
            trainer_id: trainerId,
            trainer_name: dir.name(trainerId),
            schedule_id: sched.id,
            class_name: pickStr(sched.name) ?? "",
            sessions: stray.length,
            weekdays,
            event_ids: stray.map((s) => s.id),
            note: input.clear_unlisted
              ? `${dir.name(trainerId) ?? `trainer ${trainerId}`} will be REMOVED from ${stray.length} session(s) in "${pickStr(sched.name) ?? sched.id}" that your rules do not mention (clear_unlisted: true).`
              : `${dir.name(trainerId) ?? `trainer ${trainerId}`} is currently on ${stray.length} session(s) in "${pickStr(sched.name) ?? sched.id}" that none of your rules mention. They were left as-is. If the operator meant "these days and nothing else", confirm with them and re-run with clear_unlisted: true.`,
          });
          if (input.clear_unlisted) {
            for (const s of stray) toggle(s.id, trainerId, false);
            // Must be counted: the preview's totals are the operator's consent
            // surface, and clearing sessions they cannot see in the numbers is
            // exactly the failure this tool's two-step shape exists to prevent.
            clearedOutsideRules = stray.length;
          }
        }
      }

      changes.push({
        trainer_id: trainerId,
        trainer_name: dir.name(trainerId),
        role: spec.role,
        role_label: ROLE_LABELS[spec.role],
        class_roster: onRoster ? "already_on_class" : "add",
        scope: unrestricted ? `every session (${scope})` : "restricted",
        sessions_activate: activate,
        sessions_deactivate: clearedOutsideRules,
      });
      totalActivate += activate;
      totalDeactivate += clearedOutsideRules;
    }

    // ── explicit deactivations ──
    for (const d of input.deactivate ?? []) {
      const rule: Rule = { weekdays: d.weekdays, event_ids: d.event_ids, from: d.from, to: d.to };
      const targets = sessions.filter(
        (s) => s.assigned.has(d.trainer_id) && (isRestricted(rule) ? matches(rule, s) : true),
      );
      for (const s of targets) toggle(s.id, d.trainer_id, false);
      if (targets.length > 0) {
        changes.push({
          trainer_id: d.trainer_id,
          trainer_name: dir.name(d.trainer_id),
          class_roster: "unchanged",
          sessions_deactivate: targets.length,
        });
        totalDeactivate += targets.length;
      }
    }

    // ── class-level removals ──
    const rosterDeletes: number[] = [];
    for (const trainerId of input.remove_from_class ?? []) {
      const onRoster = (sched.trainers_schedules ?? []).some((t) => t.trainer_id === trainerId);
      const assignedSessions = sessions.filter((s) => s.assigned.has(trainerId)).length;
      if (!onRoster && assignedSessions === 0) continue;
      rosterDeletes.push(trainerId);
      changes.push({
        trainer_id: trainerId,
        trainer_name: dir.name(trainerId),
        class_roster: "remove",
        sessions_cleared: assignedSessions,
        warning:
          `Removing ${dir.name(trainerId) ?? `trainer ${trainerId}`} from "${pickStr(sched.name) ?? sched.id}" ` +
          `also clears their assignment on ${assignedSessions} individual session(s). This cannot be undone in ` +
          "one step.",
      });
    }

    const eventWrites = [...eventToggles.entries()].map(([event_id, toggles]) => ({
      event_id,
      additional_trainers: [...toggles.entries()].map(([trainer_id, is_active]) => ({
        trainer_id,
        is_active,
      })),
    }));

    if (rosterWrites.length === 0 && eventWrites.length === 0 && rosterDeletes.length === 0) continue;

    planClasses.push({
      schedule_id: sched.id,
      name: pickStr(sched.name) ?? "",
      roster_writes: rosterWrites,
      event_writes: eventWrites,
      roster_deletes: rosterDeletes,
    });
    summaryClasses.push({
      schedule_id: sched.id,
      name: pickStr(sched.name) ?? "",
      sessions_total: sessions.length,
      changes,
    });
  }

  if (planClasses.length === 0) {
    return errorResult(
      "Nothing would change — the lecturers you named are already assigned exactly as described on the " +
        `${schedules.length} selected class(es). Read the current state with sessions_find_events if that is ` +
        "unexpected.",
    );
  }

  const warnings: string[] = [];
  const totalSessions = planClasses.reduce((n, c) => n + c.event_writes.length, 0);
  if (totalActivate > 0 || totalDeactivate > 0) {
    warnings.push(
      `This changes ${totalActivate} session assignment(s) on and ${totalDeactivate} off, across ` +
        `${planClasses.length} class(es).`,
    );
  }
  if (planClasses.some((c) => c.roster_deletes.length > 0)) {
    warnings.push(
      "Class-level removals also clear every session assignment for that lecturer in that class, and cannot be " +
        "undone in one step.",
    );
  }
  if (!dir.complete) {
    warnings.push(
      "The trainer roster could not be fully read, so some names show as null and trainer ids were not " +
        "validated. The ids are used exactly as given.",
    );
  }

  const summary = {
    classes: summaryClasses,
    totals: {
      classes: planClasses.length,
      trainers: merged.size,
      sessions_activate: totalActivate,
      sessions_deactivate: totalDeactivate,
      event_writes: totalSessions,
    },
    existing_outside_rules: existingOutsideRules,
    clear_unlisted: input.clear_unlisted ?? false,
    warnings,
  };

  const plan: HelpersPlan = {
    kind: "helpers",
    company_id: input.company_id!,
    classes: planClasses,
    summary,
  };
  const { token, expires_in_seconds } = saveUpdatePlan(plan);

  return {
    content: [{ type: "text", text: JSON.stringify({ token, expires_in_seconds, summary }, null, 2) }],
  };
}

// ── apply ─────────────────────────────────────────────────────────────────────

async function runApply(
  token: string,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const lookup = getUpdatePlan(token);
  if (!lookup.ok) {
    return errorResult(
      "This plan is no longer valid (tokens are single-use and expire after 15 minutes — this one is " +
        `${lookup.reason}). Call trainers_add_helpers again and re-confirm with the operator.`,
    );
  }
  if (lookup.plan.kind !== "helpers") {
    return errorResult("This token is not an additional-lecturer plan. Use the tool that produced it.");
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);

  const applied: Array<Record<string, unknown>> = [];
  let anyFailure = false;

  // Per class, in order. There is no upstream transaction and no rollback: a
  // half-applied fan-out is reported honestly and re-run, which is safe because
  // every write here is idempotent.
  for (const cls of plan.classes) {
    const failed: string[] = [];
    let rosterWrites = 0;
    let sessionWrites = 0;
    let rosterDeletes = 0;
    /** Trainers whose roster write failed — their session writes are SKIPPED,
     *  because an event write without the roster row inserts role NULL. */
    const blocked = new Set<number>();

    for (const rw of cls.roster_writes) {
      try {
        await zoozaFetch<unknown>(
          `/schedules/${cls.schedule_id}/trainers/${rw.trainer_id}`,
          { method: "PUT", body: { role: rw.role, update_mode: rw.update_mode } },
          callAuth,
        );
        rosterWrites += 1;
      } catch (error) {
        blocked.add(rw.trainer_id);
        failed.push(
          `roster write for trainer ${rw.trainer_id}: ${describeError(error)} (their session changes in this ` +
            "class were skipped, to avoid creating assignments with no role)",
        );
      }
    }

    for (const ew of cls.event_writes) {
      const usable = ew.additional_trainers.filter((t) => !blocked.has(t.trainer_id));
      if (usable.length === 0) continue;
      try {
        // Send ONLY additional_trainers. api-v1 treats each entry independently
        // (delta, not replace) and leaves every other event field untouched.
        await zoozaFetch<unknown>(
          `/events/${ew.event_id}`,
          { method: "PUT", body: { additional_trainers: usable } },
          callAuth,
        );
        sessionWrites += 1;
      } catch (error) {
        failed.push(`session ${ew.event_id}: ${describeError(error)}`);
      }
    }

    for (const trainerId of cls.roster_deletes) {
      try {
        await zoozaFetch<unknown>(
          `/schedules/${cls.schedule_id}/trainers/${trainerId}`,
          { method: "DELETE" },
          callAuth,
        );
        rosterDeletes += 1;
      } catch (error) {
        failed.push(`removal of trainer ${trainerId}: ${describeError(error)}`);
      }
    }

    if (failed.length > 0) anyFailure = true;
    applied.push({
      schedule_id: cls.schedule_id,
      name: cls.name,
      roster_writes: rosterWrites,
      session_writes: sessionWrites,
      roster_deletes: rosterDeletes,
      failed,
    });
  }

  // Burn the token only on a clean run. A partial failure leaves it valid for
  // one idempotent retry of the same plan.
  if (!anyFailure) markUpdatePlanUsed(token);

  const okClasses = applied.filter((a) => (a.failed as string[]).length === 0).length;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            object: "additional_lecturers",
            updated: !anyFailure,
            classes_applied: `${okClasses} of ${plan.classes.length}`,
            applied,
            note: anyFailure
              ? "Partially applied. Nothing was rolled back; every write here is idempotent, so re-running the " +
                "same token is safe and will only redo what failed. Report which classes failed to the operator."
              : "Applied. Additional lecturers are registered on the class (the eligibility roster) and switched " +
                "on for the sessions shown. Describe the result by class name, not by session id.",
            summary: plan.summary,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function describeError(error: unknown): string {
  if (error instanceof ZoozaApiError) return `api-v1 ${error.status}: ${error.humanMessage}`;
  return error instanceof Error ? error.message : String(error);
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
