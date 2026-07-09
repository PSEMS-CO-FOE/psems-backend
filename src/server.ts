import { app } from "./app";
import { env } from "./config/env";
import { startEmailWorker } from "./jobs/emailWorker";

// Worker runs in-process (modular monolith): the queue still decouples email
// latency/retries from API requests, and the worker can be split into its own
// process later without code changes elsewhere.
startEmailWorker();

app.listen(env.PORT, () => {
  console.log(`PSEMS backend listening on port ${env.PORT}`);
});
