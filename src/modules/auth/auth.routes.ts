import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { changePasswordSchema, loginSchema } from "./auth.schemas";
import * as authService from "./auth.service";
import { REFRESH_COOKIE_MAX_AGE_MS, REFRESH_COOKIE_NAME } from "./tokens";

export const authRouter = Router();

authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await authService.login(email, password);

    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });

    res.json({
      accessToken: result.accessToken,
      forcePasswordChange: result.forcePasswordChange,
      user: result.user,
    });
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.user!.user_id, currentPassword, newPassword);
    res.json({ message: "Password changed successfully" });
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const jti = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!jti) {
      return res.status(401).json({ error: "Missing refresh token" });
    }

    const result = await authService.refreshSession(jti);

    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });

    return res.json({ accessToken: result.accessToken });
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const jti = req.cookies?.[REFRESH_COOKIE_NAME];
    if (jti) {
      await authService.logout(jti);
    }
    res.clearCookie(REFRESH_COOKIE_NAME);
    res.json({ message: "Logged out" });
  } catch (err) {
    return next(err);
  }
});
