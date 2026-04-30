import { createClient } from '@supabase/supabase-js';

export const getSupabaseAdmin = (env) => {
    return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY);
};

export const getSupabaseAuth = (env) => {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: {
            flowType: 'implicit'
        }
    });
};
