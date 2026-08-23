import { Role } from "@prisma/client";
import { runAccountScript } from "./privilegedAccount";

// No route creates the first System Admin, and every other account flow needs one.
void runAccountScript(Role.SYSTEM_ADMIN, "npm run admin:create -- <email> <password>");
