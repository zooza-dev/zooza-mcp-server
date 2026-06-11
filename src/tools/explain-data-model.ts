import { z } from "zod";

export const explainDataModelTitle = "Explain Zooza data model";

export const explainDataModelDescription =
  "Returns a structured description of Zooza's domain entities — hierarchy, roles, " +
  "valid field values (enums), parent/child relationships, and disambiguation rules. " +
  "No Zooza API call is made — purely hardcoded domain knowledge. " +
  "Call this before any class-creation, booking, or attendance tool to avoid entity confusion. " +
  'Examples: entity="programme" → registration_type enums; entity="booking" → status values; ' +
  "empty call → full hierarchy with all entities.";

export const explainDataModelInputSchema = {
  entity: z
    .enum(["programme", "class", "session", "booking", "attendance", "trainer", "place"])
    .optional()
    .describe(
      "Return full detail for this entity only. Omit to get the complete hierarchy summary.",
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnumValue {
  value: string;
  label: string;
  notes?: string;
}

interface FieldDef {
  name: string;
  description: string;
  values?: EnumValue[];
}

interface EntityDef {
  id: string;
  canonical_name: string;
  api_name: string;
  role: string;
  parent: string | null;
  children: string[];
  key_fields: FieldDef[];
  do_not_confuse_with: Array<{ entity: string; reason: string }>;
  ai_notes: string;
}

// ─── Entity catalogue ────────────────────────────────────────────────────────

const ENTITIES: EntityDef[] = [
  {
    id: "programme",
    canonical_name: "Programme",
    api_name: "Course",
    role:
      "Top-level activity definition. Holds pricing rules, booking form configuration, " +
      "trainer defaults, and schedule templates. Cannot hold Sessions directly — " +
      "it holds Classes (Schedules) which in turn generate Sessions (Events).",
    parent: null,
    children: ["class"],
    key_fields: [
      {
        name: "course_type",
        description: "What kind of activity this programme represents.",
        values: [
          { value: "course", label: "Group programme", notes: "Most common — instructor-led group sessions" },
          { value: "individual", label: "Individual (1:1)", notes: "Single-person lessons; one client per class" },
          { value: "event", label: "Event / lecture", notes: "Single-date event with speakers; no recurring schedule" },
          { value: "online_event", label: "Online event / webinar", notes: "Same as event but online" },
        ],
      },
      {
        name: "registration_type",
        description: "How clients book into the programme — determines the entire billing and attendance model.",
        values: [
          {
            value: "full2",
            label: "Full course booking",
            notes:
              "Client registers for the entire Class (all its Sessions). " +
              "Most common type. Attendance is tracked per session but the booking is for the whole class.",
          },
          {
            value: "open",
            label: "Open / rolling attendance",
            notes:
              "No fixed booking — operator marks attendance session by session. " +
              "Used for drop-in classes or membership-based businesses.",
          },
          {
            value: "single",
            label: "Single-session registration",
            notes: "Client registers for one specific Session, not the whole Class.",
          },
        ],
      },
    ],
    do_not_confuse_with: [
      {
        entity: "class",
        reason:
          "A Programme is the definition (what activity, what price). " +
          "A Class is a specific scheduled group running under that Programme " +
          "(which day, what time, how many people). One Programme can have multiple Classes.",
      },
    ],
    ai_notes:
      "In tool calls the entity is called 'course' (classes_find_courses, course_id). " +
      "In user language it is almost always called 'programme', 'kurz' (SK/CZ), " +
      "'kurzus' (HU), or 'corso' (IT). Never call it 'class' to users.",
  },

  {
    id: "class",
    canonical_name: "Class",
    api_name: "Schedule",
    role:
      "A scheduled group within a Programme. Defines a recurring time slot, " +
      "maximum capacity, trainer assignment, and payment schedule. " +
      "Generates Sessions automatically based on cadence and date range.",
    parent: "programme",
    children: ["session", "booking"],
    key_fields: [
      {
        name: "cadence",
        description: "How often the class meets.",
        values: [
          { value: "weekly", label: "Weekly", notes: "Requires at least one weekday" },
          { value: "biweekly", label: "Every other week", notes: "Requires weekday; NOT 'fortnightly'" },
          { value: "monthly", label: "Monthly", notes: "First occurrence of that weekday per month" },
          { value: "daily", label: "Daily", notes: "No weekday filter needed" },
        ],
      },
      {
        name: "weekdays",
        description:
          "Array of 3-letter lowercase day codes: mon, tue, wed, thu, fri, sat, sun. " +
          "IMPORTANT: the API does not accept 'monday', 'Monday', '1', or 'MO'. " +
          "Required for weekly, biweekly, and monthly cadences.",
      },
      {
        name: "capacity",
        description: "Maximum number of enrolled clients. Bookings above this go to waitlist.",
      },
    ],
    do_not_confuse_with: [
      {
        entity: "programme",
        reason:
          "A Class is an instance of a Programme. The Programme defines WHAT is taught; " +
          "the Class defines WHEN and WHO is in it.",
      },
      {
        entity: "session",
        reason:
          "A Class is the recurring schedule (e.g. 'Monday yoga 18:00 group'). " +
          "A Session is one specific date instance of that Class (e.g. 'Monday 12 May 18:00').",
      },
    ],
    ai_notes:
      "In tool calls: 'schedule_id'. In Slovak: 'skupina'. In German: 'Gruppe'. " +
      "In Hungarian: 'csoport'. In French: 'groupe'. " +
      "Users often say 'class' meaning the recurring group, not a single session.",
  },

  {
    id: "session",
    canonical_name: "Session",
    api_name: "Event",
    role:
      "A single scheduled meeting — one specific date/time instance of a Class. " +
      "Attendance is recorded at the Session level. Sessions are generated automatically " +
      "from the Class schedule; they can also be created manually.",
    parent: "class",
    children: ["attendance"],
    key_fields: [
      {
        name: "start / end",
        description: "ISO 8601 datetime for this specific occurrence.",
      },
      {
        name: "trainer_id",
        description:
          "Trainer assigned to this session. Can override the Class-level default. " +
          "Use virtual trainer IDs for unassigned: 9000000000001 (TBD), " +
          "9000000000002 (Unassigned), 9000000000003 (Guest).",
      },
    ],
    do_not_confuse_with: [
      {
        entity: "class",
        reason:
          "A Session is one date. A Class is the entire recurring schedule. " +
          "'Cancel a session' means cancel one date. 'Cancel a class' means cancel the whole group.",
      },
    ],
    ai_notes:
      "In Slovak/Czech: 'hodina', 'lekcia', 'lekce'. In Hungarian: 'óra'. " +
      "In German: 'Einheit' or 'Stunde'. In tool calls it is 'event_id'. " +
      "'termín' in SK/CZ context always means Session, not appointment or deadline.",
  },

  {
    id: "booking",
    canonical_name: "Booking",
    api_name: "Registration",
    role:
      "A client's registration for a Class. Covers all Sessions in that Class unless " +
      "the registration_type is 'single'. Created when a client signs up. " +
      "A Booking existing does NOT mean the client attended — see Attendance.",
    parent: "class",
    children: ["attendance"],
    key_fields: [
      {
        name: "status",
        description: "Current state of the booking.",
        values: [
          { value: "registered", label: "Enrolled", notes: "Active, confirmed booking" },
          { value: "pre_registered", label: "Pre-registered", notes: "Pending email confirmation from client" },
          { value: "waitlist", label: "Waiting list", notes: "Class is full; client is queued" },
          { value: "late", label: "Late enrollment", notes: "Enrolled after the class started" },
          { value: "trial_started", label: "Trial started", notes: "Trial period is active" },
          { value: "trial_ended", label: "Trial ended", notes: "Trial finished, decision pending" },
          { value: "trial_won", label: "Trial won", notes: "Trial converted to full booking" },
          { value: "trial_lost", label: "Trial lost", notes: "Trial ended without conversion" },
          { value: "canceled", label: "Cancelled", notes: "Booking was cancelled" },
          { value: "guest", label: "Guest", notes: "One-time guest entry" },
        ],
      },
    ],
    do_not_confuse_with: [
      {
        entity: "attendance",
        reason:
          "A Booking = the client signed up (registration record). " +
          "Attendance = did they actually show up to a specific Session. " +
          "A cancelled Booking means the client left the class. " +
          "A 'noshow' Attendance means they had a Booking but didn't come that day.",
      },
    ],
    ai_notes:
      "In Slovak: 'registrácia', 'prihlásenie'. In Czech: 'registrace'. " +
      "In Hungarian: 'foglalás'. In German: 'Anmeldung'. " +
      "In tool calls: 'registration_id'. Users say 'booking', 'registration', or 'enrollment'.",
  },

  {
    id: "attendance",
    canonical_name: "Attendance",
    api_name: "Attendance",
    role:
      "A per-session presence record within a Booking. Created or updated when an " +
      "operator marks attendance for a Session. One attendance record per (Booking × Session).",
    parent: "booking",
    children: [],
    key_fields: [
      {
        name: "status",
        description: "Whether the client was present at this specific Session.",
        values: [
          { value: "attended", label: "Attended", notes: "Client was present" },
          { value: "noshow", label: "Did not attend", notes: "Had a booking, did not show up" },
          { value: "canceled", label: "Cancelled", notes: "Client cancelled this session in advance" },
          { value: "canceled_late", label: "Late cancellation", notes: "Cancelled after the cancellation deadline" },
          { value: "going", label: "Will attend", notes: "Confirmed intention to attend" },
          { value: "hold", label: "Waiting list", notes: "Waiting for a spot in this session" },
          { value: "hide", label: "Hidden", notes: "Not shown to the client (admin use)" },
          { value: "ignore", label: "Ignored", notes: "Excluded from billing calculations" },
          { value: "empty", label: "Unmarked", notes: "Default — attendance not yet recorded" },
        ],
      },
      {
        name: "type",
        description: "What kind of attendance record this is.",
        values: [
          { value: "regular", label: "Regular", notes: "Standard session for an enrolled client" },
          { value: "replacement", label: "Make-up session", notes: "Client attending a different class to make up a missed session" },
        ],
      },
    ],
    do_not_confuse_with: [
      {
        entity: "booking",
        reason:
          "Booking = client is enrolled in the Class. Attendance = did they come to THIS Session. " +
          "You can have a Booking with no Attendance records if attendance hasn't been marked yet.",
      },
    ],
    ai_notes:
      "Attendance is always scoped to one Session. To mark attendance for multiple " +
      "sessions, call the attendance tool once per session. " +
      "'Nahradná hodina' (SK) / 'náhradní lekce' (CZ) = make-up session = type 'replacement'.",
  },

  {
    id: "trainer",
    canonical_name: "Trainer",
    api_name: "Trainer (User with trainer role)",
    role:
      "An instructor assigned to a Class or Session. Can be a real user account " +
      "(with a trainer role in the company) or a virtual placeholder trainer.",
    parent: null,
    children: [],
    key_fields: [
      {
        name: "id",
        description:
          "Integer trainer ID. Real trainers: returned by trainers_find. " +
          "Virtual trainers (system-wide, no user account): " +
          "9000000000001 = To be decided, " +
          "9000000000002 = Trainer unassigned, " +
          "9000000000003 = Guest trainer.",
      },
    ],
    do_not_confuse_with: [],
    ai_notes:
      "In Slovak/Czech: 'lektor', 'lektorka'. In German: 'Kursleiter/in'. " +
      "In Hungarian: 'oktató'. In Italian: 'istruttore/istruttrice'. " +
      "Always use trainers_find to get the real ID — never guess.",
  },

  {
    id: "place",
    canonical_name: "Place",
    api_name: "Course_Place",
    role:
      "A physical or virtual location where Classes take place. Has an address, " +
      "optional room list, and optional online meeting configuration. " +
      "Shared across Programmes within a company.",
    parent: null,
    children: [],
    key_fields: [
      {
        name: "id",
        description: "Integer place ID. Always use classes_find_places — never hardcode.",
      },
      {
        name: "rooms",
        description: "Optional list of rooms within this place (e.g. Studio A, Studio B).",
      },
    ],
    do_not_confuse_with: [],
    ai_notes:
      "In Slovak: 'miesto', 'sála'. In German: 'Ort', 'Studio'. " +
      "Always use classes_find_places to resolve the place ID.",
  },
];

// ─── Tool implementation ─────────────────────────────────────────────────────

const inputSchema = z.object({
  entity: z
    .enum(["programme", "class", "session", "booking", "attendance", "trainer", "place"])
    .optional(),
});

export async function runExplainDataModel(rawInput: unknown): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Invalid input: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
            .join("; ")}.`,
        },
      ],
    };
  }

  const { entity } = parsed.data;

  const HIERARCHY =
    "Programme → Class → Session\n" +
    "Programme → Class → Booking → Attendance\n\n" +
    "A Programme contains Classes.\n" +
    "A Class generates Sessions (scheduled meetings) and holds Bookings (client registrations).\n" +
    "Each Booking × Session pair can have an Attendance record.";

  if (entity) {
    const def = ENTITIES.find((e) => e.id === entity);
    if (!def) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown entity: "${entity}".` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ hierarchy: HIERARCHY, entity: def }, null, 2),
        },
      ],
    };
  }

  // Full model — compact summary
  const summary = ENTITIES.map((e) => ({
    id: e.id,
    canonical_name: e.canonical_name,
    api_name: e.api_name,
    role: e.role,
    parent: e.parent,
    children: e.children,
    do_not_confuse_with: e.do_not_confuse_with.map((d) => d.entity),
    ai_notes: e.ai_notes,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ hierarchy: HIERARCHY, entities: summary }, null, 2),
      },
    ],
  };
}
