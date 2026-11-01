import { searchPeopleViaApollo, type ApolloPerson } from "./apollo.js";

export type ContactTier = "founder" | "recruiter" | "engineer_referral";
export type ApolloSearch = (domainOrName: string, titles: string[], limit: number) => Promise<ApolloPerson[]>;

const FOUNDER_TITLES = ["Founder", "Co-Founder", "Chief Technology Officer", "CTO"];
const RECRUITER_TITLES = ["Technical Recruiter", "Talent Acquisition", "Engineering Manager", "Head of Talent", "Hiring Manager"];
const REFERRAL_TITLES = ["Lead Software Engineer", "Staff Software Engineer", "Senior Software Engineer", "Tech Lead"];
const isVerified = (person: ApolloPerson) =>
  Boolean(person.email) && person.email_status?.toLowerCase() === "verified";

/** Runs the primary Apollo search and the engineer referral fallback. */
export async function runApolloWaterfall(
  domainOrName: string,
  teamSize: number,
  search: ApolloSearch = searchPeopleViaApollo
): Promise<{ tier: ContactTier; people: ApolloPerson[]; diagnostics: Record<string, string> }> {
  const small = teamSize <= 50;
  const primaryTier: ContactTier = small ? "founder" : "recruiter";
  const primaryTitles = small ? FOUNDER_TITLES : RECRUITER_TITLES;
  const diagnostics: Record<string, string> = {};
  let primary: ApolloPerson[] = [];

  try {
    primary = await search(domainOrName, primaryTitles, 5);
    diagnostics.apollo = `${primary.length} people found`;
  } catch (error) {
    diagnostics.apollo = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
  const primaryWithEmail = primary.filter(isVerified);
  if (primaryWithEmail.length) {
    return { tier: primaryTier, people: primaryWithEmail, diagnostics };
  }

  try {
    const referrals = await search(domainOrName, REFERRAL_TITLES, 5);
    const withEmail = referrals.filter(isVerified);
    diagnostics.apollo_referral = `${referrals.length} referrals found`;
    return {
      tier: "engineer_referral",
      people: withEmail,
      diagnostics,
    };
  } catch (error) {
    diagnostics.apollo_referral = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    return { tier: "engineer_referral", people: [], diagnostics };
  }
}
