import bcrypt from "bcrypt";
import { prisma } from "../../config/database";
import {
  consumeRefreshToken,
  issueRefreshToken,
  revokeRefreshToken,
  signAccessToken,
} from "./tokens";

const BCRYPT_WORK_FACTOR = 12;

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AuthError(401, "Invalid email or password");
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw new AuthError(401, "Invalid email or password");
  }

  const accessToken = signAccessToken({ user_id: user.id, role: user.role, email: user.email });
  const refreshToken = await issueRefreshToken(user.id);

  return {
    accessToken,
    refreshToken,
    forcePasswordChange: user.forcePasswordChange,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AuthError(401, "User no longer exists");
  }

  const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordMatches) {
    throw new AuthError(401, "Current password is incorrect");
  }

  const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newPasswordHash, forcePasswordChange: false },
  });
}

export async function refreshSession(refreshTokenJti: string) {
  const userId = await consumeRefreshToken(refreshTokenJti);
  if (!userId) {
    throw new AuthError(401, "Invalid or expired refresh token");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AuthError(401, "User no longer exists");
  }

  const accessToken = signAccessToken({ user_id: user.id, role: user.role, email: user.email });
  const newRefreshToken = await issueRefreshToken(user.id);

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshTokenJti: string) {
  await revokeRefreshToken(refreshTokenJti);
}
