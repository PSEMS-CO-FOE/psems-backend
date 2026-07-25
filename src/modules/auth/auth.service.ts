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
  const user = await prisma.user.findUnique({ where: { email }, include: { lecturer: true } });
  if (!user) {
    throw new AuthError(401, "Invalid email or password");
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw new AuthError(401, "Invalid email or password");
  }

  // Checked only AFTER password verification: reporting approval status on a
  // wrong password would let anyone probe whether an email has applied.
  if (user.lecturer && user.lecturer.approvalStatus !== "APPROVED") {
    const message =
      user.lecturer.approvalStatus === "PENDING"
        ? "Your registration is awaiting System Admin approval"
        : "Your registration was rejected — contact the System Admin";
    throw new AuthError(403, message);
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

export async function changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AuthError(401, "User no longer exists");
  }

  // The forced first-login change IS the mandatory reset — the user just proved
  // the current password by logging in seconds ago, so don't re-ask. Any later
  // voluntary change still requires it.
  if (!user.forcePasswordChange) {
    if (!currentPassword) {
      throw new AuthError(400, "Current password is required");
    }
    const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!passwordMatches) {
      throw new AuthError(401, "Current password is incorrect");
    }
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
