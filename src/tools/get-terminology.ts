import { z } from "zod";
import {
  TERMINOLOGY_INDEX,
  type TerminologyEntry,
} from "../terminology/index.js";

export const getTerminologyTitle = "Look up Zooza terminology";

export const getTerminologyDescription =
  "Search the Zooza domain glossary. Returns canonical term names, definitions, " +
  "cross-language synonyms, disambiguation rules, and AI guidance notes. " +
  "No Zooza API call is made — purely local lookup against the compiled glossary. " +
  "Use this to resolve ambiguous user input before calling operational tools. " +
  'Examples: query="hodina" → Session; query="kurz", language="sk" → Programme; ' +
  'category="product-hierarchy" → all hierarchy terms; empty call → full index.';

export const getTerminologyInputSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Term, synonym, or keyword to look up. Matched against canonical_en, synonyms, " +
        "deprecated terms, and intent_keywords (all languages). Case-insensitive substring match.",
    ),
  language: z
    .enum(["en", "sk", "cz", "de", "pl", "ro", "hu", "it", "fr"])
    .optional()
    .describe(
      "Restrict intent_keyword matching to this language. Also highlights translations " +
        "for the given language in the response.",
    ),
  category: z
    .enum([
      "product-hierarchy",
      "programme-types",
      "bookings",
      "attendance",
      "payments",
      "clients",
      "communication",
      "platform",
      "settings",
      "scheduling",
      "client-management",
    ])
    .optional()
    .describe("Filter by glossary category."),
};

const inputSchema = z.object(getTerminologyInputSchema);

function matchesQuery(entry: TerminologyEntry, q: string, lang?: string): boolean {
  const lower = q.toLowerCase();

  if (entry.canonical_en.toLowerCase().includes(lower)) return true;
  if (entry.synonyms.some((s) => s.toLowerCase().includes(lower))) return true;
  if (entry.deprecated.some((d) => d.toLowerCase().includes(lower))) return true;

  const kw = entry.intent_keywords;
  if (lang) {
    // Language-specific first
    if ((kw[lang] ?? []).some((k) => k.toLowerCase().includes(lower))) return true;
    // Also check English as fallback
    if ((kw.en ?? []).some((k) => k.toLowerCase().includes(lower))) return true;
  } else {
    // Check all languages
    for (const keywords of Object.values(kw)) {
      if (keywords.some((k) => k.toLowerCase().includes(lower))) return true;
    }
  }

  if (entry.id.toLowerCase().includes(lower)) return true;
  return false;
}

function projectEntry(entry: TerminologyEntry, lang?: string): object {
  if (!lang) return entry;
  // When a language is specified, surface language-specific data prominently
  return {
    ...entry,
    translation_for_language: entry.translations[lang] ?? null,
    intent_keywords_for_language: entry.intent_keywords[lang] ?? [],
  };
}

export async function runGetTerminology(rawInput: unknown): Promise<{
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

  const { query, language, category } = parsed.data;

  let results: TerminologyEntry[] = TERMINOLOGY_INDEX;

  // 1. Filter by category
  if (category) {
    results = results.filter((e) => e.category === category);
  }

  // 2. Filter by query
  if (query?.trim()) {
    const q = query.trim();
    results = results.filter((e) => matchesQuery(e, q, language));
  }

  // 3. Project (highlight language-specific data if requested)
  const projected = results.map((e) => projectEntry(e, language));

  const envelope = {
    total: projected.length,
    ...(query ? { query } : {}),
    ...(language ? { language } : {}),
    ...(category ? { category } : {}),
    matches: projected,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}
