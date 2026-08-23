import { Role } from "@prisma/client";
import { runAccountScript } from "./privilegedAccount";

// No route mints a Super Admin, so this is the only way the first one exists.
void runAccountScript(Role.SUPER_ADMIN, "npm run superadmin:create -- <email> <password>");
