import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserFacingError } from "../errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadTemplate(): string {
  const candidatePaths = [
    path.resolve(here, "../../data/template.md"),
    path.resolve(here, "../../../data/template.md"),
    path.resolve(process.cwd(), "data/template.md"),
    path.resolve(process.cwd(), "job-hunt-mcp/data/template.md"),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  throw new UserFacingError("template.md could not be found.");
}

// One line, trimmed, length-capped, no trailing period.
// Used on any text that came from outside the template.
export function cleanLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max).replace(/[.\s]+$/, "");
}

export function fillTemplate(template: string, values: Record<string, string>) {
  const filled = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (!(key in values)) {
      throw new UserFacingError(`Template placeholder {${key}} has no value.`);
    }
    return values[key];
  });
  const match = filled.match(/^Subject:\s*(.+?)\r?\n\r?\n([\s\S]*)$/);
  if (!match) {
    throw new UserFacingError(
      "Template must start with a 'Subject:' line, a blank line, then the body."
    );
  }
  return { subject: match[1].trim(), body: match[2].trim() };
}

export function buildIntro(
  companyName: string,
  fundingRound: string | null,
  focus?: string,
  observation?: string
): string {
  const f = focus ? cleanLine(focus, 120) : "";
  const o = observation ? cleanLine(observation, 200) : "";
  if (f && o) {
    return `I came across ${companyName} and found your work on ${f} interesting. I particularly liked ${o}.`;
  }
  if (f) {
    return `I came across ${companyName} and found your work on ${f} interesting.`;
  }
  const after = fundingRound ? ` after your ${fundingRound} announcement` : "";
  return `I came across ${companyName}${after} and was interested in what you're building.`;
}

export function buildEmail(
  company: { name: string; funding_round: string | null },
  contactName: string | null,
  focus?: string,
  observation?: string
) {
  return fillTemplate(loadTemplate(), {
    company: company.name,
    contact_name: contactName ?? "there",
    intro: buildIntro(company.name, company.funding_round, focus, observation),
  });
}
