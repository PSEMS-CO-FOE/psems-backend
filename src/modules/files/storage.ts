import fs from "fs/promises";
import path from "path";
import { env } from "../../config/env";

// Backend-agnostic file storage. `storagePath` is opaque (local path or Supabase
// object key) and is persisted on the Submission row. Local is the dev/test
// default; Supabase is selected by env for the pilot.
export interface StorageBackend {
  save(objectKey: string, buffer: Buffer, contentType: string): Promise<{ storagePath: string }>;
}

class LocalStorageBackend implements StorageBackend {
  async save(objectKey: string, buffer: Buffer): Promise<{ storagePath: string }> {
    const fullPath = path.join(env.STORAGE_DIR, objectKey);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    return { storagePath: objectKey };
  }
}

class SupabaseStorageBackend implements StorageBackend {
  // SDK lazy-imported so dev/test (local backend) never load it.
  async save(objectKey: string, buffer: Buffer, contentType: string): Promise<{ storagePath: string }> {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
      throw new Error("STORAGE_BACKEND=supabase requires SUPABASE_URL and SUPABASE_SERVICE_KEY");
    }
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const { error } = await client.storage
      .from(env.SUPABASE_BUCKET)
      .upload(objectKey, buffer, { contentType, upsert: true });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);
    return { storagePath: objectKey };
  }
}

export const storage: StorageBackend =
  env.STORAGE_BACKEND === "supabase" ? new SupabaseStorageBackend() : new LocalStorageBackend();
