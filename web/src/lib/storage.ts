// Per-room identity persisted in localStorage so a refresh / reconnect rejoins
// silently. Tokens are secrets but live only in the user's own browser.

export interface Identity {
  code: string;
  playerToken: string;
  hostToken?: string;
}

const key = (code: string) => `tp:room:${code}`;

export function saveIdentity(id: Identity): void {
  try {
    localStorage.setItem(key(id.code), JSON.stringify(id));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function loadIdentity(code: string): Identity | null {
  try {
    const raw = localStorage.getItem(key(code));
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function clearIdentity(code: string): void {
  try {
    localStorage.removeItem(key(code));
  } catch {
    /* ignore */
  }
}
