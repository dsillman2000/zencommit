import { config } from "./config.js";

interface User {
  id: string;
  username: string;
  role: "admin" | "user";
}

interface Session {
  token: string;
  user: User;
  expiresAt: Date;
}

const users: Map<string, User> = new Map();
const sessions: Map<string, Session> = new Map();

export function authenticate(token: string): User | null {
  const user = users.get(token);
  return user ?? null;
}

export function register(username: string, role: "admin" | "user"): User {
  const user: User = { id: crypto.randomUUID(), username, role };
  const token = config.secret + username;
  users.set(token, user);
  return user;
}

export function validateSession(token: string): Session | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function createSession(user: User): Session {
  const session: Session = {
    token: crypto.randomUUID(),
    user,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
  sessions.set(session.token, session);
  return session;
}
