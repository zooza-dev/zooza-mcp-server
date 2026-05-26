import { z } from "zod";
import { TERMINOLOGY_INDEX, type TerminologyEntry } from "../terminology/index.js";

export const negotiateTerminologyTitle =
  "Negotiate terminology — build a personalised vocabulary profile";

export const negotiateTerminologyDescription =
  "Free tool — no Zooza API call, no company_id required. Two modes:\n" +
  '  "start" → returns the 8-question interview template for Claude to conduct conversationally.\n' +
  '  "build" → validates answers against the Zooza glossary, returns a TerminologyProfile JSON\n' +
  '            plus a /remember instruction so Claude saves the profile to memory.\n' +
  "Run once per user. The saved profile is auto-loaded in every future Zooza session — no\n" +
  "re-configuration needed. Call get_skill('negotiate-terminology') before starting the interview.";

// ── Interview template ────────────────────────────────────────────────────────

const INTERVIEW_CONCEPTS = [
  {
    concept: "locale",
    zooza_canonical: "(meta — not a Zooza concept)",
    description:
      "Primary language of this studio. Used to pick the right keyword lists during matching.",
    examples: ["sk", "cz", "en", "de", "pl", "ro", "hu", "it", "fr"],
  },
  {
    concept: "programme",
    zooza_canonical: "Programme",
    description:
      "Top-level container that defines an activity type. Holds pricing, payment settings, and scheduling rules. One Programme can contain multiple Classes.",
    examples: ["kurz", "program", "course", "activity", "curs", "kurzus", "Kurs"],
  },
  {
    concept: "class",
    zooza_canonical: "Class",
    description:
      "A scheduled group within a Programme, typically differentiated by day/time, level, or location. One Class contains multiple Sessions.",
    examples: ["skupina", "Gruppe", "group", "schedule", "grupă", "csoport", "groupe"],
  },
  {
    concept: "session",
    zooza_canonical: "Session",
    description:
      "A single scheduled meeting within a Class, with a specific date and time. Attendance is recorded at session level.",
    examples: ["hodina", "termín", "lekcia", "lesson", "slot", "lekce", "óra", "Termin"],
  },
  {
    concept: "booking",
    zooza_canonical: "Booking",
    description:
      "A client's formal commitment to attend a Class. Creates a payment obligation tied to one specific Class.",
    examples: ["registrácia", "prihláška", "Anmeldung", "reservation", "enrollment", "zápis"],
  },
  {
    concept: "trainer",
    zooza_canonical: "Trainer",
    description:
      "The person who leads sessions. May be a teacher, instructor, coach, or lecturer.",
    examples: ["lektor", "Kursleiter", "instructor", "teacher", "coach", "profesor", "Lehrer"],
  },
  {
    concept: "billing_period",
    zooza_canonical: "Billing Period",
    description:
      "The time window that groups payments and activity — typically a semester, season, or term.",
    examples: ["sezóna", "semester", "term", "season", "polrok", "trimester", "Halbjahr"],
  },
  {
    concept: "client",
    zooza_canonical: "Client",
    description:
      "The person who holds the account, pays, and manages bookings. May book on behalf of family members (attendees).",
    examples: ["klient", "rodič", "parent", "student", "zákazník", "Kunde", "ügyfél"],
  },
] as const;

// ── TERMINOLOGY_INDEX lookup config ───────────────────────────────────────────

/** Maps negotiate_terminology concept name → TERMINOLOGY_INDEX entry id (null = no entry). */
const CONCEPT_INDEX_ID: Record<string, string | null> = {
  programme: "programme",
  class: "class",
  session: "session",
  booking: "booking",
  trainer: "instructor", // TERMINOLOGY_INDEX id is "instructor"; canonical in this tool is "Trainer"
  billing_period: null, // no dedicated entry → always "custom"
  client: "client",
};

/** Canonical English label per spec (used in TerminologyProfile output). */
const CONCEPT_CANONICAL: Record<string, string> = {
  programme: "Programme",
  class: "Class",
  session: "Session",
  booking: "Booking",
  trainer: "Trainer",
  billing_period: "Billing Period",
  client: "Client",
};

// ── Matching logic ────────────────────────────────────────────────────────────

