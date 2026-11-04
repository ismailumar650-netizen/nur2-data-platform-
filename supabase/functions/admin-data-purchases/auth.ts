import { bearerToken } from "../_shared/auth.ts";

type AuthenticatedUser = {
  id: string;
};

type AuthClient = {
  auth: {
    getUser(token: string): Promise<{
      data: { user: AuthenticatedUser | null };
      error: unknown;
    }>;
  };
};

type CreateAuthClient = (
  url: string,
  key: string,
  options: {
    auth: {
      autoRefreshToken: false;
      persistSession: false;
    };
  },
) => AuthClient;

export function createAuthenticatedAdminUser(
  createClient: CreateAuthClient,
  supabaseUrl: string | undefined,
  anonKey: string | undefined,
) {
  return async (request: Request): Promise<AuthenticatedUser | null> => {
    const token = bearerToken(request);
    if (!token) return null;

    if (!supabaseUrl || !anonKey) {
      throw new Error("Supabase authentication is not configured.");
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user;
  };
}
