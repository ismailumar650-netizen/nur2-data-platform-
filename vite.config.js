import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

function isSupabaseSecretKey(key = '') {
  if (key.startsWith('sb_secret_')) {
    return true
  }

  const payload = key.split('.')[1]
  if (!payload) {
    return false
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return claims.role === 'service_role'
  } catch {
    return false
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  if (isSupabaseSecretKey(env.VITE_SUPABASE_ANON_KEY)) {
    throw new Error(
      'VITE_SUPABASE_ANON_KEY contains a Supabase secret/service-role key. Use a publishable or anon key in browser code.',
    )
  }

  return {
    plugins: [react()],
  }
})
