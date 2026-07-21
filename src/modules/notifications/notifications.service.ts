import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { enqueueNotificationEmail } from "../../jobs/emailQueue";

interface NotifyInput {
  type: string;
  title: string;
  body: string;
  courseInstanceId?: string;
  email?: boolean;
}

// Create an in-app notification and, if requested, enqueue an email. Best-effort
// on email: a queue failure must not break the triggering action.
export async function notify(recipientUserId: string, input: NotifyInput) {
  const notification = await prisma.notification.create({
    data: {
      recipientUserId,
      type: input.type,
      title: input.title,
      body: input.body,
      courseInstanceId: input.courseInstanceId,
    },
  });

  if (input.email) {
    const user = await prisma.user.findUnique({ where: { id: recipientUserId }, select: { email: true } });
    if (user) {
      await enqueueNotificationEmail(user.email, input.title, input.body).catch((err) =>
        console.error("[notify] email enqueue failed", err),
      );
    }
  }

  return notification;
}

export async function notifyMany(recipientUserIds: string[], input: NotifyInput) {
  await Promise.all([...new Set(recipientUserIds)].map((id) => notify(id, input)));
}

export function listMyNotifications(userId: string) {
  return prisma.notification.findMany({
    where: { recipientUserId: userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function markRead(userId: string, notificationId: string) {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification || notification.recipientUserId !== userId) {
    throw new AuthError(404, "Notification not found");
  }
  return prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
}
