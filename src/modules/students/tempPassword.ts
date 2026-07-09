import crypto from "crypto";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O — avoids 1/l/0/O confusion in emails
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SPECIAL = "!@#$%^&*+-=?";
const ALL = UPPER + LOWER + DIGITS + SPECIAL;

const TEMP_PASSWORD_LENGTH = 14; // spec 2.2 requires minimum 12

function pick(charset: string): string {
  return charset[crypto.randomInt(charset.length)];
}

// Cryptographically random temp password with each character class guaranteed
// (spec 2.2). Math.random() is predictable and must never generate credentials.
export function generateTempPassword(): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  while (chars.length < TEMP_PASSWORD_LENGTH) {
    chars.push(pick(ALL));
  }
  // Crypto-backed Fisher-Yates so the guaranteed class characters don't sit
  // at fixed positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
