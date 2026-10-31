export const STATUSES = [
  "new",
  "drafted",
  "sent",
  "replied",
  "no_response",
  "rejected",
  "skipped",
] as const;

export type Status = (typeof STATUSES)[number];

const TRANSITIONS: Record<Status, readonly Status[]> = {
  new: ["drafted", "skipped", "rejected"],
  drafted: ["sent", "skipped", "rejected"],
  sent: ["replied", "no_response", "rejected"],
  replied: ["rejected"],
  no_response: ["drafted", "rejected"],
  skipped: ["rejected"],
  rejected: [],
};

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from].join(", ") || "none (final state)";
    throw new Error(
      `Invalid status change: ${from} -> ${to}. Allowed from '${from}': ${allowed}.`
    );
  }
}