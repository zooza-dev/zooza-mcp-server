import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
);

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export function loadAllSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const files = readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files.map((f) => {
    const content = readFileSync(resolve(SKILLS_DIR, f), "utf-8");
    const { meta, body } = parseFrontmatter(content);
    return {
      name: meta.name ?? f.replace(/\.md$/, ""),
      description: meta.description ?? "",
      body: body.trim(),
    };
  });
}

export function buildSkillInstructions(skills: Skill[]): string {
  const sections: string[] = [
    "This MCP server exposes Zooza operational tools plus (optionally) a small set of **skills** (playbooks) that teach you how to compose those tools well.",
    "",
    "## Session bootstrap (do this before any operational tool)",
    "1. Call `whoami` once per conversation. The response includes `available_companies` — the Zooza companies this user can operate on.",
    "2. Pick the company you'll operate against:",
    "   - If `available_companies.length === 1`, you can omit `company_id` from every tool call — the server will default to it. Briefly tell the user which company you're working in.",
    "   - If multiple AND the user has unambiguously named one (e.g. *\"in the Bratislava studio\"*), match by name and pass `company_id` explicitly.",
    "   - If multiple AND the user hasn't specified, **ask them** before any other tool — render the options as a table (`id | name`).",
    "3. When `available_companies.length > 1`, **every** operational tool call needs an explicit `company_id`. You may use different `company_id` values in the same conversation to operate across companies (e.g. comparisons).",
    "4. If you already have a `whoami` response in your context from earlier this conversation, don't re-call it.",
  ];

  sections.push(
    "",
    "## Reference tools (call on demand — no API required)",
    "These tools return hardcoded Zooza knowledge instantly. Call them when the user asks a direct question or when you need to resolve a value before calling an operational tool.",
    "- `explain_data_model` — entity hierarchy, valid status values, do-not-confuse rules. Use when the user's request is ambiguous about which entity they mean.",
    "- `list_schedule_patterns` — valid cadences (weekly/biweekly/monthly/daily), weekday keys (mon/tue…), time_minutes format, payment schedule types. Use when building a class schedule from scratch without a skill.",
    "- `list_message_merge_vars` — all valid *|MERGE_VAR|* tags for email/SMS templates. Use when the user asks to write or edit a message template.",
    "- `get_terminology` — multilingual term lookup (e.g. 'hodina' → Session). Use when the user's language is ambiguous.",
    "Do NOT call these proactively on every request — only when genuinely needed.",
  );

  if (skills.length > 0) {
    const list = skills
      .map((s) => `- \`${s.name}\` — ${s.description}`)
      .join("\n");
    sections.push(
      "",
      "## Available skills",
      list,
      "",
      "When the user's request matches a skill's purpose, call the `get_skill` tool with the skill name **before** invoking the underlying operational tools — it returns the full playbook with the interview steps, mapping rules, and confirmation flow for that scenario. Skill content is stable within a session; do not re-fetch the same skill more than once per session.",
    );
  }

  return sections.join("\n");
}

function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] ?? "" };
}
