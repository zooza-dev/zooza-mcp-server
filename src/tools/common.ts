import { z } from "zod";

/**
 * Shared zod schema fragment used as the `company_id` input on every
 * operational tool. Optional — when omitted, the server-side wrapper
 * (`resolveCompanyId` in index.ts) fills it in from the session if the
 * user has exactly one company. With multiple companies, the wrapper
 * returns a directive error listing the options so the LLM can pick.
 *
 * The description surfaces in the JSON schema served to MCP clients and
 * is the primary discovery hint for the LLM.
 */
export const companyIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Zooza company id to operate against. Optional: if the user has exactly one company, the server defaults to it — you can omit this field. With multiple companies, you MUST specify which; get the id list from `whoami.available_companies[].id`. If the user hasn't indicated which company they mean, ask them before guessing.",
  );
