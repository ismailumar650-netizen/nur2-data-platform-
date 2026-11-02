import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabaseConfigError = "";

if (!supabaseUrl) {
  supabaseConfigError = "VITE_SUPABASE_URL is missing.";
} else {
  try {
    const url = new URL(supabaseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      supabaseConfigError = "VITE_SUPABASE_URL must use HTTP or HTTPS.";
    }
  } catch {
    supabaseConfigError =
      "VITE_SUPABASE_URL must be the project's API URL, not an API key.";
  }
}

if (!supabaseConfigError && !supabaseKey) {
  supabaseConfigError = "VITE_SUPABASE_ANON_KEY is missing.";
}

export { supabaseConfigError };
export const supabase = supabaseConfigError
  ? null
  : createClient(supabaseUrl, supabaseKey);
