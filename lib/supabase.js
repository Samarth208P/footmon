import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn("Supabase URL or Anon Key is missing. Please check your .env.local file.");
}

export const supabase = createClient(
    supabaseUrl || 'https://example.supabase.co', 
    supabaseKey || 'dummy-key'
);