function resolveFrom(
  entry: TerminologyEntry,
  userTerm: string,
  locale: string,
): "intent_keywords" | "synonym" | "custom" {
  const lower = userTerm.toLowerCase().trim();

  // 1. Exact canonical match
  if (entry.canonical_en.toLowerCase() === lower) return "synonym";

  // 2. Synonyms list
  if (entry.synonyms.some((s) => s.toLowerCase() === lower)) return "synonym";

  // 3. intent_keywords — locale-specific first
  const localeKws = entry.intent_keywords[locale] ?? [];
  if (
    localeKws.some(
      (k) =>
        k.toLowerCase() === lower ||
        lower.includes(k.toLowerCase()) ||
        k.toLowerCase().includes(lower),
    )
  )
    return "intent_keywords";

  // 4. intent_keywords — all languages
  for (const kws of Object.values(entry.intent_keywords)) {
    if (
      kws.some(
        (k) =>
          k.toLowerCase() === lower ||
          lower.includes(k.toLowerCase()) ||
          k.toLowerCase().includes(lower),
      )
    )
      return "intent_keywords";
  }

  // 5. Translations — users naturally say the canonical translation for their language
  for (const t of Object.values(entry.translations)) {
    // Translations can be compound e.g. "Skupina / Lekcia" — split and check each part
    const parts = t
      .split("/")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (parts.some((p) => p === lower || lower.includes(p) || p.includes(lower)))
      return "intent_keywords";
  }

  return "custom";
}

// ── Input schema ──────────────────────────────────────────────────────────────

const answersSchema = z.object({
  locale: z
    .string()
    .describe(
      "Primary language code of this studio, e.g. 'sk', 'cz', 'en', 'de', 'pl', 'ro', 'hu'.",
    ),
  programme_term: z.string().describe("What the user calls a Programme."),
  class_term: z.string().describe("What the user calls a Class."),
  session_term: z.string().describe("What the user calls a Session."),
  booking_term: z.string().describe("What the user calls a Booking."),
  trainer_term: z.string().describe("What the user calls a Trainer / Instructor."),
  billing_period_term: z.string().describe("What the user calls a Billing Period."),
  client_term: z.string().describe("What the user calls a Client / Parent."),
  notes: z
    .string()
    .optional()
    .describe("Any additional terminology notes or unusual vocabulary."),
});

export const negotiateTerminologyInputSchema = {
  action: z
    .enum(["start", "build"])
    .describe(
      '"start" — returns the 8-question interview template (call this first, then ask the user the questions conversationally). ' +
        '"build" — validates collected answers and returns TerminologyProfile JSON + /remember instruction.',
    ),
  answers: answersSchema
    .optional()
    .describe('Required when action is "build". Omit for action "start".'),
};

const fullInputSchema = z.object(negotiateTerminologyInputSchema);

// ── Handler ───────────────────────────────────────────────────────────────────

export async function runNegotiateTerminology(rawInput: unknown): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const parsed = fullInputSchema.safeParse(rawInput);
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

  const { action, answers } = parsed.data;

  // ── MODE: start ─────────────────────────────────────────────────────────────
  if (action === "start") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(INTERVIEW_CONCEPTS, null, 2),
        },
      ],
    };
  }

  // ── MODE: build ─────────────────────────────────────────────────────────────
  if (!answers) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: 'Invalid input: answers — required when action is "build".',
        },
      ],
    };
  }

  const locale = answers.locale.toLowerCase().trim();

  const conceptTerms: Record<string, string> = {
    programme: answers.programme_term,
    class: answers.class_term,
    session: answers.session_term,
    booking: answers.booking_term,
    trainer: answers.trainer_term,
    billing_period: answers.billing_period_term,
    client: answers.client_term,
  };

  const mappings: Record<
    string,
    { user_term: string; canonical_en: string; resolved_from: string }
  > = {};

  for (const [concept, userTerm] of Object.entries(conceptTerms)) {
    const indexId = CONCEPT_INDEX_ID[concept];
    let resolved_from: "intent_keywords" | "synonym" | "custom" = "custom";

    if (indexId !== null) {
      const entry = TERMINOLOGY_INDEX.find((e) => e.id === indexId);
      if (entry) {
        resolved_from = resolveFrom(entry, userTerm, locale);
      }
    }

    mappings[concept] = {
      user_term: userTerm,
      canonical_en: CONCEPT_CANONICAL[concept] ?? concept,
      resolved_from,
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  const profile = {
    version: "1" as const,
    spec_id: "ZMCP-20260526-002",
    generated: today,
    locale,
    mappings,
    ...(answers.notes ? { notes: answers.notes } : {}),
  };

  const profileJson = JSON.stringify(profile, null, 2);

  const output = [
    profileJson,
    "",
    "---",
    "SAVE THIS PROFILE — run this now:",
    "/remember Zooza terminology profile for this user:",
    profileJson,
    "",
    "After saving, this profile will be active in every future Zooza session.",
    "You do not need to run negotiate_terminology again unless your terminology changes.",
  ].join("\n");

  return {
    content: [{ type: "text", text: output }],
  };
}
