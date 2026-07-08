/**
 * Local player profiles — no server, no passwords.
 *
 * Signing in is just typing a name: it namespaces your saves under that
 * name in this browser's storage, so entering the same name later finds
 * them again. Skip it and you're a guest — a guest case is scratch paper.
 * The moment you truly leave (close the tab/browser) and come back without
 * signing in, that guest case is erased.
 *
 * "Leave and come back" is detected with sessionStorage: the browser keeps
 * it across reloads within the same tab but clears it when the tab/window
 * actually closes. So does the signed-in state itself — by design, signing
 * in is something you do fresh each session, not a persistent login.
 */

const ACTIVE_PROFILE_KEY = "living-detective:active-profile";
const SESSION_MARKER_KEY = "living-detective:session-marker";
export const GUEST_PROFILE = "guest";

// In-memory mirror for environments without sessionStorage (Node tests, or
// a browser that blocks storage entirely) — lives only as long as this
// module instance, matching real sessionStorage semantics closely enough.
let memoryProfile: string | null = null;
let memorySessionMarker: string | null = null;

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return key === ACTIVE_PROFILE_KEY ? memoryProfile : memorySessionMarker;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    if (key === ACTIVE_PROFILE_KEY) memoryProfile = value;
    else memorySessionMarker = value;
  }
}

function removeSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    if (key === ACTIVE_PROFILE_KEY) memoryProfile = null;
    else memorySessionMarker = null;
  }
}

/** Turn a display name into a safe, stable, lowercase storage key. */
export function slugifyProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export type SignInResult = { slug: string } | { error: string };

/** Validate a name and, if valid, make it the active profile for this session. */
export function signIn(name: string): SignInResult {
  const slug = slugifyProfileName(name);
  if (slug.length === 0) return { error: "Enter a name with at least one letter or number." };
  if (slug === GUEST_PROFILE) return { error: `"${name.trim()}" is reserved — please pick another name.` };
  writeSession(ACTIVE_PROFILE_KEY, slug);
  return { slug };
}

/** Stop being any named profile; subsequent play is a guest again. */
export function signOut(): void {
  removeSession(ACTIVE_PROFILE_KEY);
}

/** The signed-in profile slug for this session, or null if playing as guest. */
export function activeProfile(): string | null {
  return readSession(ACTIVE_PROFILE_KEY);
}

/** The storage namespace saves should use right now. */
export function currentProfileKey(): string {
  return activeProfile() ?? GUEST_PROFILE;
}

/**
 * Call once at boot, before the menu renders. If this is a fresh browser
 * session (the session marker is absent — meaning the tab/window was just
 * opened, not merely reloaded), any guest save left over from a previous
 * visit is now out of scope; `wipeGuestData` erases it and reports whether
 * it actually removed anything, which this function passes back so the UI
 * can mention it only when something real was cleared.
 */
export function reconcileSessionOnBoot(wipeGuestData: () => boolean): boolean {
  const freshSession = readSession(SESSION_MARKER_KEY) === null;
  writeSession(SESSION_MARKER_KEY, "1");
  return freshSession ? wipeGuestData() : false;
}
