/**
 * Fleets: the groups a reader keeps machines in.
 *
 * One tailnet can carry two sets of machines that have nothing to do with each
 * other — the ones at work and the ones at home. A fleet is the line between
 * them, and the line is real rather than cosmetic: the repositories covey
 * offers for a new project, the machines a project pools over, and the
 * machines a run may place work on all stay inside one fleet. Without that,
 * one `gh` login lists the work repositories into the personal tree, and a run
 * started at work puts an agent on the machine in the living room.
 *
 * **The machine declares its own fleet.** It is `MachineSettings.fleet` on the
 * daemon, so the terminal, the page and the phone all group it the same way,
 * and a machine carries its fleet to whoever dials it. A client keeps the last
 * answer in `SavedMachine.fleet`, which is a cache and nothing more: it is
 * what holds an offline machine in its fleet instead of dropping it into the
 * default one until it answers.
 *
 * Every function here is pure, so each client reads one rule.
 */

/** The fleet a machine is in when it names none. Every covey starts here. */
export const DEFAULT_FLEET = "covey";

/** The longest a fleet name may be. A sidebar row is about this wide. */
export const MAX_FLEET_NAME = 24;

/**
 * The fleet of one machine: what it says it is in, else what it last said,
 * else the default.
 *
 * `reported` is `MachineSettings.fleet` and `saved` is `SavedMachine.fleet`.
 * The machine wins whenever it is connected, because the machine owns the
 * setting; the cache answers for a machine that is away.
 */
export function fleetOf(reported?: string | null, saved?: string | null): string {
  return cleanFleet(reported) ?? cleanFleet(saved) ?? DEFAULT_FLEET;
}

/** A name with its spaces trimmed, or null when nothing is left. */
export function cleanFleet(name?: string | null): string | null {
  const n = (name ?? "").trim();
  return n === "" ? null : n;
}

/**
 * What two names have to share to be one fleet: the name, case folded.
 *
 * A reader who types `Work` in one place and `work` in another means one
 * fleet, and two rows of one fleet is the fold nobody can close. The display
 * name keeps the case that was typed.
 */
export function fleetKey(name: string): string {
  return (cleanFleet(name) ?? DEFAULT_FLEET).toLowerCase();
}

/** True when a name is the default fleet, whatever its case. */
export function isDefaultFleet(name: string): boolean {
  return fleetKey(name) === DEFAULT_FLEET;
}

/**
 * Why a typed fleet name is refused, or null when it stands.
 *
 * The rules are short on purpose: a name is a label on a row, not a path and
 * not a key. It may hold no control character, because the sidebar paints it,
 * and no `:`, because a fold key joins a fleet to a section with one.
 */
export function fleetNameError(name: string): string | null {
  const n = cleanFleet(name);
  if (!n) return "a fleet needs a name";
  if (n.length > MAX_FLEET_NAME) return `a fleet name is at most ${MAX_FLEET_NAME} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return "a fleet name holds no control characters";
  if (n.includes(":")) return "a fleet name holds no colon";
  return null;
}

/**
 * The fleets in the order a sidebar paints them: the default fleet first,
 * then the rest by name.
 *
 * The default fleet leads because it is where every machine starts and where
 * most of the work is. The rest are sorted so the tree is in the same order on
 * every rebuild, whatever order the machines answered in.
 */
export function sortFleets(names: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const n of names) {
    const k = fleetKey(n);
    if (!seen.has(k)) seen.set(k, cleanFleet(n) ?? DEFAULT_FLEET);
  }
  return [...seen.values()].sort((a, b) => {
    const da = isDefaultFleet(a) ? 0 : 1;
    const db = isDefaultFleet(b) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
}

/**
 * What a project's fold key is scoped by, so one repository cloned in two
 * fleets is two rows.
 *
 * Empty for the default fleet, on purpose. A reader who has never made a
 * second fleet keeps every fold they ever made — the key of a project row is
 * written into the client's config, and a key that changed would unfurl the
 * whole tree the first time covey learned the word "fleet".
 */
export function fleetScope(fleet: string): string {
  return isDefaultFleet(fleet) ? "" : `${fleetKey(fleet)}/`;
}
